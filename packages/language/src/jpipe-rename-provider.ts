import { CstUtils, type LangiumDocument, type MaybePromise } from 'langium';
import { DefaultRenameProvider } from 'langium/lsp';
import type { Range, RenameParams, TextDocumentPositionParams, WorkspaceEdit } from 'vscode-languageserver';
import { isAbstractSupport, isJustificationElement } from './generated/ast.js';
import type { JpipeServices } from './jpipe-module.js';

/**
 * Rename, restricted to the identifiers it can rewrite correctly.
 *
 * Renaming a *qualified* element is not the same edit as renaming a plain one. An element
 * declared `T:abs` overrides `@support abs` in template `T`, and the scope provider registers it
 * under three keys at once — the namespaced key, the qualifier-only key, and an unambiguous short
 * alias — so its references appear in the source under three different spellings. On top of that,
 * an override in an implementing justification is a *declaration* matched to its `@support` by
 * string, not a cross-reference, so nothing in the index links the two and a workspace scan is
 * needed to find them.
 *
 * `DefaultRenameProvider` knows none of this: it replaces each reference's whole segment with the
 * new name, which turns `T:abs` into `newname` and quietly stops the element from overriding
 * anything. Until a rename that understands qualified ids lands, this refuses those renames
 * rather than performing them wrongly — an editor saying "cannot rename" is recoverable, a
 * rename that half-applies is not.
 *
 * Unqualified names — justifications, templates, and elements declared with a single-segment id —
 * are handled correctly by the default implementation and are passed straight through.
 */
export class JpipeRenameProvider extends DefaultRenameProvider {

    constructor(services: JpipeServices) {
        super(services);
    }

    override prepareRename(document: LangiumDocument, params: TextDocumentPositionParams): MaybePromise<Range | undefined> {
        if (this.targetIsQualified(document, params)) return undefined;
        return super.prepareRename(document, params);
    }

    override async rename(document: LangiumDocument, params: RenameParams): Promise<WorkspaceEdit | undefined> {
        // Guarded as well as `prepareRename`: a client may send `textDocument/rename` without
        // having asked to prepare it first, and this is the request that actually edits.
        if (this.targetIsQualified(document, params)) return undefined;
        return super.rename(document, params);
    }

    /**
     * Whether the declaration under the cursor is an element carrying a multi-segment id.
     *
     * Resolved through the same path the default provider uses, so the answer describes the node
     * that would actually be renamed rather than whatever the cursor happens to sit on.
     */
    private targetIsQualified(document: LangiumDocument, params: TextDocumentPositionParams): boolean {
        const rootNode = document.parseResult.value.$cstNode;
        if (!rootNode) return false;
        const offset = document.textDocument.offsetAt(params.position);
        const leaf = CstUtils.findDeclarationNodeAtOffset(rootNode, offset, this.grammarConfig.nameRegexp);
        if (!leaf) return false;

        const candidates = [
            ...this.references.findDeclarations(leaf),
            // A declaration's own name node is not a reference, so `findDeclarations` may come
            // back empty; the node under the cursor is then the declaration itself.
            leaf.astNode
        ];
        return candidates.some(node =>
            (isJustificationElement(node) || isAbstractSupport(node)) && node.id.parts.length > 1
        );
    }
}
