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

/** Install Pylance from the editor's marketplace; resolves to whether it was. */
export async function installPylance(logger: JpipeLogger): Promise<boolean> {
    try {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', PYLANCE_EXTENSION);
        logger.info('Installed Pylance.');
        return true;
    } catch (err: unknown) {
        // The usual cause is an editor whose marketplace does not carry it: VSCodium, and the
        // other builds of VS Code that are not Microsoft's.
        logger.error(`Pylance could not be installed: ${messageOf(err)}`);
        void vscode.window.showWarningMessage(
            `Pylance could not be installed: ${messageOf(err)}. It is available in Microsoft's VS Code only; jPipe works without it.`);
        return false;
    }
}
