import * as vscode from 'vscode';
import type { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import type { ReleaseManager } from './release-manager.js';
import type { JpipeRelease } from './release-selection.js';
import { releaseQuickPickItems } from './release-presentation.js';

/**
 * Choosing and installing a managed compiler.
 *
 * The flow has to live in the extension host — quick picks and progress notifications — so this
 * module is excluded from coverage. The decisions inside it that are only about text and
 * ordering live in `release-presentation.ts`, which is not, and are tested there.
 */

/** What the install flow needs from the rest of the extension. */
export interface ManagedInstallDeps {
    releaseManager: ReleaseManager;
    logger: JpipeLogger;
}

/**
 * Pick a release, download its jar into hidden global storage, record it, and switch the
 * extension into `managed` execution mode.
 *
 * `preselectTag` comes from the update prompt and skips the picker when it names a release that
 * is still listed.
 */
export async function installFromRelease(
    { releaseManager, logger }: ManagedInstallDeps,
    preselectTag?: string
): Promise<void> {
    let releases: JpipeRelease[];
    try {
        releases = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'jPipe: fetching available releases…' },
            () => releaseManager.listReleases()
        );
    } catch (err: unknown) {
        vscode.window.showErrorMessage(`jPipe: could not list releases. ${messageOf(err)}`);
        return;
    }
    if (releases.length === 0) {
        vscode.window.showWarningMessage('jPipe: no compatible releases (v2.0.0+) were found.');
        return;
    }

    const installed = releaseManager.getInstalled();
    let chosen = preselectTag ? releases.find(r => r.tag === preselectTag) : undefined;
    if (!chosen) {
        const picked = await vscode.window.showQuickPick(
            releaseQuickPickItems(releases, installed),
            {
                title: 'Select a jPipe compiler release to install',
                placeHolder: 'Downloaded and run internally — no manual path needed'
            }
        );
        if (!picked) return;
        chosen = picked.release;
    }
    const release = chosen;

    try {
        const jarPath = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `jPipe: downloading ${release.tag}…`,
                cancellable: false
            },
            (progress) => {
                let last = 0;
                return releaseManager.download(release, (fraction) => {
                    const pct = Math.round(fraction * 100);
                    progress.report({ increment: pct - last, message: `${pct}%` });
                    last = pct;
                });
            }
        );
        await releaseManager.setInstalled(release.tag, jarPath);
        await vscode.workspace.getConfiguration('jpipe')
            .update('executionMode', 'managed', vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`jPipe ${release.tag} installed and activated (managed mode).`);
        logger.info(`Managed jPipe compiler set to ${release.tag} at ${jarPath}`);
    } catch (err: unknown) {
        vscode.window.showErrorMessage(`jPipe: download failed. ${messageOf(err)}`);
    }
}
