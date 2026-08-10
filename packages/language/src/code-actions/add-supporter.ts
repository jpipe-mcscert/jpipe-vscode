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
import { findElementInsertion, indentationOf, insertLinesEdit } from '../jpipe-edits.js';
import { JpipeIssue } from '../jpipe-diagnostic-codes.js';
import { freshLocalId, renderElement, renderRelation, type ElementKeyword } from '../jpipe-render.js';
import { qualifiedIdText } from '../jpipe-utils.js';
import { quickFix, type JpipeActionContext } from './types.js';

export const addSupporter = quickFix<
    typeof JpipeIssue.ConclusionUnsupported
    | typeof JpipeIssue.ConclusionNoStrategy
    | typeof JpipeIssue.StrategyUnsupported
>({
    id: 'add-supporter',
    codes: [
        JpipeIssue.ConclusionUnsupported,
        JpipeIssue.ConclusionNoStrategy,
        JpipeIssue.StrategyUnsupported
    ],

    create(context, diagnostic, data): CodeAction[] {
        const element = elementFor(context, diagnostic);
        if (!element || qualifiedIdText(element.id) !== data.targetId) return [];

        const owner = ownerOf(element);
        if (!owner) return [];

        const insertion = findElementInsertion(context.document, owner);
        if (!insertion) return [];

        // A conclusion may only be supported by a strategy; a strategy by evidence or a
        // sub-conclusion. Evidence comes first because it ends the chain rather than extending it.
        const candidates: readonly ElementKeyword[] = isConclusion(element)
            ? ['strategy']
            : ['evidence', 'sub-conclusion'];

        const targetId = qualifiedIdText(element.id);
        const relationIndent = relationIndentFor(context, owner, insertion.indent);

        const relationAt = relationLine(context, owner);

        return candidates.map((keyword, index) => {
            const id = freshLocalId(owner, stemFor(keyword));
            const declaration = renderElement(keyword, id, '');
            const relation = renderRelation(id, targetId);

            // Where the model has no relations yet, both lines land at the same offset. Two
            // zero-width edits at one position have no defined order, so they become one edit.
            const edits = relationAt === insertion.line
                ? [insertLinesEdit(insertion.line, [declaration, relation], insertion.indent)]
                : [
                    insertLinesEdit(insertion.line, [declaration], insertion.indent),
                    insertLinesEdit(relationAt, [relation], relationIndent)
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
function stemFor(keyword: ElementKeyword): string {
    return keyword === 'evidence' ? 'e' : keyword === 'strategy' ? 's' : 'sc';
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

/** Relations go after the ones already there, or at the end of the body if there are none. */
function relationLine(context: JpipeActionContext, owner: Justification | Template): number {
    const lastRelation = owner.contents?.rels.at(-1)?.$cstNode;
    if (lastRelation) return lastRelation.range.end.line + 1;
    const lastElement = owner.contents?.body.at(-1)?.$cstNode;
    if (lastElement) return lastElement.range.end.line + 1;
    return context.document.textDocument.positionAt(owner.$cstNode!.offset).line + 1;
}

function relationIndentFor(
    context: JpipeActionContext,
    owner: Justification | Template,
    fallback: string
): string {
    const lastRelation = owner.contents?.rels.at(-1)?.$cstNode;
    return lastRelation ? indentationOf(context.document, lastRelation.range.start.line) : fallback;
}
