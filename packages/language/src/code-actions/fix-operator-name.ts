/**
 * "Change to 'refine'" — correcting a misspelled composition operator.
 *
 * There are only two operators, so the repair is always one of them; the nearer of the two by
 * edit distance is offered first and preferred, which makes a typo a single keystroke to undo.
 */
import { CodeActionKind, type CodeAction } from 'vscode-languageserver';
import { isComposition } from '../generated/ast.js';
import { nodeForDiagnostic } from '../jpipe-ast-context.js';
import { JpipeIssue } from '../jpipe-diagnostic-codes.js';
import { isKnownOperator } from '../jpipe-operators.js';
import { editDistance } from '../jpipe-text.js';
import { quickFix } from './types.js';

export const fixOperatorName = quickFix<typeof JpipeIssue.UnknownOperator>({
    id: 'fix-operator-name',
    codes: [JpipeIssue.UnknownOperator],

    create(context, diagnostic, data): CodeAction[] {
        let node = nodeForDiagnostic(context.document, diagnostic);
        while (node && !isComposition(node)) node = node.$container;
        if (!node) return [];

        // Re-read from the document: the payload describes the operator as it was written when
        // the diagnostic was published.
        const actual = node.operator;
        if (isKnownOperator(actual)) return [];

        const operatorNode = node.$cstNode;
        if (!operatorNode) return [];
        // `is <operator>(` — the operator token is the one bearing the name.
        const offset = context.document.textDocument.getText().indexOf(actual, operatorNode.offset);
        if (offset < 0) return [];
        const range = {
            start: context.document.textDocument.positionAt(offset),
            end: context.document.textDocument.positionAt(offset + actual.length)
        };

        const ranked = [...data.known].sort((a, b) => editDistance(actual, a) - editDistance(actual, b));

        return ranked.map((operator, index) => ({
            title: `Change to '${operator}'`,
            kind: CodeActionKind.QuickFix,
            isPreferred: index === 0,
            edit: { changes: { [context.document.uri.toString()]: [{ range, newText: operator }] } }
        }));
    }
});
