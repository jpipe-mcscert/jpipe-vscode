import { CstUtils, GrammarAST, type AstNode, type CstNode, type LangiumDocument, type MaybePromise } from 'langium';
import { DefaultRenameProvider } from 'langium/lsp';
import { TextEdit } from 'vscode-languageserver-types';
import { ErrorCodes, ResponseError } from 'vscode-languageserver';
import type { Range, RenameParams, TextDocumentPositionParams, WorkspaceEdit } from 'vscode-languageserver';
import {
    isJustification,
    isJustificationElement,
    isQualifiedId,
    isTemplate,
    type Justification,
    type JustificationElement,
    type Template,
    type Unit
} from './generated/ast.js';
import type { JpipeServices } from './jpipe-module.js';
import { getDocumentAndUnit } from './jpipe-ast-context.js';
import { keywordFor } from './jpipe-render.js';
import { localName, qualifiedIdText } from './jpipe-utils.js';
import { elementEdits, overridesIn, qualifierEdits, segmentNodes, type NamePrefix } from './jpipe-qualified-names.js';

/** What the cursor is asking to rename. */
type RenameTarget =
    /** A justification or template, whose name is also written into every override refining it. */
    | { readonly kind: 'model'; readonly model: Justification | Template }
    /** An element, whose name is written into every override of it and every relation naming one. */
    | { readonly kind: 'element'; readonly element: JustificationElement }
    /** A rename this provider will not perform. `reason` is shown to the user when there is one. */
    | { readonly kind: 'refuse'; readonly reason?: string }
    /** Anything else, which `DefaultRenameProvider` already handles. */
    | { readonly kind: 'default' };

/** One document's contribution to a rename, gathered before any edit is computed. */
interface Candidate {
    readonly document: LangiumDocument;
    readonly unit: Unit;
    readonly prefixes: NamePrefix[];
}

/**
 * Rename, taught what this grammar does that a reference-following rename cannot see.
 *
 * **Names outlive their references.** An element declared `T:abs` overrides `@support abs` in
 * template `T`, and that link is made by *string comparison* against the text written after
 * `implements` — the override is not a reference to the `@support`, it is a second declaration
 * that agrees with it, and no link records the fact. So a rename that follows references alone
 * renames a declaration out from under everything that still agrees with the old spelling, in both
 * directions: renaming the template leaves `T:abs` behind, and renaming the `@support` leaves the
 * overrides behind. Both now carry, across every open document that can reach the declaration.
 *
 * **A reference is not always one word.** `implements lib:T` is a single cross-reference whose text
 * is `lib:T`, and the default provider replaces the whole of it — dropping the namespace and
 * unresolving the very reference it was asked to keep working. Only the segment naming the target
 * is rewritten here.
 *
 * **An element's name node is not its own AST node.** An element's id is a nested `QualifiedId`, so
 * a cursor on it belongs to *that* node rather than to the element, and Langium's resolution stops
 * there and finds nothing to rename. Renaming an element therefore worked from a relation naming
 * it and not from its own declaration, which is the wrong way round.
 *
 * **An override is renamed from the template, not at the override.** Renaming `T:abs` where it is
 * used would have to rename the `@support` it restates and every sibling override across the
 * workspace, from a position that reads like a local edit. That is declined — with a message
 * saying where the name comes from, since an editor that only says "cannot rename" leaves the user
 * to guess.
 */
export class JpipeRenameProvider extends DefaultRenameProvider {

    private readonly services: JpipeServices;

    constructor(services: JpipeServices) {
        super(services);
        this.services = services;
    }

    override prepareRename(document: LangiumDocument, params: TextDocumentPositionParams): MaybePromise<Range | undefined> {
        const target = this.resolveTarget(document, params);
        if (target.kind === 'refuse') return this.decline(target.reason);
        // The default implementation looks for a node it recognises as a name, and an element's id
        // is not one; the segment under the cursor is what the client should offer to edit.
        if (target.kind === 'element') return this.leafAt(document, params)?.range;
        return super.prepareRename(document, params);
    }

    override async rename(document: LangiumDocument, params: RenameParams): Promise<WorkspaceEdit | undefined> {
        // Guarded as well as `prepareRename`: a client may send `textDocument/rename` without
        // having asked to prepare it first, and this is the request that actually edits.
        const target = this.resolveTarget(document, params);
        switch (target.kind) {
            case 'refuse':  return this.decline(target.reason);
            case 'model':   return this.renameModel(target.model, params.newName);
            case 'element': return this.renameElement(target.element, params.newName);
            default:        return super.rename(document, params);
        }
    }

    /**
     * Refuses the rename, explaining why when there is something useful to say.
     *
     * An error response is what puts the text in front of the user: returning nothing makes the
     * editor say only that the element cannot be renamed, which is true and useless.
     */
    private decline(reason: string | undefined): undefined {
        if (reason) throw new ResponseError(ErrorCodes.InvalidRequest, reason);
        return undefined;
    }

    /**
     * What the cursor is on, resolved through the same path the default provider uses so the
     * answer describes the node that would actually be renamed rather than whatever the cursor
     * happens to sit on.
     */
    private resolveTarget(document: LangiumDocument, params: TextDocumentPositionParams): RenameTarget {
        const leaf = this.leafAt(document, params);
        if (!leaf) return { kind: 'default' };

        // A declaration's own name node counts as a declaration of itself here, so this one call
        // covers both renaming from a usage and renaming from a model's declaration.
        const declarations = this.references.findDeclarations(leaf);

        const model = declarations.find(isModel);
        if (model) {
            // `implements lib:T` names the template with its *last* segment; a cursor on `lib` is
            // asking to rename the load's alias, which is not a linked name and not this request.
            return this.isFinalSegment(leaf) ? { kind: 'model', model } : { kind: 'refuse' };
        }

        const referenced = declarations.find(isJustificationElement);
        if (referenced) return elementTarget(referenced);

        // An element's id is a nested `QualifiedId`, so a leaf inside it reports *that* node as its
        // AST node and Langium's resolution above comes back empty. This is the declaration.
        const own = leaf.astNode;
        if (isQualifiedId(own)) return elementTarget(own.$container);
        return { kind: 'default' };
    }

    private leafAt(document: LangiumDocument, params: TextDocumentPositionParams): CstNode | undefined {
        const rootNode = document.parseResult.value.$cstNode;
        if (!rootNode) return undefined;
        const offset = document.textDocument.offsetAt(params.position);
        return CstUtils.findDeclarationNodeAtOffset(rootNode, offset, this.grammarConfig.nameRegexp);
    }

    /**
     * Whether `leaf` is the segment that names the target — always true on a declaration, and on a
     * reference only for the last segment, the earlier ones being namespace aliases.
     */
    private isFinalSegment(leaf: CstNode): boolean {
        let node: CstNode | undefined = leaf;
        while (node && !GrammarAST.isCrossReference(node.grammarSource)) {
            node = node.container;
        }
        if (!node) return true;
        const segments = segmentNodes(node);
        return segments.length <= 1 || segments.at(-1) === leaf;
    }

    /**
     * Every edit renaming a model requires, across the whole workspace.
     *
     * Documents are filtered by whether their text mentions the old name at all. That is not an
     * optimisation for its own sake: `prefixesFor` resolves a candidate's `load` statements from
     * disk, and a rename should not walk the import graph of every file in the workspace to
     * discover that most of them never say the word.
     */
    private renameModel(model: Justification | Template, newName: string): WorkspaceEdit | undefined {
        const nameNode = this.nameProvider.getNameNode(model);
        const home = getDocumentAndUnit(model).document;
        if (!model.id || !nameNode || !home) return undefined;

        const changes: Record<string, TextEdit[]> = {};
        collect(changes, home.uri.toString(), [TextEdit.replace(nameNode.range, newName)]);
        for (const candidate of this.candidatesFor(model, model.id)) {
            collect(changes, candidate.document.uri.toString(),
                qualifierEdits(candidate.unit, candidate.prefixes, newName));
        }
        return { changes };
    }

    /**
     * Every edit renaming an element requires, across the whole workspace.
     *
     * Two passes, because an override cannot be recognised from the document it sits in alone: the
     * first gathers every declaration that restates this one, the second rewrites those and every
     * relation reaching them.
     */
    private renameElement(element: JustificationElement, newName: string): WorkspaceEdit | undefined {
        const owner = ownerOf(element);
        const name = localName(element.id);
        if (!owner || !name) return undefined;

        const candidates = this.candidatesFor(owner, name);
        const affected = new Set<AstNode>([element]);
        for (const { unit, prefixes } of candidates) {
            for (const override of overridesIn(unit, prefixes, name)) affected.add(override);
        }

        const changes: Record<string, TextEdit[]> = {};
        for (const { document, unit, prefixes } of candidates) {
            collect(changes, document.uri.toString(),
                elementEdits(unit, prefixes, name, affected, newName));
        }
        return { changes };
    }

    /**
     * The open documents that could be talking about `model`, each with the spellings it can name
     * the model by. `mention` is the word whose absence rules a document out entirely.
     */
    private candidatesFor(model: Justification | Template, mention: string): Candidate[] {
        const candidates: Candidate[] = [];
        for (const document of this.services.shared.workspace.LangiumDocuments.all) {
            const unit = document.parseResult.value as Unit | undefined;
            if (!unit || !document.textDocument.getText().includes(mention)) continue;
            candidates.push({ document, unit, prefixes: this.prefixesFor(model, unit, document) });
        }
        return candidates;
    }

    /**
     * The spellings under which `unit` can name `model`: its bare id when the model is declared
     * here or loaded without an alias, and `alias:id` for each aliased `load` that reaches it.
     *
     * Matched by identity, not by name — a different model that happens to share the name is
     * exactly what must not be renamed alongside it.
     */
    private prefixesFor(model: Justification | Template, unit: Unit, document: LangiumDocument): NamePrefix[] {
        const prefixes = new Map<string, NamePrefix>();
        const remember = (prefix: NamePrefix) => prefixes.set(prefix.join(':'), prefix);

        if (unit.body.includes(model)) remember([model.id]);
        const imported = this.services.references.JpipeImportService
            .getJustificationsAndTemplatesWithNamespace(unit, document);
        for (const { node, ns } of imported) {
            if (node === model) remember(ns ? [ns, model.id] : [model.id]);
        }
        return [...prefixes.values()];
    }
}

function collect(changes: Record<string, TextEdit[]>, uri: string, edits: TextEdit[]): void {
    if (edits.length > 0) (changes[uri] ??= []).push(...edits);
}

function isModel(node: AstNode | undefined): node is Justification | Template {
    return isJustification(node) || isTemplate(node);
}

/** The justification or template an element is declared in. */
function ownerOf(element: JustificationElement): Justification | Template | undefined {
    const model = element.$container?.$container;
    return isModel(model) ? model : undefined;
}

/**
 * Whether an element can be renamed where it stands, or only where its name was introduced.
 *
 * A qualified id is a restatement of a name declared elsewhere. Renaming it here would have to
 * rename that declaration and every sibling restatement of it, from a position that reads like a
 * local edit — so this declines and says where the name lives instead.
 */
function elementTarget(element: JustificationElement): RenameTarget {
    const parts = element.id?.parts ?? [];
    if (parts.length <= 1) return { kind: 'element', element };
    return { kind: 'refuse', reason: refusalFor(element, parts) };
}

function refusalFor(element: JustificationElement, parts: readonly string[]): string {
    const source = sourceOf(element, parts.at(-1)!);
    const declaration = source
        ? `'${keywordFor(source.element)} ${qualifiedIdText(source.element.id)}' in template '${source.template.id}'`
        : `'${parts.at(-1)}' in template '${parts.at(-2)}'`;
    return `'${parts.join(':')}' restates ${declaration}, so its name belongs to the template. `
        + 'Rename it there and every model implementing the template follows.';
}

/** The declaration an override restates, looked up through the owner's `implements` chain. */
function sourceOf(
    element: JustificationElement,
    name: string
): { template: Template; element: JustificationElement } | undefined {
    const seen = new Set<Template>();
    let template = ownerOf(element)?.parent?.ref;
    while (template && !seen.has(template)) {
        seen.add(template);
        for (const candidate of template.contents?.body ?? []) {
            if (localName(candidate.id) === name) return { template, element: candidate };
        }
        template = template.parent?.ref;
    }
    return undefined;
}
