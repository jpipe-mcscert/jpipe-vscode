import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import type { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import { findDiagramName } from '../compiler/compiler-invocation.js';
import { ImageFormat, type ImageGenerator } from '../compiler/image-generator.js';
import type { Model } from '../models-view/models-tree.js';
import type { ModelsView } from '../models-view/models-view.js';
import { LIBRARIES_VIEW_ID, type LibrariesView } from './libraries-view.js';
import { MODELS_VIEW_ID } from '../models-view/models-view.js';
import { RUNNER_COMMAND_SETTING, cannotRun, resolveRunner, runnerArguments } from './runner-invocation.js';
import type { RunnerEnvironment } from './environment.js';
import { fixLabel, moduleInvocation, runnablePython, statusMessage, type Command } from './python-environment.js';
import type { ResultsView } from './results-view.js';
import { parseReport, verdictSentence, withReport } from './run-report.js';

/** The task type a run is launched as, contributed in `package.json`'s `taskDefinitions`. */
export const RUN_TASK_TYPE = 'jpipe';

export interface RunDeps {
    context: vscode.ExtensionContext;
    logger: JpipeLogger;
    imageGenerator: ImageGenerator;
    libraries: LibrariesView;
    models: ModelsView;
    environment: RunnerEnvironment;
    results: ResultsView;
}

/** Save the model and the libraries a run loads: the compiler and the runner read files, not editors. */
async function saveInputs(document: vscode.TextDocument, libraries: readonly vscode.Uri[]): Promise<void> {
    if (document.isDirty) await document.save();
    const loaded = new Set(libraries.map(uri => uri.toString()));
    await Promise.all(vscode.workspace.textDocuments
        .filter(open => open.isDirty && loaded.has(open.uri.toString()))
        .map(open => open.save()));
}

/**
 * Compile `name` to the JSON the runner reads, and name the file the runner's report goes to.
 * `undefined` when the model does not compile, which the user has then been told.
 *
 * The compiler writes the file itself: what it prints is for a reader, banner included, and is
 * not the JSON.
 */
async function compile(
    deps: RunDeps,
    document: vscode.TextDocument,
    name: string
): Promise<{ compiled: vscode.Uri; report: vscode.Uri } | undefined> {
    try {
        const compiled = await runFile(deps.context, `${name}.json`);
        const report = await runFile(deps.context, `${name}.report.json`);
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Compiling ${name}…` },
            () => deps.imageGenerator.generate(false, ImageFormat.JSON, document, name, compiled));
        return { compiled, report };
    } catch (err: unknown) {
        const problems = 'Show Problems';
        const answer = await vscode.window.showErrorMessage(
            `${name} could not be compiled, so it cannot be run: ${messageOf(err)}`, problems);
        if (answer === problems) await vscode.commands.executeCommand('workbench.actions.view.problems');
        return undefined;
    }
}

/**
 * Run a justification with jpipe-runner: the ▶ button.
 *
 * The model is the one given (a Models row), or else the one the cursor is in. It is compiled to
 * JSON by the jPipe compiler — the same call as Export as JSON — and the runner is launched as
 * a VS Code task, the way it would be in CI, and asked to write its JSON report to a file
 * (`--report`). When it ends, the Results view shows that report (jpipe-vscode ADR-VSC-0029). The
 * task's terminal is where the steps print; it stays in the background unless the run ended
 * without a report, which is when what the runner printed is all there is to read.
 *
 * The run's working directory is the workspace folder, because the paths a step observes are
 * relative to where the runner runs, and a project's artifacts are laid out from its root.
 *
 * A `check` is the same with `--dry-run`: the runner validates the checked libraries against the
 * model and calls no step.
 */
export async function runModel(deps: RunDeps, target?: Model, check = false): Promise<void> {
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

    await saveInputs(document, libraries.map(library => library.uri));
    const files = await compile(deps, document, name);
    if (!files) return;
    const { compiled, report } = files;

    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const cwd = folder?.uri.fsPath ?? path.dirname(document.uri.fsPath);
    const runnerArgs = withReport(runnerArguments(libraries.map(library => library.uri.fsPath), compiled.fsPath), report.fsPath, check);
    const invocation = await chooseInvocation(deps, folder, runnerArgs);
    if (!invocation) return;
    const { program, args, env } = invocation;
    const doing = check ? 'Checking' : 'Running';
    deps.logger.info(`${doing} ${name}: ${program} ${args.join(' ')} (in ${cwd})`);

    const task = new vscode.Task(
        { type: RUN_TASK_TYPE, model: name },
        folder ?? vscode.TaskScope.Workspace,
        `${check ? 'Check' : 'Run'} ${name}`,
        'jPipe',
        new vscode.ProcessExecution(program, args, { cwd, ...(env ? { env } : {}) })
    );
    task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Never,
        panel: vscode.TaskPanelKind.Dedicated,
        clear: true,
        showReuseMessage: false
    };
    let exitCode: number | undefined;
    try {
        exitCode = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `${doing} ${name}…` },
            () => executed(task));
    } catch (err: unknown) {
        void vscode.window.showErrorMessage(`Could not start jpipe-runner: ${messageOf(err)}`);
        return;
    }

    const showOutput = (): void => terminalOf(task)?.show();
    const read = await readReport(report);
    if ('problem' in read) {
        // No report: a usage error, a file that could not be read, or a runner that did not start.
        deps.logger.warn(`${task.name} ended with exit code ${exitCode ?? '(none)'}: ${read.problem}`);
        showOutput();
        void vscode.window.showErrorMessage(
            `${name} was not ${check ? 'checked' : 'run'}: ${read.problem}. What jpipe-runner printed is in the terminal.`);
        return;
    }
    deps.logger.info(`${task.name}: ${verdictSentence(read.report, name, check)}`);
    await deps.results.show({ report: read.report, name, check, cwd, steps: deps.libraries.checkedSteps(), showOutput });
}

/**
 * Run or check the model selected in the Models view: the shortcut on a checked library's ▶ menu.
 * A library is run through a justification, so with none selected the answer is to select one.
 */
export async function runSelectedModel(deps: RunDeps, check: boolean): Promise<void> {
    const model = deps.models.currentModel;
    if (model) return runModel(deps, model, check);
    const show = 'Show Models';
    const answer = await vscode.window.showInformationMessage(
        `Select a justification in the jPipe Models view first: it is what the libraries are ${check ? 'checked against' : 'run for'}.`, show);
    if (answer === show) await vscode.commands.executeCommand(`${MODELS_VIEW_ID}.focus`);
}

/**
 * Run `task`, and give its exit code once it has ended: `undefined` if its process never started.
 *
 * The end is listened for before the task starts, and matched by what the task is rather than by
 * the execution `executeTask` resolves to: a task that fails at once, a missing program say, can
 * end before that.
 */
function executed(task: vscode.Task): Promise<number | undefined> {
    const ours = (e: { execution: vscode.TaskExecution }): boolean =>
        e.execution.task.source === task.source && e.execution.task.name === task.name;
    return new Promise((resolve, reject) => {
        let exitCode: number | undefined;
        const listeners = [
            vscode.tasks.onDidEndTaskProcess(e => {
                if (ours(e)) exitCode = e.exitCode;
            }),
            // Fires after the process's own event, and alone when there was no process.
            vscode.tasks.onDidEndTask(e => {
                if (ours(e)) done(() => resolve(exitCode));
            })
        ];
        const done = (settle: () => void): void => {
            for (const listener of listeners) listener.dispose();
            settle();
        };
        vscode.tasks.executeTask(task).then(undefined, (err: unknown) => done(() => reject(err)));
    });
}

/**
 * The terminal a task ran in. VS Code names it after the task, behind a prefix of its own, so the
 * name is matched whole: `Run release` is not the terminal of `Run release2`.
 */
function terminalOf(task: vscode.Task): vscode.Terminal | undefined {
    return vscode.window.terminals.find(({ name }) =>
        name.endsWith(task.name) && !/\w/.test(name.charAt(name.length - task.name.length - 1)));
}

async function readReport(file: vscode.Uri): Promise<ReturnType<typeof parseReport>> {
    try {
        return parseReport(new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(file)));
    } catch {
        return { problem: 'jpipe-runner wrote no report' };
    }
}

/**
 * How to start the runner (jpipe-vscode ADR-VSC-0026). In `command` mode, the program the user
 * named. Otherwise the workspace's own Python environment, as `python -m jpipe_runner` with that
 * environment activated — the one the editor is pointed at too; when the workspace has none that
 * can run step libraries, the fix is offered, and the run goes ahead only once it has one.
 */
async function chooseInvocation(
    deps: RunDeps,
    folder: vscode.WorkspaceFolder | undefined,
    runnerArgs: string[]
): Promise<(Command & { env?: Record<string, string> }) | undefined> {
    let status = await deps.environment.settled();
    if (status.kind === 'external') {
        const configured = vscode.workspace.getConfiguration('jpipe', folder?.uri).get<string>(RUNNER_COMMAND_SETTING, '') ?? '';
        return { program: resolveRunner(configured, os.homedir()), args: runnerArgs };
    }
    let python = runnablePython(status);
    if (!python) {
        const fix = fixLabel(status);
        const answer = await vscode.window.showWarningMessage(
            statusMessage(status) ?? 'This workspace\'s Python environment cannot run step libraries.',
            ...(fix ? [fix] : []));
        if (!fix || answer !== fix || !await deps.environment.fix()) return undefined;
        status = await deps.environment.settled();
        python = runnablePython(status);
        if (!python) return undefined;
    }
    return { ...moduleInvocation(python, runnerArgs), env: deps.environment.runEnv(python) as Record<string, string> };
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

/**
 * A file of a run, in the extension's storage for this workspace: the model the compiler writes,
 * or the report the runner writes. Any earlier one is removed first, so a program that fails
 * without saying so cannot leave the previous run's file to be read as this one's.
 */
async function runFile(context: vscode.ExtensionContext, fileName: string): Promise<vscode.Uri> {
    const folder = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'runs');
    await vscode.workspace.fs.createDirectory(folder);
    const file = vscode.Uri.joinPath(folder, fileName);
    try {
        await vscode.workspace.fs.delete(file);
    } catch {
        // Nothing there yet.
    }
    return file;
}
