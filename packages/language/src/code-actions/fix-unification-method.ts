/**
 * "Change to 'sameLabel'" — for a `unifyBy` naming a relation nobody here has heard of.
 *
 * The warning it answers is deliberately not an error: a build may register relations shipped
 * with neither jPipe core nor this extension. So the fix offers the names that *are* known rather
 * than insisting one of them is right, and there is no removal option — dropping the key silently
 * changes which elements get unified, which is a decision rather than a repair.
 */
import { CodeActionKind, type CodeAction } from 'vscode-languageserver';
import { isKeyValDecl } from '../generated/ast.js';
import { nodeForDiagnostic } from '../jpipe-ast-context.js';
import { JpipeIssue } from '../jpipe-diagnostic-codes.js';
import { nearestTo } from '../jpipe-text.js';
import { quickFix } from './types.js';

/** Past this a suggestion is a different word rather than a correction, so all names are offered. */
const NEAR = 4;

export const fixUnificationMethod = quickFix<typeof JpipeIssue.UnknownUnificationMethod>({
    id: 'fix-unification-method',
    codes: [JpipeIssue.UnknownUnificationMethod],

    create(context, diagnostic, data): CodeAction[] {
        let node = nodeForDiagnostic(context.document, diagnostic);
        while (node && !isKeyValDecl(node)) node = node.$container;
        if (!node?.$cstNode || node.value !== data.actual) return [];

        // The value sits inside quotes; replace what is between them and leave them alone.
        const text = context.document.textDocument;
        const offset = text.getText().indexOf(data.actual, node.$cstNode.offset);
        if (offset < 0) return [];
        const range = {
            start: text.positionAt(offset),
            end: text.positionAt(offset + data.actual.length)
        };

        // Near matches first, since a typo is the likeliest cause; then the rest, so a project
        // whose relation is genuinely absent can still see what this workspace does know.
        const near = nearestTo(data.actual, [...data.known], NEAR);
        const ordered = [...near, ...data.known.filter(name => !near.includes(name))];

        return ordered.map((name, index) => ({
            title: `Change to '${name}'`,
            kind: CodeActionKind.QuickFix,
            isPreferred: index === 0 && near.length > 0,
            edit: { changes: { [context.document.uri.toString()]: [{ range, newText: name }] } }
        }));
    }
});
