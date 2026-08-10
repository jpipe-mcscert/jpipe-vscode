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
import { insertDeclarationsEdit } from '../jpipe-edits.js';
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

        // The payload was computed when the diagnostic was published and the user may have typed
        // since; anything already declared is no longer missing.
        const declared = new Set(getLocalElements(justification).map(e => qualifiedIdText(e.id)));
        const missing = data.allMissing.filter(entry => !declared.has(entry.expectedKey));
        if (!missing.some(entry => entry.expectedKey === data.expectedKey)) return [];

        const uri = context.document.uri.toString();
        const several = missing.length > 1;
        const actions: CodeAction[] = [];

        /** The single edit writing these declarations into the justification, wherever its body is. */
        const write = (lines: readonly string[]) =>
            insertDeclarationsEdit(context.document, justification, lines);

        // First, and preferred, when there is more than one gap: a justification that has just
        // been pointed at a template is missing all of them, and closing them one at a time is
        // not what anybody came here to do. Emitted ahead of the individual fixes so it leads the
        // menu rather than turning up between one override's options and the next's — the
        // provider drops the copies this produces for each of the other missing overrides.
        if (several) {
            actions.push({
                title: `Override all ${missing.length} missing @support elements`,
                kind: CodeActionKind.QuickFix,
                isPreferred: true,
                edit: { changes: { [uri]: toEdits(write(
                    missing.map(entry => renderElement('evidence', entry.expectedKey, entry.supportLabel))
                )) } }
            });
        }

        actions.push(...OVERRIDE_KEYWORDS.map((keyword, index) => ({
            title: `Override '@support ${data.supportId}' with ${keyword}`,
            kind: CodeActionKind.QuickFix,
            // Only one action may lead; with several gaps that is the fix-all.
            isPreferred: !several && index === 0,
            edit: { changes: { [uri]: toEdits(write(
                [renderElement(keyword, data.expectedKey, data.supportLabel)]
            )) } }
        })));

        // A model with no braces at all has nowhere to write; offer nothing rather than a no-op.
        return actions.filter(action =>
            (action.edit?.changes?.[uri] ?? []).length > 0);
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

/** An edit list from a possibly-absent edit, so a caller can filter on emptiness. */
function toEdits(edit: ReturnType<typeof insertDeclarationsEdit>) {
    return edit ? [edit] : [];
}
