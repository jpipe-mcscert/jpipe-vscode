import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import { findDiagramName } from '../compiler/compiler-invocation.js';
import { ImageFormat, type ImageGenerator } from '../compiler/image-generator.js';
import type { Model } from '../models-view/models-tree.js';
import type { ModelsView } from '../models-view/models-view.js';
import { LIBRARIES_VIEW_ID, type LibrariesView } from './libraries-view.js';
import { RUNNER_COMMAND_SETTING, cannotRun, resolveRunner, runnerArguments } from './runner-invocation.js';
import type { RunnerEnvironment } from './environment.js';
import { fixLabel, moduleInvocation, statusMessage } from './python-environment.js';

/** The task type a run is launched as, contributed in `package.json`'s `taskDefinitions`. */
export const RUN_TASK_TYPE = 'jpipe';

export interface RunDeps {
    context: vscode.ExtensionContext;
    logger: JpipeLogger;
    imageGenerator: ImageGenerator;
    libraries: LibrariesView;
    models: ModelsView;
    environment: RunnerEnvironment;
}

/**
 * Run a justification with jpipe-runner: the ▶ button.
 *
 * The model is the one given (a Models row), or else the one the cursor is in. It is compiled to
 * JSON by the jPipe compiler — the same call as Download as JSON — and the runner is launched as
 * a VS Code task, so its report appears in the terminal panel with its colours, and its exit code
 * says pass (0) or fail (1) the way it would in CI.
 *
 * The run's working directory is the workspace folder, because the paths a step observes are
 * relative to where the runner runs, and a project's artifacts are laid out from its root.
 */
export async function runModel(deps: RunDeps, target?: Model): Promise<void> {
    const subject = await resolveSubject(deps, target);
    if (!subject) return;
    const { document, name } = subject;

    const reason = cannotRun(subject.kind, name);
    if (reason) {
        void vscode.window.showWarningMessage(reason);
        return;
    }

    const libraries = deps.libraries.checkedLibraries();
    if (libraries.length === 0) {
        const show = 'Show Libraries';
        const answer = await vscode.window.showWarningMessage(
            'No step library is checked. Check the libraries this run should load in the jPipe Libraries view.', show);
        if (answer === show) await vscode.commands.executeCommand(`${LIBRARIES_VIEW_ID}.focus`);
        return;
    }

    // The compiler and the runner read files, not editors.
    if (document.isDirty) await document.save();

    let json: string;
    try {
        json = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Compiling ${name}…` },
            () => deps.imageGenerator.generate(false, ImageFormat.JSON, document, name));
    } catch (err: unknown) {
        const problems = 'Show Problems';
        const answer = await vscode.window.showErrorMessage(
            `${name} could not be compiled, so it cannot be run: ${messageOf(err)}`, problems);
        if (answer === problems) await vscode.commands.executeCommand('workbench.actions.view.problems');
        return;
    }

    const compiled = await writeCompiled(deps.context, name, json);
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const cwd = folder?.uri.fsPath ?? path.dirname(document.uri.fsPath);
    const runnerArgs = runnerArguments(libraries.map(library => library.uri.fsPath), compiled);
    const invocation = await chooseInvocation(deps, folder, runnerArgs);
    if (!invocation) return;
    const { program, args } = invocation;
    deps.logger.info(`Running ${name}: ${program} ${args.join(' ')} (in ${cwd})`);

    const task = new vscode.Task(
        { type: RUN_TASK_TYPE, model: name },
        folder ?? vscode.TaskScope.Workspace,
        `Run ${name}`,
        'jPipe',
        new vscode.ProcessExecution(program, args, { cwd })
    );
    task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Always,
        panel: vscode.TaskPanelKind.Dedicated,
        clear: true,
        showReuseMessage: false
    };
    try {
        await vscode.tasks.executeTask(task);
    } catch (err: unknown) {
        void vscode.window.showErrorMessage(`Could not start jpipe-runner: ${messageOf(err)}`);
    }
}

/**
 * How to start the runner: the configured program if there is one; otherwise the Python VS Code
 * uses, as `python -m jpipe_runner`, so the run and the editor agree on the environment
 * (jpipe-vscode ADR-VSC-0026). When that Python cannot run step libraries, the fix is offered,
 * and so is running anyway with whatever `jpipe-runner` the old search finds.
 */
async function chooseInvocation(
    deps: RunDeps,
    folder: vscode.WorkspaceFolder | undefined,
    runnerArgs: string[]
): Promise<{ program: string; args: string[] } | undefined> {
    const configured = vscode.workspace.getConfiguration('jpipe').get<string>(RUNNER_COMMAND_SETTING, '') ?? '';
    const search = () => ({
        program: resolveRunner({
            configured,
            folder: folder?.uri.fsPath,
            platform: process.platform,
            home: os.homedir(),
            exists: file => fs.existsSync(file)
        }),
        args: runnerArgs
    });
    if (configured.trim()) return search();

    let status = await deps.environment.settled();
    if (status.kind !== 'ready') {
        const fix = fixLabel(status);
        const anyway = 'Run Anyway';
        const answer = await vscode.window.showWarningMessage(
            statusMessage(status) ?? 'The selected Python cannot run step libraries.',
            ...(fix ? [fix] : []), anyway);
        if (answer === anyway) return search();
        if (answer !== fix || !await deps.environment.fix()) return undefined;
        status = await deps.environment.settled();
        if (status.kind !== 'ready') return undefined;
    }
    return moduleInvocation(status.python, runnerArgs);
}

/** The document and model to run, or `undefined` after saying why there is none. */
async function resolveSubject(
    deps: RunDeps,
    target: Model | undefined
): Promise<{ document: vscode.TextDocument; name: string; kind: Model['kind'] | undefined } | undefined> {
    if (target) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
        return { document, name: target.name, kind: target.kind };
    }
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== 'jpipe') {
        void vscode.window.showWarningMessage('Open a jPipe model, or pick one in the Models view, to run it.');
        return undefined;
    }
    let name: string;
    try {
        name = findDiagramName(editor.document.getText(), editor.selection.active.line);
    } catch {
        void vscode.window.showWarningMessage('Put the cursor in the justification to run.');
        return undefined;
    }
    const uri = editor.document.uri.toString();
    const kind = deps.models.knownModels
        .find(m => m.name === name && vscode.Uri.parse(m.uri).toString() === uri)?.kind;
    return { document: editor.document, name, kind };
}

/** Where the compiled model is written: the extension's storage for this workspace. */
async function writeCompiled(context: vscode.ExtensionContext, name: string, json: string): Promise<string> {
    const base = context.storageUri ?? context.globalStorageUri;
    const folder = vscode.Uri.joinPath(base, 'runs');
    await vscode.workspace.fs.createDirectory(folder);
    const file = vscode.Uri.joinPath(folder, `${name}.json`);
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(json));
    return file.fsPath;
}
