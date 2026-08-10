import { CstUtils, GrammarAST, type AstNode, type CstNode, type LangiumDocument, type MaybePromise } from 'langium';
import { DefaultRenameProvider } from 'langium/lsp';
import { TextEdit } from 'vscode-languageserver-types';
import type { Range, RenameParams, TextDocumentPositionParams, WorkspaceEdit } from 'vscode-languageserver';
import {
    isJustification,
    isJustificationElement,
    isTemplate,
    type Justification,
    type Template,
    type Unit
} from './generated/ast.js';
import type { JpipeServices } from './jpipe-module.js';
import { getDocumentAndUnit } from './jpipe-ast-context.js';
import { qualifierEdits, segmentNodes, type NamePrefix } from './jpipe-qualified-names.js';

/** What the cursor is asking to rename. */
type RenameTarget =
    /** A justification or template, which needs the qualified-name-aware rewrite below. */
    | { readonly kind: 'model'; readonly model: Justification | Template }
    /** Something this provider would not rename correctly, and so declines to rename at all. */
    | { readonly kind: 'refuse' }
    /** A plain element name, which `DefaultRenameProvider` already handles. */
    | { readonly kind: 'default' };

/**
 * Rename, taught the two things this grammar does that a reference-following rename cannot see.
 *
 * **A model's name outlives its references.** An element declared `T:abs` overrides `@support abs`
 * in template `T`, and that link is made by *string comparison* against the text written after
 * `implements` — no cross-reference exists between the override and the template. Relations in the
 * same body then say `T:abs` too. Rewriting only the declaration and the `implements` reference
 * therefore produces a justification implementing `NewName` whose every element still claims to
 * override something in `T`, which is a worse state than the one the user started in.
 * `jpipe-qualified-names.ts` finds those occurrences; this provider decides which documents to
 * look in and under which spellings the model can be named there.
 *
 * **A reference is not always one word.** `implements lib:T` is a single cross-reference whose text
 * is `lib:T`, and the default provider replaces the whole of it — dropping the namespace and
 * unresolving the very reference it was asked to keep working. Only the segment naming the model
 * is rewritten here.
 *
 * **Qualified *elements* are still refused.** Renaming `T:abs` means renaming the `@support` it
 * overrides and every sibling override across the workspace, and the scope provider registers each
 * element under three keys at once, so its usages appear under three different spellings. Until
 * that lands, refusing is recoverable where a half-applied rename is not.
 */
export class JpipeRenameProvider extends DefaultRenameProvider {

    private readonly services: JpipeServices;

    constructor(services: JpipeServices) {
        super(services);
        this.services = services;
    }

    override prepareRename(document: LangiumDocument, params: TextDocumentPositionParams): MaybePromise<Range | undefined> {
        if (this.resolveTarget(document, params).kind === 'refuse') return undefined;
        return super.prepareRename(document, params);
    }

    override async rename(document: LangiumDocument, params: RenameParams): Promise<WorkspaceEdit | undefined> {
        // Guarded as well as `prepareRename`: a client may send `textDocument/rename` without
        // having asked to prepare it first, and this is the request that actually edits.
        const target = this.resolveTarget(document, params);
        if (target.kind === 'refuse') return undefined;
        if (target.kind === 'model') return this.renameModel(target.model, params.newName);
        return super.rename(document, params);
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
        // covers both renaming from a usage and renaming from the declaration.
        const declarations = this.references.findDeclarations(leaf);

        const model = declarations.find(isModel);
        if (model) {
            // `implements lib:T` names the template with its *last* segment; a cursor on `lib` is
            // asking to rename the load's alias, which is not a linked name and not this request.
            return this.isFinalSegment(leaf) ? { kind: 'model', model } : { kind: 'refuse' };
        }
        if (declarations.some(isQualifiedElement) || isQualifiedElement(leaf.astNode)) {
            return { kind: 'refuse' };
        }
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
     * Every edit renaming `model` requires, across the whole workspace.
     *
     * Documents are filtered by whether their text mentions the old name at all. That is not an
     * optimisation for its own sake: `prefixesFor` resolves a candidate's `load` statements from
     * disk, and a rename should not walk the import graph of every file in the workspace to
     * discover that most of them never say the word.
     */
    private renameModel(model: Justification | Template, newName: string): WorkspaceEdit | undefined {
        const oldName = model.id;
        const nameNode = this.nameProvider.getNameNode(model);
        const home = getDocumentAndUnit(model).document;
        if (!oldName || !nameNode || !home) return undefined;

        const changes: Record<string, TextEdit[]> = {};
        const add = (uri: string, edits: TextEdit[]) => {
            if (edits.length > 0) (changes[uri] ??= []).push(...edits);
        };

        add(home.uri.toString(), [TextEdit.replace(nameNode.range, newName)]);

        for (const document of this.services.shared.workspace.LangiumDocuments.all) {
            const unit = document.parseResult.value as Unit | undefined;
            if (!unit || !document.textDocument.getText().includes(oldName)) continue;
            add(document.uri.toString(), qualifierEdits(unit, this.prefixesFor(model, unit, document), newName));
        }

        return { changes };
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

function isModel(node: AstNode | undefined): node is Justification | Template {
    return isJustification(node) || isTemplate(node);
}

/** An element declared with a multi-segment id — the case rename still declines. */
function isQualifiedElement(node: AstNode | undefined): boolean {
    return isJustificationElement(node)
        && ((node as { id?: { parts?: string[] } }).id?.parts?.length ?? 0) > 1;
}
