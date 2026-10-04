import { stream, type Stream, AstUtils, GrammarAST, type AstNode, type AstNodeDescription, type ReferenceInfo, type LangiumDocument, type MaybePromise } from 'langium';
import {
    DefaultCompletionProvider,
    type CompletionAcceptor,
    type CompletionContext,
    type CompletionProviderOptions,
    type CompletionValueItem,
    type NextFeature
} from 'langium/lsp';
import { MarkupKind, Position, type TextEdit, CompletionItem, CompletionItemKind, CompletionList, type CompletionParams, InsertTextFormat } from 'vscode-languageserver';
import type { IToken } from 'chevrotain';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JpipeServices } from './jpipe-module.js';
import type { JpipeServerLogger } from './jpipe-logger.js';
import { JPIPE_OPERATORS, UNIVERSAL_CONFIG_KEYS, allowedConfigKeys, renderInvocation } from './jpipe-operators.js';
import { BUILT_IN_UNIFICATION_METHODS, DEFAULT_UNIFICATION_METHOD } from './jpipe-unification.js';
import { createLoadEdit, normalizeLoadPath, relativeLoadPath, wordReplaceEdit } from './jpipe-edits.js';
import { concreteKeywordFor, overrideKeywordFor, renderElement } from './jpipe-render.js';
import {
    isComposition,
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
    type AbstractSupport
} from './generated/ast.js';
import { fsPathOf, getAllElements, getLocalElements, qualifiedIdText } from './jpipe-utils.js';
import { messageOf } from './jpipe-errors.js';

const WORD_CHARACTER = /\w/;

/**
 * The word being typed at the very end of `text`, or `''` when the last character is not one.
 *
 * Scanned backwards rather than matched with `/\w*$/`: an unanchored pattern ending in `$` is
 * retried from every position, which is quadratic on a long prefix (S8786). This is linear in
 * the length of the word, which is what it needs to look at.
 */
function trailingWord(text: string): string {
    let start = text.length;
    while (start > 0 && WORD_CHARACTER.test(text[start - 1])) start--;
    return text.slice(start);
}

/**
 * Where the cursor sits in a composition — `justification Name is operator(sources) { key: "value" }`
 * — with what the completions for that spot need to know. `partial` is what has been typed of
 * the word or value being completed.
 */
type CompositionCursor =
    | { readonly at: 'operator'; readonly partial: string }
    | { readonly at: 'key'; readonly operator: string; readonly written: readonly string[]; readonly partial: string }
    | { readonly at: 'value'; readonly operator: string; readonly sources: readonly string[]; readonly key: string; readonly partial: string };

const isModelKeyword = (token: IToken | undefined): boolean =>
    token?.image === 'justification' || token?.image === 'template';

const isId = (token: IToken | undefined): boolean => token?.tokenType.name === 'ID';

/**
 * Whether the tokens before `tokens[is]` declare a model: `justification Name`, or the same with
 * `implements Parent` after it, where the parent may be qualified (`ns:Parent`).
 */
function declaresModelBefore(tokens: readonly IToken[], is: number): boolean {
    if (isModelKeyword(tokens[is - 2]) && isId(tokens[is - 1])) return true;
    let parent = is - 1;
    while (tokens[parent - 1]?.image === ':' && isId(tokens[parent - 2])) parent -= 2;
    return isId(tokens[parent])
        && tokens[parent - 1]?.image === 'implements'
        && isId(tokens[parent - 2])
        && isModelKeyword(tokens[parent - 3]);
}

/** The cursor completing the operator, right after `justification Name is`. */
function operatorCursor(tokens: readonly IToken[], partial: string): CompositionCursor | undefined {
    const is = partial && tokens.at(-1)?.image === partial ? tokens.length - 2 : tokens.length - 1;
    return tokens[is]?.image === 'is' && declaresModelBefore(tokens, is) ? { at: 'operator', partial } : undefined;
}

/**
 * The composition whose config block is still open at the end of `tokens`: the last `{` is
 * unclosed and closes the parameter list of `justification Name is operator(…)`. A model's body
 * opens with `{` too, so being inside an unclosed brace is not enough on its own.
 */
function openConfigBlock(tokens: readonly IToken[]): { operator: string; sources: string[]; block: readonly IToken[] } | undefined {
    let open = tokens.length - 1;
    while (open >= 0 && tokens[open].image !== '{') {
        if (tokens[open].image === '}') return undefined;
        open--;
    }
    if (tokens[open - 1]?.image !== ')') return undefined;

    let paren = open - 2;
    while (paren >= 0 && tokens[paren].image !== '(') paren--;
    const operator = tokens[paren - 1];
    if (!isId(operator) || tokens[paren - 2]?.image !== 'is' || !declaresModelBefore(tokens, paren - 2)) return undefined;

    // A qualified source, `ns:Model`, is several tokens; the commas are what separate them.
    const sources = tokens.slice(paren + 1, open - 1).map(token => token.image).join('').split(',');
    return { operator: operator.image, sources, block: tokens.slice(open + 1) };
}

/** The cursor in the value of `key: "…`, the tokens being those before the value's opening quote. */
function valueCursor(tokens: readonly IToken[], partial: string): CompositionCursor | undefined {
    const config = openConfigBlock(tokens);
    const [key, colon] = config?.block.slice(-2) ?? [];
    if (!config || !isId(key) || colon?.image !== ':') return undefined;
    return { at: 'value', operator: config.operator, sources: config.sources, key: key.image, partial };
}

/** The cursor on a key in an open config block, with the keys the block already sets. */
function keyCursor(tokens: readonly IToken[], partial: string): CompositionCursor | undefined {
    const config = openConfigBlock(tokens);
    // Right after `key:` a value is due, not another key.
    if (!config || config.block.at(-1)?.image === ':') return undefined;
    const written = config.block
        .filter((token, i) => isId(token) && config.block[i + 1]?.image === ':')
        .map(token => token.image);
    return { at: 'key', operator: config.operator, written, partial };
}

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
    ): MaybePromise<void> {
        if (this.lineEndsWithAtKeywordPrefix(context)) {
            if (GrammarAST.isCrossReference(next.feature)) return;
            if (GrammarAST.isKeyword(next.feature) && !next.feature.value.startsWith('@')) return;
        }
        // Returned, not dropped: Langium awaits every feature's result before it builds the list.
        return super.completionFor(context, next, acceptor);
    }

    /**
     * The edit accepting a completion applies.
     *
     * The `@` case is the whole reason this is overridden, and it has to measure what the user
     * typed from the **line**, not from `context.tokenOffset`. `@support` is a keyword, so a lone
     * `@` matches no token: the lexer leaves it behind and `tokenOffset` points *past* it, at the
     * cursor. Reading the typed text from there returns nothing that starts with `@`, the whole
     * branch is skipped, and the default edit inserts a second `@` beside the first — `@@support`,
     * from the one keystroke that says unambiguously which keyword is wanted. `@su` doubles the
     * same way, since `su` lexes on its own and the `@` is again outside the token.
     *
     * The line prefix has no such gap: `/@\w*$/` is exactly what has been typed, so its length is
     * exactly what the edit must replace.
     */
    protected override buildCompletionTextEdit(context: CompletionContext, label: string, newText: string): TextEdit | undefined {
        const typed = /@\w*$/.exec(this.linePrefixToCursor(context));

        if (typed && !label.startsWith('@')) {
            return undefined;
        }

        if (typed && label.startsWith('@')) {
            const typedTail = typed[0].slice(1);
            const labelTail = label.slice(1);
            if (typedTail.length > 0 && !this.services.shared.lsp.FuzzyMatcher.match(typedTail, labelTail)) {
                return undefined;
            }
            return {
                newText,
                range: {
                    start: context.textDocument.positionAt(context.offset - typed[0].length),
                    end: context.position
                }
            };
        }

        return super.buildCompletionTextEdit(context, label, newText);
    }

    protected override getReferenceCandidates(refInfo: ReferenceInfo, context: CompletionContext): Stream<AstNodeDescription> {
        if (refInfo.property === 'parent') {
            const doc = context.document;
            const unit = doc.parseResult.value as Unit | undefined;
            const parentOwner =
                AstUtils.getContainerOfType(refInfo.container, isJustification) ??
                AstUtils.getContainerOfType(refInfo.container, isTemplate);
            if (unit && parentOwner) {
                return stream(this.parentTemplateCandidateDescriptions(unit, doc));
            }
        }

        if (refInfo.property === 'from' || refInfo.property === 'to') {
            const owner =
                AstUtils.getContainerOfType(refInfo.container, isJustification) ??
                AstUtils.getContainerOfType(refInfo.container, isTemplate);
            if (owner) {
                // Filtering by sibling ref is safe here: completion runs after linking.
                const relation = refInfo.container as Relation;
                const doc = context.document;
                const unit = doc.parseResult.value as Unit | undefined;

                // Build candidates with namespace-qualified keys.
                // Only @support elements from parent templates are offered as candidates
                // (same policy as the original getRelationCandidates), so the popup does
                // not flood users with all inherited non-abstract elements.
                const localElements = getLocalElements(owner);
                const inheritedEntries = unit
                    ? this.importService
                        .getInheritedElementsWithKeys(owner, unit, doc)
                        .filter(({ element }) => isAbstractSupport(element))
                    : [];

                let withKeys: Array<{ element: JustificationElement; key: string }> = [
                    ...localElements.map(e => ({ element: e, key: qualifiedIdText(e.id) })),
                    ...inheritedEntries
                ];

                const fromRef = relation.from?.ref;
                const toRef = relation.to?.ref;
                if (refInfo.property === 'to' && fromRef) {
                    withKeys = withKeys.filter(({ element }) => this.filterRelationTargets(fromRef, [element]).length > 0);
                } else if (refInfo.property === 'from' && toRef) {
                    withKeys = withKeys.filter(({ element }) => this.filterRelationSources(toRef, [element]).length > 0);
                }

                return stream(withKeys.flatMap(({ element, key }) => {
                    try {
                        const d = this.services.workspace.AstNodeDescriptionProvider.createDescription(element, key);
                        return d ? [d] : [];
                    } catch {
                        return [];
                    }
                }));
            }
        }

        if (refInfo.property === 'refs') {
            return super.getReferenceCandidates(refInfo, context)
                .filter(candidate => this.isUsefulCompositionSource(refInfo, candidate));
        }

        // For other cross-refs: delegate to the scope provider via super.
        return super.getReferenceCandidates(refInfo, context);
    }

    /**
     * Whether a model is worth offering as a source of the composition being written.
     *
     * Two are not. The model being defined: `justification x is assemble(…)` composing `x` out of
     * `x` is circular, and it is the one name guaranteed to be on the tip of the author's fingers,
     * so it would sit at the top of the list. And a model already named in this same call:
     * composing something with a second copy of an input it already has cannot say anything the
     * first copy did not.
     *
     * Both remain *resolvable* — this narrows what is suggested, not what the grammar accepts, so
     * a model written by hand still links and is reported by the rules that judge it rather than
     * vanishing into an unresolved reference.
     */
    private isUsefulCompositionSource(refInfo: ReferenceInfo, candidate: AstNodeDescription): boolean {
        const composition = AstUtils.getContainerOfType(refInfo.container, isComposition);
        if (!composition) return true;

        const owner = composition.$container;
        if ((isJustification(owner) || isTemplate(owner)) && owner.id === candidate.name) return false;

        // Every other slot in this call — not the one being typed, whose partial text is the
        // very thing being completed.
        const elsewhere = (composition.params?.refs ?? [])
            .filter((_ref, index) => index !== refInfo.index)
            .map(ref => ref.$refText)
            .filter(text => text.length > 0);
        return !elsewhere.includes(candidate.name);
    }

    private filterRelationTargets(from: JustificationElement, candidates: JustificationElement[]): JustificationElement[] {
        if (isEvidence(from) || isAbstractSupport(from) || isSubConclusion(from)) return candidates.filter(e => isStrategy(e));
        if (isStrategy(from)) return candidates.filter(e => isSubConclusion(e) || isConclusion(e));
        return candidates;
    }

    private filterRelationSources(to: JustificationElement, candidates: JustificationElement[]): JustificationElement[] {
        if (isStrategy(to)) return candidates.filter(e => isEvidence(e) || isAbstractSupport(e) || isSubConclusion(e));
        if (isSubConclusion(to) || isConclusion(to)) return candidates.filter(e => isStrategy(e));
        return candidates;
    }

    /** Templates for `implements`: local + `load`ed first, then workspace index (dedupe by name). */
    private parentTemplateCandidateDescriptions(unit: Unit, doc: LangiumDocument): AstNodeDescription[] {
        const descFor = (node: Template): AstNodeDescription | undefined => {
            try {
                return this.services.workspace.AstNodeDescriptionProvider.createDescription(node, node.id);
            } catch {
                return undefined;
            }
        };
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



    private basenameFromDescription(desc: AstNodeDescription): string | undefined {
        const uri = desc.documentUri;
        if (!uri) return undefined;
        const p = fsPathOf(uri);
        return path.basename(p) || undefined;
    }

    private basenameFromAstNode(node: AstNode): string | undefined {
        const doc = (node as { $document?: LangiumDocument }).$document;
        const uri = doc?.uri;
        if (!uri) return undefined;
        const p = fsPathOf(uri);
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
                additionalTextEdits: createLoadEdit(context.document as LangiumDocument<Unit>, elementInfo.sourceFile)
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

        const textToCursor = document.textDocument.getText({
            start: Position.create(0, 0),
            end: pos
        });
        const cursor = this.compositionCursor(textToCursor);

        // Inside a config value only that value is completed. Most values are free text, where
        // nothing applies — certainly not the key names, which is what used to be offered here.
        if (cursor?.at === 'value') {
            return { ...result, items: this.getConfigValueCompletions(document, cursor, pos) };
        }

        if (cursor?.at === 'operator') {
            const indent = /^[ \t]*/.exec(linePfx)?.[0] ?? '';
            const operatorItems = this.getOperatorCompletions(cursor.partial, indent);
            if (operatorItems.length > 0) {
                items = [...operatorItems, ...items.filter(i => !operatorItems.some(o => o.label === i.label))];
            }
        }

        if (cursor?.at === 'key') {
            const keyItems = this.getConfigKeyCompletions(cursor.operator, cursor.partial, cursor.written);
            if (keyItems.length > 0) {
                items = [...keyItems, ...items.filter(i => !keyItems.some(k => k.label === i.label))];
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

    /**
     * Completes the value of `refine`'s `hook`, which names an element of the *first* source
     * model.
     *
     * `hook` is a plain string in the grammar, so nothing links it, nothing validates it, and
     * nothing has ever offered it — the only way to learn what may go there has been to read the
     * model being refined. Offered as ids because that is what the compiler resolves against,
     * showing each element's label alongside, since an id like `e` says nothing on its own.
     *
     * Only evidence is offered. `refine` replaces the hooked element with a sub-conclusion
     * carrying the refinement's whole argument, which is a sensible thing to do to a leaf and not
     * to anything else — hooking a strategy or a conclusion would graft an argument into the
     * middle of one. The compiler resolves the hook by id and does not check its type, so this
     * narrows what is suggested rather than what is permitted.
     */
    private getHookValueCompletions(document: LangiumDocument, firstParam: string | undefined, partial: string, position: Position): CompletionItem[] {
        if (!firstParam) return [];

        const unit = document.parseResult.value as Unit | undefined;
        if (!unit) return [];
        const base = this.findModelByRefText(unit, document, firstParam);
        if (!base) return [];

        const start = document.textDocument.positionAt(
            document.textDocument.offsetAt(position) - partial.length
        );

        return getAllElements(base)
            .filter(element => isEvidence(element))
            .filter(element => qualifiedIdText(element.id).length > 0)
            .filter(element => !partial || this.services.shared.lsp.FuzzyMatcher.match(partial, qualifiedIdText(element.id)))
            .map(element => {
                const id = qualifiedIdText(element.id);
                return {
                    label: id,
                    kind: CompletionItemKind.Value,
                    // The id is what gets inserted; the label is what makes it recognisable.
                    labelDetails: { detail: `  "${element.name}"` },
                    detail: `evidence in ${firstParam}`,
                    documentation: element.name,
                    sortText: `0_hook_${id}`,
                    // Replaces what has been typed so far inside the quotes, and nothing else.
                    textEdit: { range: { start, end: position }, newText: id }
                };
            });
    }

    /**
     * Completes the value of `unifyBy`, which names an equivalence relation.
     *
     * The relations live in a registry the compiler fills at startup, so the list has two halves
     * and the difference matters: one is what jPipe ships, the other is what this workspace has
     * been *told* its build registers. Each is labelled, so accepting a name makes clear whether
     * the editor knows it exists or has merely been assured of it.
     */
    private getUnificationMethodCompletions(document: LangiumDocument, partial: string, position: Position): CompletionItem[] {
        const start = document.textDocument.positionAt(
            document.textDocument.offsetAt(position) - partial.length
        );

        return this.services.unification.known()
            .filter(name => !partial || this.services.shared.lsp.FuzzyMatcher.match(partial, name))
            .map(name => {
                const isCore = BUILT_IN_UNIFICATION_METHODS.includes(name);
                return {
                    label: name,
                    kind: CompletionItemKind.EnumMember,
                    detail: isCore ? 'jPipe core' : 'declared in settings',
                    documentation: name === DEFAULT_UNIFICATION_METHOD
                        ? 'Used when a composition sets no unifyBy.'
                        : undefined,
                    // Core relations first: they are the ones certain to exist.
                    sortText: `${isCore ? '0' : '1'}_unify_${name}`,
                    textEdit: { range: { start, end: position }, newText: name }
                };
            });
    }

    /** The values worth offering for a config key: only `hook` and `unifyBy` have a known set. */
    private getConfigValueCompletions(
        document: LangiumDocument,
        cursor: Extract<CompositionCursor, { at: 'value' }>,
        position: Position
    ): CompletionItem[] {
        if (cursor.key === 'hook' && cursor.operator === 'refine') {
            return this.getHookValueCompletions(document, cursor.sources[0], cursor.partial, position);
        }
        if (cursor.key === 'unifyBy') {
            return this.getUnificationMethodCompletions(document, cursor.partial, position);
        }
        return [];
    }

    /** Resolves a composition parameter's text to a local or loaded model. */
    private findModelByRefText(unit: Unit, document: LangiumDocument, refText: string): Justification | Template | undefined {
        const local = unit.body.find(model => model.id === refText);
        if (local) return local;
        const imported = this.importService.getJustificationsAndTemplatesWithNamespace(unit, document);
        return imported.find(({ node, ns }) => (ns ? `${ns}:${node.id}` : node.id) === refText)?.node;
    }

    /**
     * Completes a composition operator with its whole invocation, not just its name.
     *
     * The name alone leaves three things still to look up: how many source models the operator
     * takes and in what order, which config keys it cannot run without, and the fact that an
     * empty `{}` does not parse. Writing the shape answers all three, and the documentation shows
     * what will be inserted before it is accepted.
     */
    private getOperatorCompletions(partial: string, indent: string): CompletionItem[] {
        return JPIPE_OPERATORS
            .filter(spec => !partial || this.services.shared.lsp.FuzzyMatcher.match(partial, spec.name))
            .map(spec => {
                // Tab stops for the editor; the same shape with the names left in for the preview.
                const snippet = renderInvocation(spec, indent, (i, text) => text ? `\${${i}:${text}}` : `\${${i}}`);
                const preview = renderInvocation(spec, '', (_i, text) => text);
                return {
                    label: spec.name,
                    kind: CompletionItemKind.Snippet,
                    detail: `composition operator — ${spec.summary}`,
                    documentation: {
                        kind: MarkupKind.Markdown,
                        value: `${spec.summary}\n\n\`\`\`jpipe\n${preview}\n\`\`\``
                    },
                    insertText: snippet,
                    insertTextFormat: InsertTextFormat.Snippet,
                    sortText: `0_op_${spec.name}`
                };
            });
    }

    /**
     * Where the cursor is in a composition, or `undefined` when it is in none.
     *
     * Read from the grammar's own tokens rather than from the text, once, for every completion
     * that depends on it — the operator name, the config keys and the config values each used to
     * run a regex of their own, and each got a different corner wrong. Comments are hidden tokens,
     * so one between the `)` and the `{` still leaves a config block; a brace or a parenthesis
     * inside a comment or a label is not structure; and the parts may sit on separate lines.
     * Lexing is linear in the text above the cursor, where the regexes were quadratic (S8786).
     *
     * A value being typed is an unterminated string, which the lexer reports as an error on its
     * opening quote before lexing the rest as if it were code. The first such quote is therefore
     * where the value starts, and only the tokens before it describe where the value sits.
     */
    private compositionCursor(textToCursor: string): CompositionCursor | undefined {
        const lexed = this.services.parser.Lexer.tokenize(textToCursor);
        const quote = lexed.errors.find(error => textToCursor[error.offset] === '"' || textToCursor[error.offset] === "'");
        if (quote) {
            const tokens = lexed.tokens.filter(token => token.startOffset < quote.offset);
            return valueCursor(tokens, textToCursor.slice(quote.offset + 1));
        }
        const partial = trailingWord(textToCursor);
        return operatorCursor(lexed.tokens, partial) ?? keyCursor(lexed.tokens, partial);
    }

    /** The keys `operator` accepts, less those already `written` in the block. */
    private getConfigKeyCompletions(operator: string, partial: string, written: readonly string[]): CompletionItem[] {
        const keys = allowedConfigKeys(operator).filter((k: string) => !written.includes(k));
        return keys
            .filter((k: string) => !partial || this.services.shared.lsp.FuzzyMatcher.match(partial, k))
            .map((k: string) => {
                // The unification keys read the same on every operator, so naming one would
                // misdescribe them; they also sort below the operator's own arguments.
                const universal = (UNIVERSAL_CONFIG_KEYS as readonly string[]).includes(k);
                return {
                    label: k,
                    kind: CompletionItemKind.Property,
                    detail: universal ? 'unification argument' : `${operator} argument`,
                    sortText: universal ? `1_cfg_${k}` : `0_cfg_${k}`,
                    insertText: `${k}: "$0"`,
                    insertTextFormat: InsertTextFormat.Snippet
                };
            });
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
        const docPath = fsPathOf(document.uri);
        const docDir = path.dirname(docPath);
        const makeTextEdit = (p: string) => ({
            range: { start: { line: pos.line, character: pathStartCol }, end: pos },
            newText: p
        });

        const currentUnit = document.parseResult.value as Unit | undefined;
        const alreadyLoaded = new Set(currentUnit?.imports.map(l => {
            const p = normalizeLoadPath(l.path);
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
                const targetPath = fsPathOf(targetUri);
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
        const m = /@\w*$/.exec(linePrefix);
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

            if (!justification.parent?.ref) return [];

            const doc = context.document;
            const unit = doc.parseResult.value as Unit | undefined;
            if (!unit) return [];

            // Use namespace-qualified keys so snippets match the qualified-ID scheme.
            const inheritedEntries = this.importService.getInheritedElementsWithKeys(justification, unit, doc);
            const existingIds = new Set(getLocalElements(justification).map(el => qualifiedIdText(el.id)));
            const suggestedIds = new Set<string>();

            const completions: CompletionItem[] = [];
            for (const { element, key } of inheritedEntries) {
                if (!isAbstractSupport(element)) continue; // only @support elements require explicit override
                if (existingIds.has(key) || suggestedIds.has(key)) continue;
                const completion = this.createTemplateElementCompletion(element, key, context);
                if (completion) {
                    suggestedIds.add(key);
                    completions.push(completion);
                }
            }
            return completions;
        } catch (error) {
            this.logger.error(`getTemplateElementCompletions failed: ${messageOf(error)}`);
            return [];
        }
    }

    private createTemplateElementCompletion(
        element: JustificationElement | AbstractSupport,
        idText: string,
        context: CompletionContext
    ): CompletionItem | undefined {
        // An @support is offered as the declaration that would override it, not as itself —
        // `@support` is not legal in a justification body.
        const keyword = isAbstractSupport(element)
            ? overrideKeywordFor(element)
            : concreteKeywordFor(element);
        if (!keyword) return undefined;
        const snippet = renderElement(keyword, idText, element.name);

        const isRequired = isAbstractSupport(element);
        const defFile = this.basenameFromAstNode(element);
        const fileSuffix = defFile ? ` (${defFile})` : '';
        const detail = isRequired
            ? `Required @support from template: ${idText} is "${element.name}"`
            : `From template: ${idText} is "${element.name}"`;
        const documentation = isRequired
            ? `Required @support element from template${fileSuffix}. Inserts: ${snippet}`
            : `Element from template${fileSuffix}. Inserts: ${snippet}`;

        const textEdit = wordReplaceEdit(context.document, context.position, snippet + '\n');

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

        const currentPath = fsPathOf(currentDoc.uri);
        const targetPath = fsPathOf(documentUri);

        if (currentPath === targetPath) return undefined;

        const relativePath = relativeLoadPath(currentPath, targetPath);
        const normalizedRelativePath = normalizeLoadPath(relativePath);
        const isImported = currentUnit.imports.some(
            load => normalizeLoadPath(load.path) === normalizedRelativePath
        );

        return { sourceFile: relativePath, isImported };
    }



}
