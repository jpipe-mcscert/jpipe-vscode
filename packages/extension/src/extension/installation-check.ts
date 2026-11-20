import * as vscode from 'vscode';
import type { JpipeLogger } from './logger.js';
import type { ImageGenerator } from './compiler/image-generator.js';
import type { ReleaseManager } from './compiler/release-manager.js';
import type { RunnerEnvironment } from './runner/environment.js';
import type { LibrariesView } from './runner/libraries-view.js';
import { accessMethodHeader } from './compiler/release-presentation.js';
import { installPylance, pylanceInstalled } from './runner/pylance.js';
import { compilerUpdate, installationSummary, pylanceLine, type InstallationAction, type InstallationFacts } from './requirements.js';

export interface InstallationCheckDeps {
    logger: JpipeLogger;
    imageGenerator: ImageGenerator;
    releaseManager: ReleaseManager;
    runnerEnvironment: RunnerEnvironment;
    librariesView: LibrariesView;
}

/**
 * Check jPipe Installation: everything this extension needs, in one dialog, against what this
 * release requires (jpipe-vscode ADR-VSC-0032) — the compiler, then running models in this
 * workspace, then Pylance — with one button for the first problem found.
 *
 * The runner part is said only for a workspace with step libraries: one without has nothing to
 * run yet, and a model-only user should not be told to set up Python.
 */
export async function checkInstallation(deps: InstallationCheckDeps): Promise<void> {
    const { imageGenerator, releaseManager, runnerEnvironment, librariesView, logger } = deps;
    const mode = vscode.workspace.getConfiguration('jpipe').get<string>('executionMode', 'cli');
    const compiler = await imageGenerator.check();
    const hasLibraries = librariesView.allLibraries().length > 0;
    const runs = hasLibraries ? await runnerEnvironment.describe() : undefined;
    const pylance = pylanceInstalled();

    const facts: InstallationFacts = { compiler: compiler.status, runner: runs?.runner ?? 'none', pylance };
    const summary = installationSummary(facts);
    const sections = [
        [accessMethodHeader(mode, releaseManager.getInstalled()), compiler.version, compiler.message].filter(Boolean).join('\n'),
        runs ? `Running models in this workspace\n${runs.detail}` : pylanceLine(pylance)
    ];
    const detail = sections.join('\n\n');
    logger.info(`Check jPipe Installation: ${summary.title}`);

    const label = summary.action ? actionLabel(summary.action, mode) : undefined;
    const answer = await showDialog(summary.severity, summary.title, detail, label);
    if (!summary.action || answer !== label) return;

    switch (summary.action) {
        case 'compiler': await imageGenerator.updateCompiler(); break;
        case 'runner': await runnerEnvironment.setUp(); break;
        case 'pylance': await installPylance(logger); break;
    }
}

function actionLabel(action: InstallationAction, mode: string): string {
    switch (action) {
        case 'compiler': return compilerUpdate(mode).label;
        case 'runner': return 'Set Up the Python Environment';
        case 'pylance': return 'Install Pylance';
    }
}

function showDialog(
    severity: 'info' | 'warning' | 'error',
    title: string,
    detail: string,
    label: string | undefined
): Thenable<string | undefined> {
    const options = { modal: true, detail };
    const buttons = label ? [label] : [];
    if (severity === 'error') return vscode.window.showErrorMessage(title, options, ...buttons);
    if (severity === 'warning') return vscode.window.showWarningMessage(title, options, ...buttons);
    return vscode.window.showInformationMessage(title, options, ...buttons);
}
