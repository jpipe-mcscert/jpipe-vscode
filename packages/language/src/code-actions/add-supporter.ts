/**
 * "Add a strategy supporting 'c'" — giving an unsupported element something to stand on.
 *
 * A conclusion needs a strategy under it and a strategy needs evidence; both are two lines, a
 * declaration and a relation, and both are tedious enough by hand that the argument tends to be
 * left half-wired. The label is left empty on purpose — it is the one part the author has to
 * write, and an invented placeholder would read as though the model already said something.
 */
import { CodeActionKind, type CodeAction } from 'vscode-languageserver';
import {
    isConclusion,
    isJustification,
    isStrategy,
    isTemplate,
    type Justification,
    type JustificationElement,
    type Template
} from '../generated/ast.js';
import { nodeForDiagnostic } from '../jpipe-ast-context.js';
import { findElementInsertion, findRelationInsertion, insertAfterEdit } from '../jpipe-edits.js';
import { JpipeIssue } from '../jpipe-diagnostic-codes.js';
import { freshLocalId, renderElement, renderRelation, type ElementKeyword } from '../jpipe-render.js';
import { qualifiedIdText } from '../jpipe-utils.js';
import { quickFix, type JpipeActionContext } from './types.js';

export const addSupporter = quickFix<
    typeof JpipeIssue.ConclusionSupported
    | typeof JpipeIssue.StrategySupported
>({
    id: 'add-supporter',
    codes: [
        JpipeIssue.ConclusionSupported,
        JpipeIssue.StrategySupported
    ],

    create(context, diagnostic, data): CodeAction[] {
        const element = elementFor(context, diagnostic);
        if (!element || qualifiedIdText(element.id) !== data.targetId) return [];

        const owner = ownerOf(element);
        if (!owner) return [];

        const declarationAt = findElementInsertion(context.document, owner);
        const relationAt = findRelationInsertion(context.document, owner);
        if (!declarationAt || !relationAt) return [];

        // A conclusion may only be supported by a strategy; a strategy by evidence or a
        // sub-conclusion. Evidence comes first because it ends the chain rather than extending it.
        const candidates: readonly ElementKeyword[] = isConclusion(element)
            ? ['strategy']
            : ['evidence', 'sub-conclusion'];

        const targetId = qualifiedIdText(element.id);
        const samePlace = declarationAt.position.line === relationAt.position.line
            && declarationAt.position.character === relationAt.position.character;

        return candidates.map((keyword, index) => {
            const id = freshLocalId(owner, stemFor(keyword));
            const declaration = renderElement(keyword, id, '');
            const relation = renderRelation(id, targetId);

            // With no relations yet, both anchor to the same spot. Two zero-width edits at one
            // position have no defined order between them, so they become one.
            const edits = samePlace
                ? [insertAfterEdit(declarationAt, [declaration, relation])]
                : [
                    insertAfterEdit(declarationAt, [declaration]),
                    insertAfterEdit(relationAt, [relation])
                ];

            return {
                title: `Add ${article(keyword)} ${keyword} supporting '${targetId}'`,
                kind: CodeActionKind.QuickFix,
                isPreferred: index === 0,
                edit: { changes: { [context.document.uri.toString()]: edits } }
            };
        });
    }
});

/** Single-letter stems matching the convention the examples use. */
const STEMS: Record<ElementKeyword, string> = {
    evidence: 'e',
    strategy: 's',
    'sub-conclusion': 'sc',
    // Unreachable today: a conclusion is never offered as a supporter. Present because the
    // record is total over the keyword type, which is what stops a new keyword compiling.
    conclusion: 'c'
};

function stemFor(keyword: ElementKeyword): string {
    return STEMS[keyword];
}

function article(keyword: ElementKeyword): string {
    return keyword === 'evidence' ? 'some' : 'a';
}

function elementFor(
    context: JpipeActionContext,
    diagnostic: Parameters<typeof nodeForDiagnostic>[1]
): JustificationElement | undefined {
    const node = nodeForDiagnostic(context.document, diagnostic);
    const candidate = node && (isConclusion(node) || isStrategy(node)) ? node : node?.$container;
    return candidate && (isConclusion(candidate) || isStrategy(candidate)) ? candidate : undefined;
}

function ownerOf(element: JustificationElement): Justification | Template | undefined {
    const owner = element.$container?.$container;
    return owner && (isJustification(owner) || isTemplate(owner)) ? owner : undefined;
}


