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

            for (const relative of candidatePathsFor(context, refText)) {
                const title = `Load '${relative}' and use '${refText}'`;
                if (seen.has(title)) continue;
                seen.add(title);

                const edit = createLoadEdit(context.document, relative);
                if (!edit) continue;
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
    const data = diagnostic.data as { code?: string; refText?: string } | undefined;
    if (data?.code !== LINKING_ERROR) return undefined;
    return typeof data.refText === 'string' && data.refText.length > 0 ? data.refText : undefined;
}

/**
 * Files in the workspace declaring a model of this name, as paths relative to the current file.
 *
 * The name may be namespaced (`base:T`); only the last segment names the model, since the prefix
 * is whatever the load was aliased to.
 */
function candidatePathsFor(context: JpipeActionContext, refText: string): string[] {
    const wanted = refText.split(':').at(-1);
    if (!wanted) return [];

    const index = context.services.shared.workspace.IndexManager;
    const currentPath = fsPathOf(context.document.uri);
    const paths = new Set<string>();

    for (const type of [JustificationRule.$type, TemplateRule.$type]) {
        for (const description of index.allElements(type)) {
            if (description.name !== wanted || !description.documentUri) continue;
            const targetPath = fsPathOf(description.documentUri);
            if (targetPath === currentPath) continue;
            const relative = relativeLoadPath(currentPath, targetPath);
            if (isLoaded(context.unit, relative)) continue;
            paths.add(relative);
        }
    }

    return [...paths].sort((a, b) => path.basename(a).localeCompare(path.basename(b)) || a.localeCompare(b));
}
