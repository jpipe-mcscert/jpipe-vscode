/**
 * "Remove this load" — for a `load` that cannot be kept.
 *
 * A circular load is a file loading itself, usually through a pattern wide enough to match its
 * own name; there is nothing to correct, so removal is the only repair. An unresolvable path is
 * offered removal as well, alongside whatever corrections `fix-load-path` can suggest.
 *
 * A malformed pattern is included because otherwise it is the one broken load with nothing at all
 * offered for it: no file can be suggested for a pattern that does not compile.
 */
import { CodeActionKind, type CodeAction } from 'vscode-languageserver';
import { isLoad } from '../generated/ast.js';
import { nodeForDiagnostic } from '../jpipe-ast-context.js';
import { deleteLinesEdit } from '../jpipe-edits.js';
import { JpipeIssue } from '../jpipe-diagnostic-codes.js';
import { quickFix } from './types.js';

export const removeLoad = quickFix<
    typeof JpipeIssue.LoadCircular
    | typeof JpipeIssue.LoadUnresolved
    | typeof JpipeIssue.LoadNoMatch
    | typeof JpipeIssue.LoadMalformedPattern
>({
    id: 'remove-load',
    codes: [
        JpipeIssue.LoadCircular,
        JpipeIssue.LoadUnresolved,
        JpipeIssue.LoadNoMatch,
        JpipeIssue.LoadMalformedPattern
    ],

    create(context, diagnostic, data): CodeAction[] {
        let node = nodeForDiagnostic(context.document, diagnostic);
        while (node && !isLoad(node)) node = node.$container;
        if (!node?.$cstNode) return [];
        // The path may have been edited since the diagnostic was published.
        if (node.path !== data.path) return [];

        const range = node.$cstNode.range;
        return [{
            title: `Remove load '${node.path}'`,
            kind: CodeActionKind.QuickFix,
            // Circular is the one case where removal is the whole answer rather than a fallback.
            isPreferred: data.code === JpipeIssue.LoadCircular,
            edit: {
                changes: {
                    [context.document.uri.toString()]: [
                        deleteLinesEdit(context.document, range.start.line, range.end.line)
                    ]
                }
            }
        }];
    }
});
