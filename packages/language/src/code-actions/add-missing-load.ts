/**
 * "Load './lib/base.jd' and use 'Base'" — for a model named but never imported.
 *
 * Writing `implements Base` before loading the file that defines it is the ordinary way round to
 * work, and the reference is already correct: only the `load` is missing. The completion provider
 * inserts one when a cross-file name is accepted from the popup, but a name typed out by hand
 * never goes through it, and the broken reference is where the author is looking.
 *
 * Keyed on Langium's own linking error rather than on a jPipe code — an unresolved reference is
 * the language framework's finding, not the validator's.
 */
import { CodeActionKind, type CodeAction, type Diagnostic } from 'vscode-languageserver';
import * as path from 'node:path';
import { Justification as JustificationRule, Template as TemplateRule } from '../generated/ast.js';
import { createLoadEdit, isLoaded, relativeLoadPath } from '../jpipe-edits.js';
import { fsPathOf } from '../jpipe-utils.js';
import type { JpipeActionContext, RefactoringDefinition } from './types.js';

/** Langium's code for a reference that resolved to nothing. */
const LINKING_ERROR = 'linking-error';

/**
 * The references a `load` can possibly fix: the ones naming a *model*.
 *
 * `implements` and a composition's sources name models, which is what a file brings in. A
 * relation's endpoints name elements, and `t:abs` there is a qualified element id, not
 * `namespace:model` — reading it as one would offer to load any file that happened to declare a
 * model called `abs`.
 */
const MODEL_REFERENCE_PROPERTIES = new Set(['parent', 'refs']);

/** A reference split into the alias it reaches through and the model it names. */
interface ModelReference {
    readonly namespace: string | undefined;
    readonly modelId: string;
}

/**
 * Reads `alpha` or `lib:alpha`, and nothing longer.
 *
 * A load contributes at most one alias, so `a:b:c` names something no `load` can produce and
 * there is no fix to offer for it.
 */
function parseModelReference(refText: string): ModelReference | undefined {
    const parts = refText.split(':');
    if (parts.length === 1 && parts[0]) return { namespace: undefined, modelId: parts[0] };
    if (parts.length === 2 && parts[0] && parts[1]) return { namespace: parts[0], modelId: parts[1] };
    return undefined;
}

/**
 * Offered as a quick fix, but registered as a refactoring because it keys on a diagnostic the
 * jPipe codes do not cover; the dispatcher routes quick fixes by `JpipeIssueCode` alone.
 */
export const addMissingLoad: RefactoringDefinition = {
    id: 'add-missing-load',
    actionKind: CodeActionKind.QuickFix,

    create(context): CodeAction[] {
        const actions: CodeAction[] = [];
        const seen = new Set<string>();

        for (const diagnostic of context.params.context.diagnostics) {
            const refText = linkingErrorRefText(diagnostic);
            if (!refText) continue;
            const reference = parseModelReference(refText);
            if (!reference) continue;

            for (const relative of candidatePathsFor(context, reference)) {
                // The alias is what makes the reference resolve; without it the load lands and
                // `lib:alpha` is still unresolved, which is a fix that does not fix anything.
                const edit = createLoadEdit(context.document, relative, reference.namespace);
                if (!edit) continue;

                const alias = reference.namespace ? ` as ${reference.namespace}` : '';
                const title = `Load '${relative}'${alias} and use '${refText}'`;
                if (seen.has(title)) continue;
                seen.add(title);

                actions.push({
                    title,
                    kind: CodeActionKind.QuickFix,
                    diagnostics: [diagnostic],
                    edit: { changes: { [context.document.uri.toString()]: edit } }
                });
            }
        }

        return actions;
    }
};

/** The unresolved name, if this diagnostic is a linking error. */
function linkingErrorRefText(diagnostic: Diagnostic): string | undefined {
    const data = diagnostic.data as { code?: string; refText?: string; property?: string } | undefined;
    if (data?.code !== LINKING_ERROR) return undefined;
    if (!MODEL_REFERENCE_PROPERTIES.has(data.property ?? '')) return undefined;
    return typeof data.refText === 'string' && data.refText.length > 0 ? data.refText : undefined;
}

/**
 * Files in the workspace declaring the referenced model, as paths relative to the current file.
 *
 * Only the model's own name is matched: the prefix, when there is one, is whatever alias the
 * author expects to reach it through, and it is the load being written that will establish it.
 */
function candidatePathsFor(context: JpipeActionContext, reference: ModelReference): string[] {
    const wanted = reference.modelId;
    const index = context.services.shared.workspace.IndexManager;
    const currentPath = fsPathOf(context.document.uri);
    const paths = new Set<string>();

    for (const type of [JustificationRule.$type, TemplateRule.$type]) {
        for (const description of index.allElements(type)) {
            if (description.name !== wanted || !description.documentUri) continue;
            const targetPath = fsPathOf(description.documentUri);
            if (targetPath === currentPath) continue;
            const relative = relativeLoadPath(currentPath, targetPath);
            if (isLoaded(context.unit, relative, reference.namespace)) continue;
            paths.add(relative);
        }
    }

    return [...paths].sort((a, b) => path.basename(a).localeCompare(path.basename(b)) || a.localeCompare(b));
}
