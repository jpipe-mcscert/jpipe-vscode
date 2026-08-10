/**
 * "Override '@support T:abs' with evidence" — writing the declaration a template demands.
 *
 * A justification implementing a template must override each of its `@support` elements with a
 * declaration carrying a specific qualified id. Working that id out by hand means reading the
 * template, following its `implements` chain, and getting the qualifier right; the validator has
 * already done all of it, so the fix writes the line.
 *
 * Where more than one override is missing, a second action closes them all at once — the usual
 * case when a justification has only just been pointed at a template.
 */
import { CodeActionKind, type CodeAction } from 'vscode-languageserver';
import { isJustification, type Justification } from '../generated/ast.js';
import { nodeForDiagnostic } from '../jpipe-ast-context.js';
import { findElementInsertion, insertLinesEdit } from '../jpipe-edits.js';
import { JpipeIssue } from '../jpipe-diagnostic-codes.js';
import { renderElement, type ElementKeyword } from '../jpipe-render.js';
import { getLocalElements, qualifiedIdText } from '../jpipe-utils.js';
import { quickFix, type JpipeActionContext } from './types.js';

/** Both keywords that may refine an `@support`; `evidence` first, so it is the preferred fix. */
const OVERRIDE_KEYWORDS: readonly ElementKeyword[] = ['evidence', 'sub-conclusion'];

export const addSupportOverride = quickFix<typeof JpipeIssue.MissingSupportOverride>({
    id: 'add-support-override',
    codes: [JpipeIssue.MissingSupportOverride],

    create(context, diagnostic, data): CodeAction[] {
        const justification = justificationFor(context, diagnostic);
        if (!justification) return [];

        const insertion = findElementInsertion(context.document, justification);
        if (!insertion) return [];

        // The payload was computed when the diagnostic was published and the user may have typed
        // since; anything already declared is no longer missing.
        const declared = new Set(getLocalElements(justification).map(e => qualifiedIdText(e.id)));
        const missing = data.allMissing.filter(entry => !declared.has(entry.expectedKey));
        if (!missing.some(entry => entry.expectedKey === data.expectedKey)) return [];

        const uri = context.document.uri.toString();
        const actions: CodeAction[] = OVERRIDE_KEYWORDS.map((keyword, index) => ({
            title: `Override '@support ${data.supportId}' with ${keyword}`,
            kind: CodeActionKind.QuickFix,
            isPreferred: index === 0,
            edit: {
                changes: {
                    [uri]: [insertLinesEdit(
                        insertion.line,
                        [renderElement(keyword, data.expectedKey, data.supportLabel)],
                        insertion.indent
                    )]
                }
            }
        }));

        if (missing.length > 1) {
            actions.push({
                title: `Override all ${missing.length} missing @support elements`,
                kind: CodeActionKind.QuickFix,
                edit: {
                    changes: {
                        [uri]: [insertLinesEdit(
                            insertion.line,
                            missing.map(entry => renderElement('evidence', entry.expectedKey, entry.supportLabel)),
                            insertion.indent
                        )]
                    }
                }
            });
        }

        return actions;
    }
});

/** The justification the diagnostic sits on, or `undefined` if its range no longer names one. */
function justificationFor(
    context: JpipeActionContext,
    diagnostic: Parameters<typeof nodeForDiagnostic>[1]
): Justification | undefined {
    let node = nodeForDiagnostic(context.document, diagnostic);
    while (node && !isJustification(node)) node = node.$container;
    return node;
}
