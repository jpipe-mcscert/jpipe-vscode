import * as vscode from 'vscode';
import { basename } from 'node:path';
import type { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import { looksLikeJar, scopeToWrite, type SettingScope } from './jar-setting.js';

/**
 * Choosing the compiler JAR with a file dialog instead of typing its path.
 *
 * `jpipe.jarFile` wants an absolute path to a file somewhere on disk, which is the one kind of
 * value a settings text box is worst at: it has to be exact, it is long, it differs on every
 * machine, and a typo in it surfaces later as the compiler failing to start rather than as
 * anything pointing at the setting.
 *
 * The flow lives in the extension host and so is not covered by the suite; the decisions it
 * defers to are in `jar-setting.ts`, which is.
 */

/** The scopes named in `jar-setting.ts`, in the editor's own terms. */
const TARGETS: Record<SettingScope, vscode.ConfigurationTarget> = {
    workspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
    workspace: vscode.ConfigurationTarget.Workspace,
    global: vscode.ConfigurationTarget.Global
};

/**
 * Ask for a JAR and record it as the compiler to run.
 *
 * Cancelling is silent — it is the ordinary way to leave a dialog, and a notification saying
 * nothing happened is noise.
 */
export async function selectJarFile(logger: JpipeLogger): Promise<void> {
    const config = vscode.workspace.getConfiguration('jpipe');
    const current = config.get<string>('jarFile', '');

    const picked = await vscode.window.showOpenDialog({
        title: 'Select the jPipe compiler JAR',
        openLabel: 'Use this JAR',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'JAR files': ['jar'] },
        // Opens on the jar already configured, so correcting one is a click rather than a walk
        // back down the same directories.
        defaultUri: current.trim() ? vscode.Uri.file(current) : undefined
    });
    const jar = picked?.[0];
    if (!jar) return;

    const scope = scopeToWrite(config.inspect<string>('jarFile') ?? {});
    try {
        await config.update('jarFile', jar.fsPath, TARGETS[scope]);
    } catch (err: unknown) {
        vscode.window.showErrorMessage(`jPipe: could not save the JAR path. ${messageOf(err)}`);
        return;
    }
    logger.info(`jPipe JAR set to ${jar.fsPath} in ${scope} settings`);

    if (!looksLikeJar(jar.fsPath)) {
        vscode.window.showWarningMessage(
            `jPipe: ${basename(jar.fsPath)} is not a .jar file. It has been saved, but the compiler will refuse it.`
        );
    }

    await confirmExecutionMode(config, basename(jar.fsPath), logger);
}

/**
 * Say what the choice will do, and offer the one thing that makes it take effect.
 *
 * The jar path is only read in `jar` mode, so setting it from any other mode is a change with no
 * observable effect — the compiler carries on with the CLI or the managed install, and the user
 * has every reason to believe they have just configured something. Rather than switching mode
 * behind their back, which would silently retire a working setup, this says what is in the way
 * and offers the switch.
 */
async function confirmExecutionMode(
    config: vscode.WorkspaceConfiguration,
    jarName: string,
    logger: JpipeLogger
): Promise<void> {
    const mode = config.get<string>('executionMode', 'cli');
    if (mode === 'jar') {
        vscode.window.showInformationMessage(`jPipe will use ${jarName}.`);
        return;
    }

    const SWITCH = 'Switch to JAR mode';
    const answer = await vscode.window.showInformationMessage(
        `jPipe: ${jarName} saved, but execution mode is “${mode}”, so the JAR will not be used.`,
        SWITCH
    );
    if (answer !== SWITCH) return;

    const scope = scopeToWrite(config.inspect<string>('executionMode') ?? {});
    try {
        await config.update('executionMode', 'jar', TARGETS[scope]);
    } catch (err: unknown) {
        vscode.window.showErrorMessage(`jPipe: could not switch execution mode. ${messageOf(err)}`);
        return;
    }
    logger.info(`jPipe execution mode set to jar in ${scope} settings`);
    vscode.window.showInformationMessage(`jPipe will use ${jarName}.`);
}
