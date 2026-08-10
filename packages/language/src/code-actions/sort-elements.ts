/**
 * "Sort elements" — putting a model's declarations into the order its argument is read in.
 *
 * The conclusion first, then a depth-first walk down through what supports it: each strategy
 * beneath the claim it serves, each piece of evidence beneath the strategy it feeds. That is how
 * the language's own examples are written, and it means reading the declarations top to bottom
 * follows one branch of the argument to its ground before starting the next.
 *
 * Grouping by kind instead — every evidence, then every strategy — puts each element next to
 * others it has nothing to do with, and scatters a single line of reasoning across the model.
 *
 * A blank line goes before each sub-conclusion, because that is where one sub-argument ends and
 * the next begins — the only points in the list where the reader is moving between branches
 * rather than down one. Laying the block out is part of the same job as ordering it, so the
 * action is offered when only the spacing is missing.
 *
 * Anything the walk cannot reach keeps its relative order at the end: an element supporting
 * nothing is usually one being written, and moving it while it is half-typed would be unhelpful.
 *
 * Relations are untouched. They name their endpoints, so their position carries no meaning.
 */
import { CodeActionKind, type CodeAction } from 'vscode-languageserver';
import { isConclusion, isSubConclusion, type Justification, type JustificationElement, type Relation, type Template } from '../generated/ast.js';
import { indentationOf } from '../jpipe-edits.js';
import { getLocalElements } from '../jpipe-utils.js';
import { refactoring, type JpipeActionContext } from './types.js';

/** This action's own kind, so a command can ask for it by name. See `convert-model-kind`. */
export const SORT_ELEMENTS_KIND = `${CodeActionKind.RefactorRewrite}.jpipe.sortElements`;

export const sortElements = refactoring({
    id: 'sort-elements',
    actionKind: SORT_ELEMENTS_KIND,

    create(context): CodeAction[] {
        const model = modelAtCursor(context);
        if (!model) return [];

        const elements = getLocalElements(model);
        if (elements.length < 2) return [];
        if (!elements.every(element => element.$cstNode)) return [];

        // Only a run of declarations with nothing but whitespace between them can be rewritten as
        // a block; a comment among them belongs to the line it sits above.
        if (!isContiguous(context, elements)) return [];

        const sorted = argumentOrder(elements, model.contents?.rels ?? []);

        const start = elements[0].$cstNode!.range.start;
        const end = elements.at(-1)!.$cstNode!.range.end;
        const indent = indentationOf(context.document, start.line);
        const rendered = render(context, sorted, indent);

        // Compared as text rather than as an order, so the action is also offered when the
        // declarations are already in sequence but the branches are not spaced apart.
        if (rendered === context.document.textDocument.getText({ start, end })) return [];

        return [{
            title: 'Sort elements',
            kind: SORT_ELEMENTS_KIND,
            edit: {
                changes: {
                    [context.document.uri.toString()]: [{ range: { start, end }, newText: rendered }]
                }
            }
        }];
    }
});


/**
 * The declarations as one block: one per line, with a blank line opening each sub-argument.
 *
 * The first element carries the indentation already present in the document, since the range
 * being replaced starts at it.
 */
function render(
    context: JpipeActionContext,
    elements: readonly JustificationElement[],
    indent: string
): string {
    return elements
        .map((element, index) => {
            const text = context.document.textDocument.getText(element.$cstNode!.range);
            if (index === 0) return text;
            // The blank line goes before the indent, so it holds no trailing whitespace.
            return `${isSubConclusion(element) ? '\n' : ''}${indent}${text}`;
        })
        .join('\n');
}

/**
 * The elements in argument order: each conclusion, then everything that supports it, depth first.
 *
 * Supporters are visited in the order they are currently declared, so a model already in a
 * sensible order is not churned into a different one. The `seen` set is doing real work — a
 * support cycle is invalid but entirely writable, and a model in that state is one somebody is
 * still editing.
 */
function argumentOrder(
    elements: readonly JustificationElement[],
    relations: readonly Relation[]
): JustificationElement[] {
    const local = new Set(elements);
    const position = new Map(elements.map((element, index) => [element, index]));

    // Resolved endpoints rather than their written text: a relation may name an element by a
    // short alias, and `$refText` would not match the declaration's qualified id.
    const supporters = new Map<JustificationElement, JustificationElement[]>();
    for (const relation of relations) {
        const to = relation.to?.ref;
        const from = relation.from?.ref;
        if (!to || !from || !local.has(to) || !local.has(from)) continue;
        const existing = supporters.get(to);
        if (existing) existing.push(from);
        else supporters.set(to, [from]);
    }

    const seen = new Set<JustificationElement>();
    const ordered: JustificationElement[] = [];
    const visit = (element: JustificationElement): void => {
        if (seen.has(element)) return;
        seen.add(element);
        ordered.push(element);
        const beneath = [...(supporters.get(element) ?? [])]
            .sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
        for (const supporter of beneath) visit(supporter);
    };

    // Every conclusion is a root. There should be one, but a model with two is writable and
    // parses, and sorting should not be the thing that objects to it.
    for (const element of elements) {
        if (isConclusion(element)) visit(element);
    }
    for (const element of elements) {
        if (!seen.has(element)) ordered.push(element);
    }
    return ordered;
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
