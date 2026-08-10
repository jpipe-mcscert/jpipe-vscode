/**
 * "Change to 'hook'" and "Remove config key 'hokk'" — repairing a config key the operator does
 * not understand.
 *
 * A misspelling is the common case, so a near match is offered first; removal is offered too,
 * since the other reason a key is unknown is that it no longer belongs.
 */
import { CodeActionKind, type CodeAction, type Position, type Range, type TextEdit } from 'vscode-languageserver';
import { isKeyValDecl } from '../generated/ast.js';
import { nodeForDiagnostic } from '../jpipe-ast-context.js';
import { JpipeIssue } from '../jpipe-diagnostic-codes.js';
import { nearestTo } from '../jpipe-text.js';
import { quickFix } from './types.js';

/** Beyond this, a "did you mean" is noise rather than help. */
const MAX_SUGGESTION_DISTANCE = 4;

export const fixConfigKey = quickFix<typeof JpipeIssue.UnknownConfigKey>({
    id: 'fix-config-key',
    codes: [JpipeIssue.UnknownConfigKey],

    create(context, diagnostic, data): CodeAction[] {
        let node = nodeForDiagnostic(context.document, diagnostic);
        while (node && !isKeyValDecl(node)) node = node.$container;
        if (!node?.$cstNode) return [];

        const entry = node;
        const actual = entry.key;
        if (data.allowed.includes(actual)) return [];

        const keyNode = context.document.textDocument;
        const offset = keyNode.getText().indexOf(actual, entry.$cstNode!.offset);
        if (offset < 0) return [];
        const keyRange = {
            start: keyNode.positionAt(offset),
            end: keyNode.positionAt(offset + actual.length)
        };

        const uri = context.document.uri.toString();
        const alreadyPresent = new Set(
            (entry.$container?.entries ?? []).filter(e => e !== entry).map(e => e.key)
        );

        const actions: CodeAction[] = nearestTo(actual, [...data.allowed], MAX_SUGGESTION_DISTANCE)
            // Renaming onto a key the block already sets would swap one problem for a duplicate.
            .filter(candidate => !alreadyPresent.has(candidate))
            .map((candidate, index) => ({
                title: `Change to '${candidate}'`,
                kind: CodeActionKind.QuickFix,
                isPreferred: index === 0,
                edit: { changes: { [uri]: [{ range: keyRange, newText: candidate }] } }
            }));

        // Removal deletes the entry's text, not its line: a config block written on one line
        // (`{ hook: "e" nope: "x" }`) would otherwise lose its siblings along with the entry.
        actions.push({
            title: `Remove config key '${actual}'`,
            kind: CodeActionKind.QuickFix,
            edit: { changes: { [uri]: [removalEdit(context.document, entry.$cstNode!.range)] } }
        });

        return actions;
    }
});

/**
 * Deletes an entry, taking its line with it when it has the line to itself and only its own text
 * otherwise, so a one-line config block keeps its shape and a multi-line one keeps no blank gap.
 */
function removalEdit(
    document: { textDocument: { getText(): string; positionAt(offset: number): Position } },
    range: Range
): TextEdit {
    const line = document.textDocument.getText().split('\n')[range.start.line] ?? '';
    const before = line.slice(0, range.start.character);
    const after = line.slice(range.end.character);
    const aloneOnItsLine = range.start.line === range.end.line
        && before.trim() === ''
        && after.trim() === '';

    if (aloneOnItsLine) {
        return {
            range: { start: { line: range.start.line, character: 0 }, end: { line: range.start.line + 1, character: 0 } },
            newText: ''
        };
    }
    // Take one adjoining space so `{ a: "1" b: "2" }` does not become `{ a: "1"  }`.
    const padded = after.startsWith(' ')
        ? { ...range, end: { line: range.end.line, character: range.end.character + 1 } }
        : range;
    return { range: padded, newText: '' };
}
