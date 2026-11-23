/**
 * "Change 'conclusion' to 'sub-conclusion'" — for a conclusion declared by a model that inherits one.
 *
 * A model that `implements` a template argues for the template's conclusion, so one of its own is
 * refused. What the author wrote is usually a claim on the way to that conclusion, and a
 * sub-conclusion is exactly that: the relations that use it stay valid, and the id and label stay
 * as written. Removing the declaration instead would leave every relation naming it unresolved.
 *
 * A conclusion whose id is a `@support` the model must override, `conclusion T:a`, is that
 * override written with the wrong keyword. The compiler discards it and reports the `@support` as
 * not overridden, so the repair is the one `fix-override-type` offers for any other wrong keyword,
 * `evidence` first since it needs nothing else to be valid, then `sub-conclusion`. Any other
 * qualified id, such as the template's own conclusion `T:c`, gets no fix: no keyword makes it
 * valid, and offering one would trade this error for another.
 */
import type { Reference } from 'langium';
import type { CodeAction } from 'vscode-languageserver';
import { isConclusion, isTemplate, type Template } from '../generated/ast.js';
import { nodeForDiagnostic } from '../jpipe-ast-context.js';
import { JpipeIssue } from '../jpipe-diagnostic-codes.js';
import { qualifiedIdText, requiredOverrides } from '../jpipe-utils.js';
import { quickFix } from './types.js';

const KEYWORD = 'conclusion';

export const fixInheritedConclusion = quickFix<typeof JpipeIssue.InheritedConclusion>({
    id: 'fix-inherited-conclusion',
    codes: [JpipeIssue.InheritedConclusion],

    create(context, diagnostic): CodeAction[] {
        // The diagnostic is anchored on the conclusion's `id`, a QualifiedId, so the conclusion is
        // its container.
        const node = nodeForDiagnostic(context.document, diagnostic);
        const conclusion = node && isConclusion(node) ? node : node?.$container;
        // Re-checked against the document, which may have moved on since the diagnostic was made.
        if (!conclusion || !isConclusion(conclusion)) return [];
        const parent = conclusion.$container?.$container?.parent;
        if (!parent) return [];

        const declaration = conclusion.$cstNode;
        if (!declaration?.text.startsWith(KEYWORD)) return [];
        const start = declaration.range.start;
        const keywordRange = {
            start,
            end: { line: start.line, character: start.character + KEYWORD.length }
        };

        const keywords = keywordsFor(conclusion.id?.parts.length ?? 0, qualifiedIdText(conclusion.id), parent);
        return keywords.map((keyword, index) => ({
            title: `Change '${KEYWORD}' to '${keyword}'`,
            isPreferred: index === 0,
            edit: {
                changes: {
                    [context.document.uri.toString()]: [{ range: keywordRange, newText: keyword }]
                }
            }
        }));
    }
});

/** The keywords that make the conclusion valid: none when its qualified id names no `@support`. */
function keywordsFor(parts: number, id: string, parent: Reference<Template>): string[] {
    if (parts <= 1) return ['sub-conclusion'];
    const template = parent.ref;
    if (!isTemplate(template)) return [];
    const refText = parent.$refText ?? template.id;
    return requiredOverrides(template, refText).some(required => required.expectedKey === id)
        ? ['evidence', 'sub-conclusion']
        : [];
}
