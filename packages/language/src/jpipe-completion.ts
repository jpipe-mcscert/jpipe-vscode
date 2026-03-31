/**
 * Completion provider for the jPipe language
 *
 * Reference completion is mostly scoped like {@link JpipeScopeProvider} for `supports`.
 * **`implements`** also includes templates from the Langium workspace index (other `.jd` files);
 * choosing one from another file can add a `load` via {@link createReferenceCompletionItem}.
 *
 * Template implementation assistance: inside a justification that implements a template, adds
 * snippet completions for missing template elements (@support and regular), sorted with required first.
 */

import { stream, type Stream, URI, AstUtils, GrammarAST } from 'langium';
import type { AstNode, AstNodeDescription, ReferenceInfo, LangiumDocument } from 'langium';
import {
    DefaultCompletionProvider,
    type CompletionAcceptor,
    type CompletionContext,
    type CompletionProviderOptions,
    type CompletionValueItem,
    type NextFeature
} from 'langium/lsp';
import { Position, type TextEdit, CompletionItem, CompletionItemKind, CompletionList, CompletionParams } from 'vscode-languageserver';
import * as path from 'node:path';
import type { JpipeServices } from './jpipe-module.js';
import { 
    isJustification, 
    isTemplate, 
    isRelation, 
    isJustificationBody,
    isEvidence,
    isStrategy,
    isConclusion,
    isSubConclusion,
    isAbstractSupport,
    JustificationElement as JustificationElementRule,
    Template as TemplateRule,
    type Unit,
    type Justification,
    type Template,
    type JustificationElement,
    type AbstractSupport,
    type Relation
} from './generated/ast.js';
import { getAllElements, getLocalElements } from './jpipe-utils.js';

export class JpipeCompletionProvider extends DefaultCompletionProvider {
    private readonly services: JpipeServices;

    /** So VS Code requests completion when `@` is typed (e.g. for `@support`). */
    override readonly completionOptions: CompletionProviderOptions = {
        triggerCharacters: ['@']
    };

    public constructor(services: JpipeServices) {
        super(services);
        this.services = services;
    }

    private get importService() {
        return this.services.references.JpipeImportService;
    }

    /**
     * One completion per element name: getAllElements merges local + parent chain, so the same name
     * can appear as e.g. @support in a parent and evidence in the child — linking uses the local one.
     */
    private dedupeDescriptionsByName(descriptions: AstNodeDescription[]): AstNodeDescription[] {
        const seen = new Set<string>();
        const out: AstNodeDescription[] = [];
        for (const d of descriptions) {
            if (seen.has(d.name)) {
                continue;
            }
            seen.add(d.name);
            out.push(d);
        }
        return out;
    }

    protected override filterKeyword(context: CompletionContext, keyword: { value: string }): boolean {
        // Langium's Keyword is an internal grammar AST type; we only need `.value` here.
        if (!super.filterKeyword(context, keyword as Parameters<DefaultCompletionProvider['filterKeyword']>[1])) {
            return false;
        }
        if (keyword.value !== 'is') {
            return true;
        }
        const prefix = context.textDocument.getText({
            start: Position.create(context.position.line, 0),
            end: context.position
        });
        if (AstUtils.getContainerOfType(context.node, isRelation)) {
            return false;
        }
        if (/\bsupports\b/.test(prefix)) {
            return false;
        }
        // Only after the element name is finished and the cursor has moved past it (whitespace
        // before `is`). Otherwise `sub-conclusion Su` matches [\w_]+ and we wrongly offer `is`
        // while the user is still typing the name (e.g. Su1).
        const afterElementNameReadyForIs =
            /(?:evidence|strategy|conclusion|sub-conclusion|@support)\s+[\w_]+\s+$/i.test(prefix);
        return afterElementNameReadyForIs;
    }

    /**
     * Line text from column 0 to the cursor. Used to detect `@…` typing.
     */
    private linePrefixToCursor(context: CompletionContext): string {
        return context.textDocument.getText({
            start: Position.create(context.position.line, 0),
            end: context.position
        });
    }

    /** User is typing an at-keyword (`@`, `@su`, …). */
    private lineEndsWithAtKeywordPrefix(context: CompletionContext): boolean {
        return /@\w*$/.test(this.linePrefixToCursor(context));
    }

    /**
     * When the identifier slice is empty, Langium's fuzzy matcher matches every keyword, so you get
     * the full grammar list. After `@`, only `@…` keywords (e.g. `@support`) are valid.
     */
    protected override completionFor(
        context: CompletionContext,
        next: NextFeature,
        acceptor: CompletionAcceptor
    ): void {
        if (this.lineEndsWithAtKeywordPrefix(context)) {
            if (GrammarAST.isCrossReference(next.feature)) {
                return;
            }
            if (GrammarAST.isKeyword(next.feature) && !next.feature.value.startsWith('@')) {
                return;
            }
        }
        super.completionFor(context, next, acceptor);
    }

    protected override buildCompletionTextEdit(context: CompletionContext, label: string, newText: string): TextEdit | undefined {
        const content = context.textDocument.getText();
        const identifier = content.substring(context.tokenOffset, context.offset);

        if (this.lineEndsWithAtKeywordPrefix(context) && !label.startsWith('@')) {
            return undefined;
        }

        // Make keyword completion work for "@support" when the user has only typed "@"
        // (Langium's default fuzzy matcher doesn't reliably match this case).
        if (label.startsWith('@') && identifier.startsWith('@')) {
            const identTail = identifier.slice(1);
            const labelTail = label.slice(1);
            if (identTail.length === 0 || this.services.shared.lsp.FuzzyMatcher.match(identTail, labelTail)) {
                const start = context.textDocument.positionAt(context.tokenOffset);
                const end = context.position;
                return { newText, range: { start, end } };
            }
            return undefined;
        }

        return super.buildCompletionTextEdit(context, label, newText);
    }

    protected override getReferenceCandidates(refInfo: ReferenceInfo, context: CompletionContext): Stream<AstNodeDescription> {
        const doc = context.document;
        const unit = doc.parseResult.value as Unit | undefined;
        if (!unit) {
            return super.getReferenceCandidates(refInfo, context);
        }

        const descFor = (node: { name: string }): AstNodeDescription | undefined => {
            try {
                return this.services.workspace.AstNodeDescriptionProvider.createDescription(node as any, node.name);
            } catch {
                return undefined;
            }
        };

        const relation = AstUtils.getContainerOfType(refInfo.container, isRelation);
        if (relation && (refInfo.property === 'from' || refInfo.property === 'to')) {
            return this.referenceCandidatesForRelation(relation, unit, doc, descFor);
        }

        const parentOwner =
            refInfo.property === 'parent'
                ? AstUtils.getContainerOfType(refInfo.container, isJustification) ??
                  AstUtils.getContainerOfType(refInfo.container, isTemplate)
                : undefined;
        if (parentOwner && (isJustification(parentOwner) || isTemplate(parentOwner))) {
            return stream(this.parentTemplateCandidateDescriptions(unit, doc, descFor));
        }

        // jPipe only references JustificationElement (supports) and Template (implements). Never fall
        // through to DefaultScopeProvider's global workspace index — that lists every element in the repo.
        const refType = this.services.shared.AstReflection.getReferenceType(refInfo);
        if (refType === JustificationElementRule.$type || refType === TemplateRule.$type) {
            return stream();
        }

        return super.getReferenceCandidates(refInfo, context);
    }

    /** Templates for `implements`: local + `load`ed first, then workspace index (dedupe by name). */
    private parentTemplateCandidateDescriptions(
        unit: Unit,
        doc: LangiumDocument,
        descFor: (node: { name: string }) => AstNodeDescription | undefined
    ): AstNodeDescription[] {
        const localTemplates = unit.body.filter((b): b is Template => isTemplate(b));
        const importedTemplates = this.importService.getImportedTemplates(unit, doc);
        const seen = new Set<string>();
        const out: AstNodeDescription[] = [];
        const push = (d: AstNodeDescription | undefined) => {
            if (!d || seen.has(d.name)) return;
            seen.add(d.name);
            out.push(d);
        };
        for (const t of localTemplates) {
            push(descFor(t));
        }
        for (const t of importedTemplates) {
            push(descFor(t));
        }
        for (const d of this.services.shared.workspace.IndexManager.allElements(TemplateRule.$type).toArray()) {
            push(d);
        }
        return out;
    }

    private referenceCandidatesForRelation(
        relation: Relation,
        unit: Unit,
        doc: LangiumDocument,
        descFor: (node: { name: string }) => AstNodeDescription | undefined
    ): Stream<AstNodeDescription> {
        const justification = AstUtils.getContainerOfType(relation, isJustification);
        if (justification) {
            const local = getAllElements(justification);
            const imported = [
                ...this.importService.getImportedElements(unit, doc),
                ...this.importService.getImportedTemplateElements(unit, doc)
            ];
            const merged = [...local, ...imported];
            const descriptions = this.dedupeDescriptionsByName(
                merged.map(descFor).filter((d): d is AstNodeDescription => d !== undefined)
            );
            return stream(descriptions);
        }
        const template = AstUtils.getContainerOfType(relation, isTemplate);
        if (template) {
            const local = getAllElements(template);
            const imported = this.importService.getImportedTemplateElements(unit, doc);
            const merged = [...local, ...imported];
            const descriptions = this.dedupeDescriptionsByName(
                merged.map(descFor).filter((d): d is AstNodeDescription => d !== undefined)
            );
            return stream(descriptions);
        }
        return stream();
    }

    private getRelativePath(sourcePath: string, targetPath: string): string {
        const relative = path.relative(path.dirname(sourcePath), targetPath).replace(/\\/g, '/');
        return relative.startsWith('../') ? relative : `./${relative}`;
    }

    private normalizePathForComparison(filePath: string): string {
        return filePath
            .replace(/^["']|["']$/g, '')  // remove quotes
            .replace(/^\.\//, '')         // remove leading ./
            .replace(/\\/g, '/');         // make slashes work
    }

    /** File basename for the document that defines the described symbol (for suggest widget detail). */
    private basenameFromDescription(desc: AstNodeDescription): string | undefined {
        const uri = desc.documentUri;
        if (!uri) return undefined;
        const s = typeof uri === 'string' ? uri : uri.toString();
        const p = URI.parse(s).path;
        const base = path.basename(p);
        return base || undefined;
    }

    private basenameFromAstNode(node: AstNode): string | undefined {
        const doc = (node as { $document?: LangiumDocument }).$document;
        const uri = doc?.uri;
        if (!uri) return undefined;
        const p = URI.parse(uri.toString()).path;
        const base = path.basename(p);
        return base || undefined;
    }

    protected override createReferenceCompletionItem(
        nodeDescription: AstNodeDescription,
        refInfo: ReferenceInfo,
        context: CompletionContext
    ): CompletionValueItem {
        const baseItem = super.createReferenceCompletionItem(nodeDescription, refInfo, context);
        const file = this.basenameFromDescription(nodeDescription);
        // labelDetails.detail is drawn on the same row as the label (visible when hovering a row);
        // CompletionItem.detail is often only emphasized for the keyboard-focused item.
        const withFile: CompletionValueItem = {
            ...baseItem,
            // Keep `detail` stable; use `labelDetails` for always-visible inline metadata.
            detail: baseItem.detail ?? nodeDescription.type,
            labelDetails: {
                ...(baseItem.labelDetails ?? {}),
                ...(file ? { detail: ` · ${file}` } : {}),
                // Show what kind of thing this is (Evidence/Strategy/Conclusion/SubConclusion/AbstractSupport/Template)
                description: ` · ${nodeDescription.type}`
            }
        };

        const elementInfo = this.findElementInfo(context.document, nodeDescription);
        if (!elementInfo) {
            return withFile;
        }

        if (!elementInfo.isImported && elementInfo.sourceFile) {
            return {
                ...withFile,
                additionalTextEdits: this.createLoadEdit(context.document, elementInfo.sourceFile)
            };
        }

        return withFile;
    }

    public override async getCompletion(
        document: LangiumDocument,
        params: CompletionParams,
        cancelToken?: any
    ): Promise<CompletionList | undefined> {
        const result = await super.getCompletion(document, params, cancelToken);

        if (!result || cancelToken?.isCancellationRequested) {
            return result;
        }

        let items = [...result.items];

        const pos = params.position;
        const linePfx = document.textDocument.getText({
            start: Position.create(pos.line, 0),
            end: pos
        });
        // Incomplete parse can omit template body CST ranges; still filter whenever the line ends with `@…`.
        if (/@\w*$/.test(linePfx)) {
            items = items.filter(i => {
                const lab = typeof i.label === 'string' ? i.label : '';
                return lab.startsWith('@');
            });
        }

        const atSupportItem = this.tryAtSupportKeywordCompletion(document, params.position);
        if (atSupportItem && !items.some(i => i.label === '@support')) {
            items.unshift(atSupportItem);
        }

        const contexts = Array.from(this.buildContexts(document, params.position));
        if (contexts.length > 0) {
            const templateCompletions = this.getTemplateElementCompletions(contexts[0]);
            if (templateCompletions.length > 0) {
                items = [...templateCompletions, ...items];
            }
        }

        items = this.deduplicateItems(items);
        return { ...result, items };
    }

    /** True if offset lies inside a `template … { … }` region (use whole template CST — body CST may be missing when `@` is alone). */
    private offsetInsideSomeTemplateBody(document: LangiumDocument, offset: number): boolean {
        const unit = document.parseResult.value as Unit | undefined;
        if (!unit?.body) {
            return false;
        }
        for (const item of unit.body) {
            if (!isTemplate(item)) {
                continue;
            }
            const cst = item.$cstNode;
            if (cst && offset > cst.offset && offset < cst.end) {
                return true;
            }
        }
        return false;
    }

    /**
     * Langium often omits `@support` when only `@` is typed (parser/CST mismatch). Inject the
     * keyword explicitly inside template bodies when the line ends with a partial `@…` token.
     */
    private tryAtSupportKeywordCompletion(document: LangiumDocument, position: Position): CompletionItem | undefined {
        const offset = document.textDocument.offsetAt(position);
        if (!this.offsetInsideSomeTemplateBody(document, offset)) {
            return undefined;
        }

        const linePrefix = document.textDocument.getText({
            start: Position.create(position.line, 0),
            end: position
        });
        const m = linePrefix.match(/@\w*$/);
        if (!m) {
            return undefined;
        }

        const atCol = position.character - m[0].length;
        const range = {
            start: { line: position.line, character: atCol },
            end: position
        };

        return {
            label: '@support',
            kind: CompletionItemKind.Keyword,
            detail: 'Keyword',
            sortText: '0_@support',
            filterText: '@support',
            preselect: true,
            textEdit: { range, newText: '@support ' }
        };
    }

    private getTemplateElementCompletions(context: CompletionContext): CompletionItem[] {
        const completions: CompletionItem[] = [];
        
        try {
            const currentNode = context.node;
            if (!currentNode) {
                return completions;
            }

            const justificationBody = AstUtils.getContainerOfType(currentNode, isJustificationBody);
            if (!justificationBody) return completions;

            const justification = justificationBody.$container as Justification | undefined;
            if (!justification || !isJustification(justification)) return completions;

            const template = justification.parent?.ref;
            if (!template) return completions;

            const allTemplateElements = getAllElements(template);
            const existingElements = getLocalElements(justification);
            const existingElementNames = new Set(existingElements.map(el => el.name));
            const suggestedNames = new Set<string>();

            for (const element of allTemplateElements) {
                if (existingElementNames.has(element.name) || suggestedNames.has(element.name)) {
                    continue;
                }
                const completion = this.createTemplateElementCompletion(element, context);
                if (completion) {
                    suggestedNames.add(element.name);
                    completions.push(completion);
                }
            }
        } catch (error) {
            // TODO: Make this better by logging errors for debugging instead of silently failing
        }

        return completions;
    }

    private createTemplateElementCompletion(
        element: JustificationElement | AbstractSupport,
        context: CompletionContext
    ): CompletionItem | undefined {
        let keyword: string;
        let snippet: string;

        // Handle @support elements (AbstractSupport)
        // @support elements can be refined by evidence or sub-conclusion
        // suggest evidence as the default, but user can change to sub-conclusion
        if (isAbstractSupport(element)) {
            const supportElement = element as AbstractSupport;
            // Default to evidence, but user can change to sub-conclusion
            keyword = 'evidence';
            snippet = `evidence ${supportElement.name} is "${supportElement.label}"`;
        } else if (isEvidence(element)) {
            keyword = 'evidence';
            snippet = `evidence ${element.name} is "${element.label}"`;
        } else if (isStrategy(element)) {
            keyword = 'strategy';
            snippet = `strategy ${element.name} is "${element.label}"`;
        } else if (isConclusion(element)) {
            keyword = 'conclusion';
            snippet = `conclusion ${element.name} is "${element.label}"`;
        } else if (isSubConclusion(element)) {
            keyword = 'sub-conclusion';
            snippet = `sub-conclusion ${element.name} is "${element.label}"`;
        } else {
            return undefined;
        }

        const isRequired = isAbstractSupport(element);
        const defFile = this.basenameFromAstNode(element);
        const detail = isRequired
            ? `Required @support from template: ${element.name} is "${element.label}"`
            : `From template: ${element.name} is "${element.label}"`;

        const position = context.position;
        const document = context.document;
        const text = document.textDocument.getText();
        const lines = text.split('\n');
        const line = lines[position.line] || '';
        
        let startCol = position.character;
        while (startCol > 0 && /[\w_]/.test(line[startCol - 1])) {
            startCol--;
        }
        
        let endCol = position.character;
        while (endCol < line.length && /[\w_]/.test(line[endCol])) {
            endCol++;
        }
        const textEdit: TextEdit = {
            range: {
                start: { line: position.line, character: startCol },
                end: { line: position.line, character: endCol }
            },
            newText: snippet + '\n'
        };

        return {
            label: `${keyword} ${element.name}`,
            kind: CompletionItemKind.Property,
            detail,
            labelDetails: {
                ...(defFile ? { detail: ` · ${defFile}` } : {}),
                // Mirror reference rows: show the element kind inline too
                description: ` · ${element.$type}`
            },
            insertText: snippet,
            textEdit: textEdit,
            sortText: isRequired ? `0_${keyword}_${element.name}` : `1_${keyword}_${element.name}`, // Sort required @support elements first
            documentation: isRequired
                ? `Required @support element from template${defFile ? ` (${defFile})` : ''}. Inserts: ${snippet}`
                : `Element from template${defFile ? ` (${defFile})` : ''}. Inserts: ${snippet}`
        };
    }

    private findElementInfo(currentDoc: LangiumDocument, nodeDescription: AstNodeDescription): { sourceFile: string; isImported: boolean } | undefined {
        const documentUri = nodeDescription.documentUri;
        if (!documentUri) return undefined;

        const currentUnit = currentDoc.parseResult.value as Unit | undefined;
        if (!currentUnit) return undefined;

        const currentUri = typeof currentDoc.uri === 'string' ? currentDoc.uri : currentDoc.uri.toString();
        const targetUri = typeof documentUri === 'string' ? documentUri : documentUri.toString();
        
        // if the element is from the current file, don't add a load statement
        // normalize URIs for comparison
        const currentPath = URI.parse(currentUri).path;
        const targetPath = URI.parse(targetUri).path;
        
        if (currentPath === targetPath) {
            return undefined;
        }
        
        const relativePath = this.getRelativePath(currentPath, targetPath);

        const normalizedRelativePath = this.normalizePathForComparison(relativePath);
        const isImported = currentUnit.imports.some(load => 
            this.normalizePathForComparison(load.filePath) === normalizedRelativePath
        );

        return { sourceFile: relativePath, isImported };
    }

    private createLoadEdit(document: LangiumDocument, relativePath: string): TextEdit[] | undefined {
        const currentUnit = document.parseResult.value as Unit | undefined;
        if (!currentUnit) return undefined;

        // Check if this path is already imported using normalized comparison
        const normalizedRelativePath = this.normalizePathForComparison(relativePath);
        const alreadyImported = currentUnit.imports.some(load => 
            this.normalizePathForComparison(load.filePath) === normalizedRelativePath
        );
        
        if (alreadyImported) {
            return undefined;
        }

        const text = document.textDocument.getText();
        const lines = text.split('\n');
        let insertLine = 0;
        let lastLoadLine = -1;
        let hasExistingLoads = false;
        
        // Find the last load statement, or determine where to insert at the top
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed.startsWith('load ')) {
                hasExistingLoads = true;
                lastLoadLine = i;
                insertLine = i + 1;
            } else if (trimmed && !trimmed.startsWith('//') && lastLoadLine >= 0) {
                // Found non-comment, non-load line after load statements - insert after last load
                break;
            } else if (trimmed && !trimmed.startsWith('//') && lastLoadLine < 0) {
                // Found first non-comment, non-load line - insert before it
                insertLine = i;
                break;
            }
        }
        
        // If we never found a place to insert, insert at the top
        if (insertLine === 0 && lastLoadLine < 0) {
            insertLine = 0;
        }

        // Build the final path - keep relative paths as-is, add ./ prefix for same-directory files
        const finalPath = relativePath.startsWith('../') 
            ? relativePath 
            : `./${normalizedRelativePath}`;
        
        // Only add extra newline if this is the first load statement
        const newlineSuffix = hasExistingLoads ? '\n' : '\n\n';
        
        return [{
            range: { start: Position.create(insertLine, 0), end: Position.create(insertLine, 0) },
            newText: `load "${finalPath}"${newlineSuffix}`
        }];
    }
}

