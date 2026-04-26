import { stream, type Stream, URI, AstUtils, GrammarAST, type AstNode, type AstNodeDescription, type ReferenceInfo, type LangiumDocument } from 'langium';
import {
    DefaultCompletionProvider,
    type CompletionAcceptor,
    type CompletionContext,
    type CompletionProviderOptions,
    type CompletionValueItem,
    type NextFeature
} from 'langium/lsp';
import { Position, type TextEdit, CompletionItem, CompletionItemKind, CompletionList, CompletionParams } from 'vscode-languageserver';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JpipeServices } from './jpipe-module.js';
import type { JpipeServerLogger } from './jpipe-logger.js';
import {
    isJustification,
    isTemplate,
    isJustificationBody,
    isEvidence,
    isStrategy,
    isConclusion,
    isSubConclusion,
    isAbstractSupport,
    Justification as JustificationRule,
    Template as TemplateRule,
    type Unit,
    type Justification,
    type Relation,
    type Template,
    type JustificationElement,
    type AbstractSupport,
    type QualifiedId
} from './generated/ast.js';
import { getAllElements, getLocalElements, getRelationCandidates, qualifiedIdText } from './jpipe-utils.js';

export class JpipeCompletionProvider extends DefaultCompletionProvider {
    private readonly services: JpipeServices;
    private readonly logger: JpipeServerLogger;

    /** So VS Code requests completion when `@` is typed (e.g. for `@support`). */
    override readonly completionOptions: CompletionProviderOptions = {
        triggerCharacters: ['@']
    };

    public constructor(services: JpipeServices) {
        super(services);
        this.services = services;
        this.logger = services.logger;
    }

    private get importService() {
        return this.services.references.JpipeImportService;
    }

    protected override filterKeyword(context: CompletionContext, keyword: { value: string }): boolean {
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
        if (/\bsupports\b/.test(prefix)) {
            return false;
        }
        // Allow qualified IDs (e.g. "evidence t:abs ") before `is`
        const afterElementNameReadyForIs =
            /(?:evidence|strategy|conclusion|sub-conclusion|@support)\s+\w+(:\w+)?\s+$/i.test(prefix);
        return afterElementNameReadyForIs;
    }

    private linePrefixToCursor(context: CompletionContext): string {
        return context.textDocument.getText({
            start: Position.create(context.position.line, 0),
            end: context.position
        });
    }

    private lineEndsWithAtKeywordPrefix(context: CompletionContext): boolean {
        return /@\w*$/.test(this.linePrefixToCursor(context));
    }

    protected override completionFor(
        context: CompletionContext,
        next: NextFeature,
        acceptor: CompletionAcceptor
    ): void {
        if (this.lineEndsWithAtKeywordPrefix(context)) {
            if (GrammarAST.isCrossReference(next.feature)) return;
            if (GrammarAST.isKeyword(next.feature) && !next.feature.value.startsWith('@')) return;
        }
        super.completionFor(context, next, acceptor);
    }

    protected override buildCompletionTextEdit(context: CompletionContext, label: string, newText: string): TextEdit | undefined {
        const content = context.textDocument.getText();
        const identifier = content.substring(context.tokenOffset, context.offset);

        if (this.lineEndsWithAtKeywordPrefix(context) && !label.startsWith('@')) {
            return undefined;
        }

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

        const descFor = (node: { id: string | QualifiedId }): AstNodeDescription | undefined => {
            try {
                const key = typeof node.id === 'string' ? node.id : qualifiedIdText(node.id);
                return this.services.workspace.AstNodeDescriptionProvider.createDescription(node as any, key);
            } catch {
                return undefined;
            }
        };

        if (refInfo.property === 'parent') {
            const parentOwner =
                AstUtils.getContainerOfType(refInfo.container, isJustification) ??
                AstUtils.getContainerOfType(refInfo.container, isTemplate);
            if (parentOwner) {
                return stream(this.parentTemplateCandidateDescriptions(unit, doc, descFor));
            }
        }

        if (refInfo.property === 'from' || refInfo.property === 'to') {
            const owner =
                AstUtils.getContainerOfType(refInfo.container, isJustification) ??
                AstUtils.getContainerOfType(refInfo.container, isTemplate);
            if (owner) {
                const relation = refInfo.container as Relation;
                let candidates = getRelationCandidates(owner);
                if (refInfo.property === 'to' && relation.from?.ref) {
                    candidates = this.filterRelationTargets(relation.from.ref, candidates);
                } else if (refInfo.property === 'from' && relation.to?.ref) {
                    candidates = this.filterRelationSources(relation.to.ref, candidates);
                }
                return stream(candidates.flatMap(e => {
                    const d = descFor(e);
                    return d ? [d] : [];
                }));
            }
        }

        // Never fall through to the workspace index for jPipe cross-refs.
        return stream();
    }

    private filterRelationTargets(from: JustificationElement, candidates: JustificationElement[]): JustificationElement[] {
        if (isEvidence(from) || isAbstractSupport(from) || isSubConclusion(from)) {
            return candidates.filter(e => isStrategy(e));
        }
        if (isStrategy(from)) {
            return candidates.filter(e => isSubConclusion(e) || isConclusion(e));
        }
        return candidates;
    }

    private filterRelationSources(to: JustificationElement, candidates: JustificationElement[]): JustificationElement[] {
        if (isStrategy(to)) {
            return candidates.filter(e => isEvidence(e) || isAbstractSupport(e) || isSubConclusion(e));
        }
        if (isSubConclusion(to) || isConclusion(to)) {
            return candidates.filter(e => isStrategy(e));
        }
        return candidates;
    }

    /** Templates for `implements`: local + `load`ed first, then workspace index (dedupe by name). */
    private parentTemplateCandidateDescriptions(
        unit: Unit,
        doc: LangiumDocument,
        descFor: (node: { id: string | QualifiedId }) => AstNodeDescription | undefined
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
        for (const t of localTemplates) push(descFor(t));
        for (const t of importedTemplates) push(descFor(t));
        for (const d of this.services.shared.workspace.IndexManager.allElements(TemplateRule.$type).toArray()) {
            push(d);
        }
        return out;
    }

    private getRelativePath(sourcePath: string, targetPath: string): string {
        const relative = path.relative(path.dirname(sourcePath), targetPath).replaceAll('\\', '/');
        return relative.startsWith('../') ? relative : `./${relative}`;
    }

    private normalizePathForComparison(filePath: string): string {
        return filePath
            .replaceAll(/^["']|["']$/g, '')
            .replaceAll(/^\.\//g, '')
            .replaceAll('\\', '/');
    }

    private basenameFromDescription(desc: AstNodeDescription): string | undefined {
        const uri = desc.documentUri;
        if (!uri) return undefined;
        const s = typeof uri === 'string' ? uri : uri.toString();
        const p = URI.parse(s).path;
        return path.basename(p) || undefined;
    }

    private basenameFromAstNode(node: AstNode): string | undefined {
        const doc = (node as { $document?: LangiumDocument }).$document;
        const uri = doc?.uri;
        if (!uri) return undefined;
        const p = URI.parse(uri.toString()).path;
        return path.basename(p) || undefined;
    }

    private nodeLabelFromDescription(desc: AstNodeDescription): string | undefined {
        const n = desc.node as { name?: unknown } | undefined;
        if (!n) return undefined;
        const raw = typeof n.name === 'string' ? n.name : undefined;
        if (!raw) return undefined;
        return raw.length > 40 ? `"${raw.slice(0, 37)}…"` : `"${raw}"`;
    }

    protected override createReferenceCompletionItem(
        nodeDescription: AstNodeDescription,
        refInfo: ReferenceInfo,
        context: CompletionContext
    ): CompletionValueItem {
        const baseItem = super.createReferenceCompletionItem(nodeDescription, refInfo, context);
        const nodeLabel = this.nodeLabelFromDescription(nodeDescription);
        const elementInfo = this.findElementInfo(context.document, nodeDescription);
        const file = elementInfo ? this.basenameFromDescription(nodeDescription) : undefined;

        const withLabel: CompletionValueItem = {
            ...baseItem,
            detail: baseItem.detail ?? nodeDescription.type,
            labelDetails: {
                ...baseItem.labelDetails,
                ...(nodeLabel ? { detail: ` · ${nodeLabel}` } : {}),
                ...(file ? { description: ` · ${file}` } : { description: ` · ${nodeDescription.type}` })
            }
        };

        if (elementInfo && !elementInfo.isImported && elementInfo.sourceFile) {
            return {
                ...withLabel,
                additionalTextEdits: this.createLoadEdit(context.document, elementInfo.sourceFile)
            };
        }

        return withLabel;
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

        const loadPathItems = await this.getLoadPathCompletions(document, params);
        if (loadPathItems.length > 0) {
            return { ...result, items: loadPathItems };
        }

        const operatorMatch = /(?:justification|template)\s+\w+\s+is\s+([\w:]*)$/.exec(linePfx);
        if (operatorMatch) {
            const operatorItems = this.getOperatorCompletions(document, operatorMatch[1]);
            if (operatorItems.length > 0) {
                items = [...operatorItems, ...items.filter(i => !operatorItems.some(o => o.label === i.label))];
            }
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

    private getOperatorCompletions(document: LangiumDocument, partial: string): CompletionItem[] {
        const unit = document.parseResult.value as Unit | undefined;
        const seen = new Set<string>();
        const out: CompletionItem[] = [];

        const push = (name: string, kind: 'justification' | 'template') => {
            if (seen.has(name)) return;
            if (partial && !this.services.shared.lsp.FuzzyMatcher.match(partial, name)) return;
            seen.add(name);
            out.push({
                label: name,
                kind: CompletionItemKind.Function,
                detail: kind,
                sortText: `0_op_${name}`
            });
        };

        if (unit) {
            for (const body of unit.body) {
                if (isJustification(body)) push(body.id, 'justification');
                else if (isTemplate(body)) push(body.id, 'template');
            }
        }

        // Only hit the workspace index when the user has typed a prefix — avoids a full
        // O(N) scan on the very first keystroke right after `is `.
        if (partial.length > 0) {
            for (const d of this.services.shared.workspace.IndexManager.allElements(JustificationRule.$type)) {
                push(d.name, 'justification');
            }
            for (const d of this.services.shared.workspace.IndexManager.allElements(TemplateRule.$type)) {
                push(d.name, 'template');
            }
        }

        return out;
    }

    private async getLoadPathCompletions(document: LangiumDocument, params: CompletionParams): Promise<CompletionItem[]> {
        const pos = params.position;
        const linePfx = document.textDocument.getText({
            start: Position.create(pos.line, 0),
            end: pos
        });

        const m = /^\s*load\s+["']([^"']*)$/.exec(linePfx);
        if (!m) return [];

        const partial = m[1];
        const pathStartCol = linePfx.search(/["']/) + 1;
        const docPath = URI.parse(document.uri.toString()).path;
        const docDir = path.dirname(docPath);
        const makeTextEdit = (p: string) => ({
            range: { start: { line: pos.line, character: pathStartCol }, end: pos },
            newText: p
        });

        const currentUnit = document.parseResult.value as Unit | undefined;
        const alreadyLoaded = new Set(currentUnit?.imports.map(l => {
            const p = this.normalizePathForComparison(l.path);
            return p.startsWith('../') ? p : `./${p}`;
        }) ?? []);

        const workspaceItems = this.collectIndexedJdItems(docPath, docDir, partial, alreadyLoaded, makeTextEdit);
        const seenLabels = new Set(workspaceItems.map(i => i.label));
        const dirItems = await this.collectDirectoryJdItems(docDir, partial, alreadyLoaded, seenLabels, makeTextEdit);

        return [...workspaceItems, ...dirItems];
    }

    private collectIndexedJdItems(
        docPath: string,
        docDir: string,
        partial: string,
        alreadyLoaded: Set<string>,
        makeTextEdit: (p: string) => { range: { start: Position; end: Position }; newText: string }
    ): CompletionItem[] {
        const seen = new Set<string>();
        const items: CompletionItem[] = [];
        for (const type of [JustificationRule.$type, TemplateRule.$type]) {
            for (const desc of this.services.shared.workspace.IndexManager.allElements(type)) {
                const targetUri = desc.documentUri?.toString();
                if (!targetUri || seen.has(targetUri)) continue;
                seen.add(targetUri);
                const targetPath = URI.parse(targetUri).path;
                if (targetPath === docPath || !targetPath.endsWith('.jd')) continue;
                const rel = path.relative(docDir, targetPath).replaceAll('\\', '/');
                const insertPath = rel.startsWith('../') ? rel : `./${rel}`;
                if (alreadyLoaded.has(insertPath)) continue;
                if (partial && !insertPath.includes(partial)) continue;
                items.push({
                    label: insertPath,
                    kind: CompletionItemKind.File,
                    detail: '.jd file',
                    sortText: `1_ws_${insertPath}`,
                    textEdit: makeTextEdit(insertPath)
                });
            }
        }
        return items;
    }

    private async collectDirectoryJdItems(
        docDir: string,
        partial: string,
        alreadyLoaded: Set<string>,
        seenLabels: Set<string>,
        makeTextEdit: (p: string) => { range: { start: Position; end: Position }; newText: string }
    ): Promise<CompletionItem[]> {
        const partialDir = path.dirname(partial);
        const filePrefix = path.basename(partial);
        const resolvedDir = path.resolve(docDir, partialDir === '.' ? '' : partialDir);
        let entries: fs.Dirent<string>[];
        try {
            entries = await fs.promises.readdir(resolvedDir, { withFileTypes: true, encoding: 'utf-8' });
        } catch {
            return [];
        }
        return entries
            .filter(e => (e.isDirectory() || e.name.endsWith('.jd')) && (!filePrefix || e.name.startsWith(filePrefix)))
            .map(e => this.makeLoadPathItem(e, docDir, resolvedDir, makeTextEdit))
            .filter(item => !seenLabels.has(item.label) && !alreadyLoaded.has(item.label));
    }

    private makeLoadPathItem(
        entry: fs.Dirent<string>,
        docDir: string,
        resolvedDir: string,
        makeTextEdit: (p: string) => { range: { start: Position; end: Position }; newText: string }
    ): CompletionItem {
        const isDir = entry.isDirectory();
        const relPath = path.relative(docDir, path.join(resolvedDir, entry.name)).replaceAll('\\', '/');
        const insertPath = relPath.startsWith('../') ? relPath : `./${relPath}`;
        const label = isDir ? `${insertPath}/` : insertPath;
        return {
            label,
            kind: isDir ? CompletionItemKind.Folder : CompletionItemKind.File,
            detail: isDir ? 'directory' : '.jd file',
            sortText: isDir ? `0_dir_${label}` : `1_file_${label}`,
            textEdit: makeTextEdit(label)
        };
    }

    private offsetInsideSomeTemplateBody(document: LangiumDocument, offset: number): boolean {
        const unit = document.parseResult.value as Unit | undefined;
        if (!unit?.body) return false;
        for (const item of unit.body) {
            if (!isTemplate(item)) continue;
            const cst = item.$cstNode;
            if (cst && offset > cst.offset && offset < cst.end) return true;
        }
        return false;
    }

    private tryAtSupportKeywordCompletion(document: LangiumDocument, position: Position): CompletionItem | undefined {
        const offset = document.textDocument.offsetAt(position);
        if (!this.offsetInsideSomeTemplateBody(document, offset)) return undefined;

        const linePrefix = document.textDocument.getText({
            start: Position.create(position.line, 0),
            end: position
        });
        const m = linePrefix.match(/@\w*$/);
        if (!m) return undefined;

        const atCol = position.character - m[0].length;
        return {
            label: '@support',
            kind: CompletionItemKind.Keyword,
            detail: 'Keyword',
            sortText: '0_@support',
            filterText: '@support',
            preselect: true,
            textEdit: {
                range: {
                    start: { line: position.line, character: atCol },
                    end: position
                },
                newText: '@support '
            }
        };
    }

    private getTemplateElementCompletions(context: CompletionContext): CompletionItem[] {
        if (this.logger.shouldLog('debug')) this.logger.debug(`Completion request at line ${context.position.line}:${context.position.character}`);
        try {
            const currentNode = context.node;
            if (!currentNode) return [];

            const justificationBody = AstUtils.getContainerOfType(currentNode, isJustificationBody);
            if (!justificationBody) return [];

            const justification = justificationBody.$container as Justification | undefined;
            if (!justification || !isJustification(justification)) return [];

            const template = justification.parent?.ref;
            if (!template) return [];

            const allTemplateElements = getAllElements(template);
            const existingElements = getLocalElements(justification);
            const existingIds = new Set(existingElements.map(el => qualifiedIdText(el.id)));
            const suggestedIds = new Set<string>();

            const completions: CompletionItem[] = [];
            for (const element of allTemplateElements) {
                const idText = qualifiedIdText(element.id);
                if (existingIds.has(idText) || suggestedIds.has(idText)) continue;
                const completion = this.createTemplateElementCompletion(element, context);
                if (completion) {
                    suggestedIds.add(idText);
                    completions.push(completion);
                }
            }
            return completions;
        } catch (error) {
            this.logger.error(`getTemplateElementCompletions failed: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    private createTemplateElementCompletion(
        element: JustificationElement | AbstractSupport,
        context: CompletionContext
    ): CompletionItem | undefined {
        const idText = qualifiedIdText(element.id);
        let keyword: string;
        let snippet: string;

        if (isAbstractSupport(element) || isEvidence(element)) {
            keyword = 'evidence';
            snippet = `evidence ${idText} is "${element.name}"`;
        } else if (isStrategy(element)) {
            keyword = 'strategy';
            snippet = `strategy ${idText} is "${element.name}"`;
        } else if (isConclusion(element)) {
            keyword = 'conclusion';
            snippet = `conclusion ${idText} is "${element.name}"`;
        } else if (isSubConclusion(element)) {
            keyword = 'sub-conclusion';
            snippet = `sub-conclusion ${idText} is "${element.name}"`;
        } else {
            return undefined;
        }

        const isRequired = isAbstractSupport(element);
        const defFile = this.basenameFromAstNode(element);
        const fileSuffix = defFile ? ` (${defFile})` : '';
        const detail = isRequired
            ? `Required @support from template: ${idText} is "${element.name}"`
            : `From template: ${idText} is "${element.name}"`;
        const documentation = isRequired
            ? `Required @support element from template${fileSuffix}. Inserts: ${snippet}`
            : `Element from template${fileSuffix}. Inserts: ${snippet}`;

        const textEdit = this.buildWordReplaceEdit(context, snippet + '\n');

        return {
            label: `${keyword} ${idText}`,
            kind: CompletionItemKind.Property,
            detail,
            labelDetails: {
                ...(defFile ? { detail: ` · ${defFile}` } : {}),
                description: ` · ${element.$type}`
            },
            insertText: snippet,
            textEdit,
            sortText: isRequired ? `0_${keyword}_${idText}` : `1_${keyword}_${idText}`,
            documentation
        };
    }

    private findElementInfo(currentDoc: LangiumDocument, nodeDescription: AstNodeDescription): { sourceFile: string; isImported: boolean } | undefined {
        const documentUri = nodeDescription.documentUri;
        if (!documentUri) return undefined;

        const currentUnit = currentDoc.parseResult.value as Unit | undefined;
        if (!currentUnit) return undefined;

        const currentUri = typeof currentDoc.uri === 'string' ? currentDoc.uri : currentDoc.uri.toString();
        const targetUri = typeof documentUri === 'string' ? documentUri : documentUri.toString();

        const currentPath = URI.parse(currentUri).path;
        const targetPath = URI.parse(targetUri).path;

        if (currentPath === targetPath) return undefined;

        const relativePath = this.getRelativePath(currentPath, targetPath);
        const normalizedRelativePath = this.normalizePathForComparison(relativePath);
        const isImported = currentUnit.imports.some(
            load => this.normalizePathForComparison(load.path) === normalizedRelativePath
        );

        return { sourceFile: relativePath, isImported };
    }

    private buildWordReplaceEdit(context: CompletionContext, newText: string): TextEdit {
        const position = context.position;
        const lines = context.document.textDocument.getText().split('\n');
        const line = lines[position.line] ?? '';

        let startCol = position.character;
        while (startCol > 0 && /\w/.test(line[startCol - 1])) startCol--;

        let endCol = position.character;
        while (endCol < line.length && /\w/.test(line[endCol])) endCol++;

        return {
            range: {
                start: { line: position.line, character: startCol },
                end: { line: position.line, character: endCol }
            },
            newText
        };
    }

    private findLoadInsertPosition(lines: string[]): { insertLine: number; hasExistingLoads: boolean } {
        let insertLine = 0;
        let lastLoadLine = -1;
        let hasExistingLoads = false;

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed.startsWith('load ')) {
                hasExistingLoads = true;
                lastLoadLine = i;
                insertLine = i + 1;
            } else if (trimmed && !trimmed.startsWith('//')) {
                if (lastLoadLine >= 0) break;
                insertLine = i;
                break;
            }
        }

        return { insertLine, hasExistingLoads };
    }

    private createLoadEdit(document: LangiumDocument, relativePath: string): TextEdit[] | undefined {
        const currentUnit = document.parseResult.value as Unit | undefined;
        if (!currentUnit) return undefined;

        const normalizedRelativePath = this.normalizePathForComparison(relativePath);
        const alreadyImported = currentUnit.imports.some(
            load => this.normalizePathForComparison(load.path) === normalizedRelativePath
        );
        if (alreadyImported) return undefined;

        const lines = document.textDocument.getText().split('\n');
        const { insertLine, hasExistingLoads } = this.findLoadInsertPosition(lines);

        const finalPath = relativePath.startsWith('../')
            ? relativePath
            : `./${normalizedRelativePath}`;
        const newlineSuffix = hasExistingLoads ? '\n' : '\n\n';

        return [{
            range: { start: Position.create(insertLine, 0), end: Position.create(insertLine, 0) },
            newText: `load "${finalPath}"${newlineSuffix}`
        }];
    }
}
