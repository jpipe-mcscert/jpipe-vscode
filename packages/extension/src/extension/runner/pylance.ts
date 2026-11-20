import * as vscode from 'vscode';
import type { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import { PYLANCE_EXTENSION } from '../requirements.js';

/**
 * Pylance, wanted rather than required (jpipe-vscode ADR-VSC-0032): it is looked for, offered and
 * installed on request, never declared as a dependency, since it exists only in Microsoft's own
 * builds of VS Code and a declared dependency would stop jPipe everywhere else.
 */

export function pylanceInstalled(): boolean {
    return vscode.extensions.getExtension(PYLANCE_EXTENSION) !== undefined;
}

/** How long an installed Pylance is waited for before it is taken to be disabled. */
const ENABLE_WAIT_MS = 10_000;

/**
 * Install Pylance from the editor's marketplace; resolves to whether it is now running.
 *
 * Installing one that is installed but disabled does nothing, and the editor reports a disabled
 * extension as absent. So success is judged by Pylance appearing, not by the install command
 * returning, and one that does not appear is pointed out in the Extensions view.
 */
export async function installPylance(logger: JpipeLogger): Promise<boolean> {
    try {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', PYLANCE_EXTENSION);
    } catch (err: unknown) {
        // The usual cause is an editor whose marketplace does not carry it: VSCodium, and the
        // other builds of VS Code that are not Microsoft's.
        logger.error(`Pylance could not be installed: ${messageOf(err)}`);
        void vscode.window.showWarningMessage(
            `Pylance could not be installed: ${messageOf(err)}. It is available in Microsoft's VS Code only; jPipe works without it.`);
        return false;
    }
    if (await appears(ENABLE_WAIT_MS)) {
        logger.info('Pylance is installed and enabled.');
        return true;
    }
    logger.warn('Pylance is installed but did not start: it is probably disabled.');
    const show = 'Show Pylance';
    const answer = await vscode.window.showWarningMessage('Pylance is installed but not enabled. Enable it in the Extensions view.', show);
    if (answer === show) await vscode.commands.executeCommand('workbench.extensions.search', `@id:${PYLANCE_EXTENSION}`);
    return false;
}

/** Whether Pylance is, or becomes within `ms`, an extension the editor knows. */
function appears(ms: number): Promise<boolean> {
    if (pylanceInstalled()) return Promise.resolve(true);
    return new Promise(resolve => {
        const done = (found: boolean): void => {
            clearTimeout(timer);
            listener.dispose();
            resolve(found);
        };
        const listener = vscode.extensions.onDidChange(() => {
            if (pylanceInstalled()) done(true);
        });
        const timer = setTimeout(() => done(pylanceInstalled()), ms);
    });
}
