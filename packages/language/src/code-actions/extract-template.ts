/**
 * "Extract template from 'J'" — turning a concrete argument into a reusable one.
 *
 * The shape of the argument is the reusable part: the conclusion, the strategies beneath it, and
 * the relations wiring them together. What makes it *this* argument rather than another is the
 * evidence at the leaves — so the extracted template keeps the structure and turns each leaf into
 * an `@support`, the slot a justification must fill.
 *
 * The justification is then rewritten to implement the template, keeping only its evidence, each
 * requalified to the id the template now demands. Its structure is gone from the file because the
 * template holds it; that is the point of extracting.
 *
 * Only leaf evidence becomes a slot. Evidence supporting something that in turn supports
 * something else is still evidence, but it sits inside the structure rather than under it, and
 * abstracting it would leave a template whose shape no implementer could complete.
 */
import { CodeActionKind, type CodeAction } from 'vscode-languageserver';
import {
    isEvidence,
    isJustification,
    type Justification,
    type JustificationElement,
    type Relation
} from '../generated/ast.js';
import { indentationOf } from '../jpipe-edits.js';
import { keywordFor, renderElement, renderRelation } from '../jpipe-render.js';
import { getLocalElements, qualifiedIdText } from '../jpipe-utils.js';
import { refactoring, type JpipeActionContext } from './types.js';

/** This action's own kind, so a command can ask for it by name. See `convert-model-kind`. */
export const EXTRACT_TEMPLATE_KIND = `${CodeActionKind.RefactorExtract}.jpipe.template`;

export const extractTemplate = refactoring({
    id: 'extract-template',
    actionKind: EXTRACT_TEMPLATE_KIND,

    create(context): CodeAction[] {
        const justification = justificationAtCursor(context);
        if (!justification?.$cstNode || justification.composition) return [];

        // Extracting from a model that already implements one would have to merge two templates.
        if (justification.parent) return [];

        const elements = getLocalElements(justification);
        const relations = justification.contents?.rels ?? [];
        const leaves = leafEvidence(elements, relations);
        if (leaves.length === 0) return [];
        // Nothing is left to abstract if every element is a leaf.
        if (leaves.length === elements.length) return [];

        const templateId = `${justification.id}Template`;
        const leafIds = new Set(leaves.map(element => qualifiedIdText(element.id)));

        const indent = indentationOf(context.document, justification.$cstNode.range.start.line);
        const inner = `${indent}    `;

        const templateBody = [
            ...elements.map(element => {
                const id = qualifiedIdText(element.id);
                return leafIds.has(id)
                    ? renderElement('@support', id, element.name)
                    : renderElement(keywordFor(element), id, element.name);
            }),
            ...relations
                .filter(relation => relation.from?.$refText && relation.to?.$refText)
                .map(relation => renderRelation(relation.from.$refText, relation.to.$refText))
        ];

        const template = [
            `${indent}template ${templateId} {`,
            ...templateBody.map(line => `${inner}${line}`),
            `${indent}}`,
            ''
        ].join('\n');

        const rewritten = [
            `${indent}justification ${justification.id} implements ${templateId} {`,
            ...leaves.map(element =>
                `${inner}${renderElement('evidence', `${templateId}:${qualifiedIdText(element.id)}`, element.name)}`),
            `${indent}}`
        ].join('\n');

        return [{
            title: `Extract template from '${justification.id}'`,
            kind: EXTRACT_TEMPLATE_KIND,
            edit: {
                changes: {
                    [context.document.uri.toString()]: [{
                        range: justification.$cstNode.range,
                        newText: `${template}${rewritten}`
                    }]
                }
            }
        }];
    }
});

/**
 * Evidence that supports something but is supported by nothing — the bottom of the argument.
 *
 * Evidence with something beneath it is part of the structure rather than a slot in it, and
 * abstracting it would produce a template no implementer could complete: an `@support` may only
 * be refined by an evidence or a sub-conclusion, never by something with its own sub-argument.
 */
function leafEvidence(
    elements: readonly JustificationElement[],
    relations: readonly Relation[]
): JustificationElement[] {
    const supported = new Set(relations.map(relation => relation.to?.$refText).filter(Boolean));
    return elements.filter(element =>
        isEvidence(element) && !supported.has(qualifiedIdText(element.id)));
}

function justificationAtCursor(context: JpipeActionContext): Justification | undefined {
    const model = context.unit.body.find(candidate => {
        const node = candidate.$cstNode;
        return node !== undefined
            && node.offset <= context.offsets.start
            && context.offsets.end <= node.end;
    });
    return model && isJustification(model) ? model : undefined;
}
