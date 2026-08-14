/**
 * "Change 'strategy' to 'evidence'" — repairing an override declared with the wrong keyword.
 *
 * An `@support` may only be refined by an `evidence` or a `sub-conclusion`. Getting that wrong is
 * a one-word mistake with a one-word repair, so the fix replaces the leading keyword and leaves
 * the id and label exactly as the author wrote them.
 */
import { CodeActionKind, type CodeAction } from 'vscode-languageserver';
import { isJustificationElement } from '../generated/ast.js';
import { nodeForDiagnostic } from '../jpipe-ast-context.js';
import { JpipeIssue } from '../jpipe-diagnostic-codes.js';
import { keywordFor } from '../jpipe-render.js';
import { quickFix, type JpipeActionContext } from './types.js';

export const fixOverrideType = quickFix<typeof JpipeIssue.SupportOverrideType>({
    id: 'fix-override-type',
    codes: [JpipeIssue.SupportOverrideType],

    create(context, diagnostic, data): CodeAction[] {
        const element = elementFor(context, diagnostic);
        if (!element) return [];

        // The keyword is the element's first token; everything after it stays untouched.
        const declaration = element.$cstNode;
        if (!declaration) return [];
        const actual = keywordFor(element);
        const start = declaration.range.start;
        const keywordRange = {
            start,
            end: { line: start.line, character: start.character + actual.length }
        };

        // Re-derived from the element rather than taken from `data.actualKeyword`, which may
        // describe a keyword the user has since changed.
        if (actual === 'evidence' || actual === 'sub-conclusion') return [];

        return data.allowedKeywords.map((keyword, index) => ({
            title: `Change '${actual}' to '${keyword}'`,
            kind: CodeActionKind.QuickFix,
            // `evidence` is listed first and needs nothing else added to the model to be valid,
            // so ⌘. followed by Enter picks it.
            isPreferred: index === 0,
            edit: {
                changes: {
                    [context.document.uri.toString()]: [{ range: keywordRange, newText: keyword }]
                }
            }
        }));
    }
});

/** The element the diagnostic sits on, or `undefined` if its range no longer names one. */
function elementFor(context: JpipeActionContext, diagnostic: Parameters<typeof nodeForDiagnostic>[1]) {
    const node = nodeForDiagnostic(context.document, diagnostic);
    // The diagnostic is anchored on the element's `id`, which is a QualifiedId, so the element is
    // its container.
    const candidate = node && isJustificationElement(node) ? node : node?.$container;
    return candidate && isJustificationElement(candidate) ? candidate : undefined;
}
