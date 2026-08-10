/**
 * "Sort elements" — putting a model's declarations into reading order.
 *
 * Evidence, then strategies, then sub-conclusions, then the conclusion: the order the argument is
 * read in, from what is known towards what is claimed. Order within a group is left alone, since
 * the author's sequence there usually means something.
 *
 * Relations are untouched. They name their endpoints, so their position carries no meaning and
 * moving them would be churn.
 */
import { CodeActionKind, type CodeAction } from 'vscode-languageserver';
import type { Justification, JustificationElement, Template } from '../generated/ast.js';
import { indentationOf } from '../jpipe-edits.js';
import { keywordFor, type AnyElementKeyword } from '../jpipe-render.js';
import { getLocalElements } from '../jpipe-utils.js';
import { refactoring, type JpipeActionContext } from './types.js';

/** Reading order: the grounds first, the claim last. */
const ORDER: readonly AnyElementKeyword[] = [
    'evidence',
    '@support',
    'strategy',
    'sub-conclusion',
    'conclusion'
];

export const sortElements = refactoring({
    id: 'sort-elements',
    actionKind: CodeActionKind.RefactorRewrite,

    create(context): CodeAction[] {
        const model = modelAtCursor(context);
        if (!model) return [];

        const elements = getLocalElements(model);
        if (elements.length < 2) return [];
        if (!elements.every(element => element.$cstNode)) return [];

        // Only a run of declarations with nothing but whitespace between them can be rewritten as
        // a block; a comment among them belongs to the line it sits above.
        if (!isContiguous(context, elements)) return [];

        const sorted = [...elements].sort((a, b) => rank(a) - rank(b));
        if (sorted.every((element, index) => element === elements[index])) return [];

        const start = elements[0].$cstNode!.range.start;
        const end = elements.at(-1)!.$cstNode!.range.end;
        const indent = indentationOf(context.document, start.line);
        const rendered = sorted
            .map(element => context.document.textDocument.getText(element.$cstNode!.range))
            .join(`\n${indent}`);

        return [{
            title: 'Sort elements',
            kind: CodeActionKind.RefactorRewrite,
            edit: {
                changes: {
                    [context.document.uri.toString()]: [{ range: { start, end }, newText: rendered }]
                }
            }
        }];
    }
});

function rank(element: JustificationElement): number {
    const index = ORDER.indexOf(keywordFor(element));
    return index < 0 ? ORDER.length : index;
}

function isContiguous(context: JpipeActionContext, elements: readonly JustificationElement[]): boolean {
    for (let i = 1; i < elements.length; i++) {
        const between = context.document.textDocument.getText({
            start: elements[i - 1].$cstNode!.range.end,
            end: elements[i].$cstNode!.range.start
        });
        if (between.trim() !== '') return false;
    }
    return true;
}

function modelAtCursor(context: JpipeActionContext): Justification | Template | undefined {
    return context.unit.body.find(model => {
        const node = model.$cstNode;
        return node !== undefined
            && node.offset <= context.offsets.start
            && context.offsets.end <= node.end;
    });
}
