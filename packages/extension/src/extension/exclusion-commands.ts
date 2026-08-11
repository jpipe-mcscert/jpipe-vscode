import * as vscode from 'vscode';
import type { ExclusionManager } from './exclusions.js';

/**
 * The user-facing half of excluding things from validation.
 *
 * `ExclusionManager` owns the setting and the resolution rules; this owns what to ask, and what
 * to say when the answer is no. Kept apart from `activate()` because these are four small flows
 * that each have their own failure cases, and inline they were nine anonymous callbacks deep in
 * a registration list.
 */

/**
 * The resource a context-menu command acts on.
 *
 * The Explorer always passes one explicitly; invoked from the editor menu or the palette there
 * is no argument, so the open `.jd` document stands in. Anything else — a non-jPipe editor, no
 * editor at all — yields undefined and the caller does nothing rather than guessing.
 */
export function resolveExclusionTarget(uri?: vscode.Uri): vscode.Uri | undefined {
    if (uri) return uri;
    const active = vscode.window.activeTextEditor?.document;
    return active?.languageId === 'jpipe' ? active.uri : undefined;
}

/** Exclude a folder or `.jd` file from validation, reporting the two ways this can fail. */
export async function excludeResource(exclusions: ExclusionManager, uri?: vscode.Uri): Promise<void> {
    const target = resolveExclusionTarget(uri);
    if (!target) return;

    const label = vscode.workspace.asRelativePath(target, false);
    if (!await exclusions.addPath(target)) {
        vscode.window.showWarningMessage('The selection must be inside the workspace.');
        return;
    }
    // A bare relative entry can only be resolved against a single root; in a multi-root
    // workspace the entry is stored as `rootName:path`, which needs that root to be present.
    if (!exclusions.isExcludedRoot(target)) {
        vscode.window.showWarningMessage(`jPipe could not resolve ${label} against a workspace folder.`);
        return;
    }
    vscode.window.showInformationMessage(`jPipe no longer validates ${label}.`);
}

/** Put a previously excluded resource back under validation. */
export async function includeResource(exclusions: ExclusionManager, uri?: vscode.Uri): Promise<void> {
    const target = resolveExclusionTarget(uri);
    if (!target) return;
    if (await exclusions.removeResolved(target)) {
        vscode.window.showInformationMessage(
            `jPipe now validates ${vscode.workspace.asRelativePath(target, false)}.`
        );
    }
}

/** Ask for a folder and exclude it. */
export async function addExcludedDirectory(exclusions: ExclusionManager): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Exclude from Validation'
    });
    const first = uris?.[0];
    if (!first) return;
    await excludeResource(exclusions, first);
}

/** Offer the current exclusion entries and remove the chosen one. */
export async function removeExcludedPath(exclusions: ExclusionManager): Promise<void> {
    const entries = exclusions.getEntries();
    if (entries.length === 0) {
        vscode.window.showInformationMessage('jPipe: nothing is excluded from validation.');
        return;
    }
    const picked = await vscode.window.showQuickPick(entries, {
        title: 'Remove a path from the jPipe validation exclusions',
        placeHolder: 'Its .jd files will be validated again'
    });
    if (picked) await exclusions.removeEntry(picked);
}
