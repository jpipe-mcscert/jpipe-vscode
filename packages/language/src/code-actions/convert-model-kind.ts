/**
 * "Convert to template" / "Convert to justification" — switching what a model is.
 *
 * A template and a justification differ in one keyword and one rule: only a template may hold
 * `@support`. Going template → justification therefore loses those elements, and any relation
 * mentioning them. The title says so with a count rather than doing it quietly, because the
 * alternative is an action that looks like a rename and turns out to be a deletion.
 */
import { CodeActionKind, type CodeAction, type TextEdit } from 'vscode-languageserver';
import {
    isAbstractSupport,
    isJustification,
    isTemplate,
    type Justification,
    type Template
} from '../generated/ast.js';
import { deleteLinesEdit } from '../jpipe-edits.js';
import { getLocalElements, qualifiedIdText } from '../jpipe-utils.js';
import { refactoring, type JpipeActionContext } from './types.js';

export const convertModelKind = refactoring({
    id: 'convert-model-kind',
    actionKind: CodeActionKind.RefactorRewrite,

    create(context): CodeAction[] {
        const model = modelAtCursor(context);
        if (!model?.$cstNode) return [];

        // A composition's kind follows from its sources, so there is no keyword to switch.
        if (model.composition) return [];

        const start = model.$cstNode.range.start;
        const from = isTemplate(model) ? 'template' : 'justification';
        const to = isTemplate(model) ? 'justification' : 'template';
        const keywordEdit: TextEdit = {
            range: { start, end: { line: start.line, character: start.character + from.length } },
            newText: to
        };

        const uri = context.document.uri.toString();

        if (isJustification(model)) {
            return [{
                title: 'Convert to template',
                kind: CodeActionKind.RefactorRewrite,
                edit: { changes: { [uri]: [keywordEdit] } }
            }];
        }

        const abstracts = getLocalElements(model).filter(isAbstractSupport);
        const dropped = abstracts.map(element => qualifiedIdText(element.id));
        const droppedIds = new Set(dropped);

        const relations = (model.contents?.rels ?? []).filter(relation =>
            droppedIds.has(relation.from?.$refText) || droppedIds.has(relation.to?.$refText));

        const removals = [...abstracts, ...relations]
            .map(node => node.$cstNode)
            .filter(node => node !== undefined)
            .map(node => deleteLinesEdit(context.document, node.range.start.line, node.range.end.line));

        const title = dropped.length === 0
            ? 'Convert to justification'
            : `Convert to justification (drops ${dropped.length} @support ${dropped.length === 1 ? 'element' : 'elements'})`;

        return [{
            title,
            kind: CodeActionKind.RefactorRewrite,
            edit: { changes: { [uri]: [keywordEdit, ...removals] } }
        }];
    }
});

/** The justification or template the cursor is inside. */
function modelAtCursor(context: JpipeActionContext): Justification | Template | undefined {
    return context.unit.body.find(model => {
        const node = model.$cstNode;
        return node !== undefined
            && node.offset <= context.offsets.start
            && context.offsets.end <= node.end;
    });
}
