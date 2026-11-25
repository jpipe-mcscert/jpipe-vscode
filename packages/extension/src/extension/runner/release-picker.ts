import * as vscode from 'vscode';
import type { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import { httpsGetJson, httpsTransport } from '../compiler/release-download.js';
import type { RunnerEnvironment } from './environment.js';
import { PYPI_RELEASES_URL, choosableReleases, isPypiHost, releaseItems, type RunnerRelease } from './runner-releases.js';
import { VERSION_SETTING } from './runner-invocation.js';

/**
 * Choose jpipe-runner Release…: the releases PyPI lists, picked from, and the workspace's
 * environment given the one picked, as the compiler's managed install does for the compiler
 * (jpipe-vscode ADR-VSC-0036).
 *
 * Choosing writes the version setting, for the workspace when one is open; Set Up then looks
 * again and offers the fix, with its consent dialog, like any other change of the environment.
 */
export async function chooseRunnerRelease(environment: RunnerEnvironment, logger: JpipeLogger): Promise<void> {
    let releases: RunnerRelease[];
    try {
        releases = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'jPipe: fetching jpipe-runner releases from PyPI…' },
            async () => choosableReleases(await httpsGetJson(PYPI_RELEASES_URL, 0, httpsTransport, { allows: isPypiHost, name: 'PyPI' }))
        );
    } catch (err: unknown) {
        logger.error(`Could not list jpipe-runner releases: ${messageOf(err)}`);
        void vscode.window.showErrorMessage(`jPipe: could not list jpipe-runner releases. ${messageOf(err)}`);
        return;
    }
    const configuration = vscode.workspace.getConfiguration('jpipe', vscode.workspace.workspaceFolders?.[0]?.uri);
    const chosen = configuration.get<string>(VERSION_SETTING, '').trim() || undefined;
    await environment.settled();
    const installed = environment.installedRelease;
    const picked = await vscode.window.showQuickPick(releaseItems(releases, { installed, chosen }), {
        title: 'Choose the jpipe-runner release for this workspace',
        placeHolder: 'Installed in the workspace\'s Python environment, after you agree to it'
    });
    if (!picked) return;
    const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await configuration.update(VERSION_SETTING, picked.version || undefined, target);
    logger.info(`jpipe-runner release chosen: ${picked.version || 'any'}.`);
    if (environment.development) {
        void vscode.window.showInformationMessage(
            'Saved. Development mode is on, so runs use your local jpipe-runner: this release is installed once you turn it off.');
        return;
    }
    await environment.setUp();
}
