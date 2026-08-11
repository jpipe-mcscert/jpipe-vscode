/**
 * Locating the document and the AST node a request is really about.
 *
 * Pure functions over an AST and a document — no services — so a code action, a scope provider
 * and a symbol provider can all reach for the same answer.
 */
import { CstUtils, type AstNode, type LangiumDocument } from 'langium';
import type { Diagnostic } from 'vscode-languageserver';
import type { Unit } from './generated/ast.js';

/**
 * Returns the document owning `node` and that document's `Unit`.
 *
 * Prefers the `$document` stamped on the node and walks the container chain only if it is
 * missing. The walk is not defensive padding: `JpipeImportService.parseDocumentFromPath` parses
 * a file into an ad-hoc document that is never registered with the workspace and stamps
 * `$document` on every node itself, and `AstUtils.getDocument` throws on nodes reached that way.
 * Callers handed a node from an imported file therefore depend on this fallback.
 */
export function getDocumentAndUnit(node: AstNode): {
    document: LangiumDocument | undefined;
    unit: Unit | undefined;
} {
    let current: AstNode | undefined = node;
    let document: LangiumDocument | undefined;
    while (current && !document) {
        document = (current as { $document?: LangiumDocument }).$document;
        current = current.$container;
    }
    return { document, unit: document?.parseResult?.value as Unit | undefined };
}

/**
 * Returns the AST node a diagnostic points at, or `undefined` if its range no longer resolves.
 *
 * Diagnostics arrive back from the client as the client last saw them, which may be several
 * keystrokes stale. Re-anchoring through the current CST is what lets a code action notice that
 * and decline, rather than editing whatever now sits at those coordinates.
 */
export function nodeForDiagnostic(document: LangiumDocument, diagnostic: Diagnostic): AstNode | undefined {
    const root = document.parseResult.value.$cstNode;
    if (!root) return undefined;
    const offset = document.textDocument.offsetAt(diagnostic.range.start);
    return CstUtils.findLeafNodeAtOffset(root, offset)?.astNode;
}

