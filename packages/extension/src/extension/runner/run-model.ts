import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import type { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import { findDiagramName } from '../compiler/compiler-invocation.js';
import { ImageFormat, type ImageGenerator } from '../compiler/image-generator.js';
import type { Model } from '../models-view/models-tree.js';
import type { ModelsView } from '../models-view/models-view.js';
import type { LibrariesView } from './libraries-view.js';
import { MODELS_VIEW_ID } from '../models-view/models-view.js';
import { RUNNER_COMMAND_SETTING, cannotRun, resolveRunner, runnerArguments } from './runner-invocation.js';
import type { RunnerEnvironment } from './environment.js';
import { fixLabel, moduleInvocation, runnablePython, statusMessage, type Command } from './python-environment.js';
import type { ResultsView } from './results-view.js';
import type { LibraryStep } from './step-binding.js';
import { parseReport, verdictSentence, withReport, type RunReport } from './run-report.js';
import type { RunSession } from './run-session.js';
import type { RunPanel } from './run-panel.js';
import type { Notice } from '../../shared/run-protocol.js';

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
    session: RunSession;
    panel: RunPanel;
}

/**
 * What jpipe-runner exits with when a file could not be read or written: a diagram among them,
 * which includes a drawing that needs Graphviz when it is not installed. Nothing ran then.
 */
const FILE_PROBLEM_EXIT = 4;

/**
 * Save what a run reads: the compiler and the runner read files, not editors. That is the model,
 * the libraries the run loads, and every other jPipe file with unsaved changes, since the model
 * may load any of them and the run must be of the model as the editor shows it. The file that
 * could not be saved, if one could not.
 */
async function saveInputs(document: vscode.TextDocument, libraries: readonly vscode.Uri[]): Promise<vscode.Uri | undefined> {
    const loaded = new Set(libraries.map(uri => uri.toString()));
    const inputs = new Set([document, ...vscode.workspace.textDocuments
        .filter(open => open.languageId === 'jpipe' || loaded.has(open.uri.toString()))]);
    const unsaved = [...inputs].filter(input => input.isDirty);
    const saved = await Promise.all(unsaved.map(input => input.save()));
    return unsaved.find((_, i) => !saved[i])?.uri;
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
    token: number,
    document: vscode.TextDocument,
    name: string
): Promise<RunFiles | undefined> {
    const folder = await runFolder(deps.context);
    try {
        const compiled = vscode.Uri.joinPath(folder, `${name}.json`);
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Compiling ${name}…` },
            () => deps.imageGenerator.generate(false, ImageFormat.JSON, document, name, compiled));
        return {
            folder,
            compiled,
            report: vscode.Uri.joinPath(folder, `${name}.report.json`),
            dataflow: vscode.Uri.joinPath(folder, `${name}-dataflow.svg`)
        };
    } catch (err: unknown) {
        deps.logger.warn(`${name} could not be compiled: ${messageOf(err)}`);
        deps.session.endWith(token, 'blocked', {
            text: `${name} could not be compiled, so it cannot be run: ${messageOf(err)}`,
            action: { label: 'Show Problems', id: 'showProblems' }
        });
        await discard(folder);
        return undefined;
    }
}

/** The files of one run, all in its own folder: the compiled model, and what the runner writes. */
interface RunFiles {
    folder: vscode.Uri;
    compiled: vscode.Uri;
    report: vscode.Uri;
    /** The drawing of the run's dataflow (jpipe-runner ADR-0022). */
    dataflow: vscode.Uri;
}

/**
 * Run a justification with jpipe-runner: the ▶ button.
 *
 * The model is the one given (a Models row, or the run panel's own), or else the one the cursor is
 * in. It is compiled to JSON by the jPipe compiler — the same call as Export as JSON — and the
 * runner is launched as a VS Code task, the way it would be in CI, and asked to write its JSON
 * report to a file (`--report`) and to draw the run's dataflow. The run panel opens as the run
 * starts and shows it under way, then its drawing and verdict, and the Results view lists the
 * report (jpipe-vscode ADR-VSC-0029, ADR-VSC-0031). What stops a run before it starts — no library
 * checked, a model that does not compile, no environment to run in — is said in the panel too.
 * The task's terminal is where the steps print; it stays in the background unless the run ended
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

    // The libraries and their steps as this run loads them: the libraries checked may change while
    // it runs. What it reads is saved before it begins, so that its own saves are not changes made
    // since it began, which would put it out of date (ADR-VSC-0031).
    const libraries = deps.libraries.checkedLibraries();
    const steps = deps.libraries.checkedSteps();
    const unsaved = libraries.length > 0 ? await saveInputs(document, libraries.map(library => library.uri)) : undefined;
    const token = deps.session.begin(name, document.uri.toString(), check, libraries.map(library => ({
        path: library.uri.fsPath,
        display: vscode.workspace.asRelativePath(library.uri)
    })));
    deps.panel.reveal();
    if (libraries.length === 0) {
        deps.session.endWith(token, 'blocked', {
            text: 'No step library is checked. Check the libraries this run should load in the jPipe Libraries view.',
            action: { label: 'Show Libraries', id: 'showLibraries' }
        });
        return;
    }
    if (unsaved) {
        deps.session.endWith(token, 'blocked', {
            text: `${name} was not ${check ? 'checked' : 'run'}: ${vscode.workspace.asRelativePath(unsaved)} could not be saved, and a run reads files as they are saved.`,
            action: null
        });
        return;
    }
    const files = await compile(deps, token, document, name);
    if (!files) return;
    try {
        await launch(deps, token, { document, name, check, libraries: libraries.map(library => library.uri.fsPath), steps }, files, true);
    } finally {
        await discard(files.folder);
    }
}

/** What a run is of, as `runModel` settled it. */
interface Run {
    document: vscode.TextDocument;
    name: string;
    check: boolean;
    /** The libraries it loads, and their steps as they were when it started. */
    libraries: string[];
    steps: LibraryStep[];
}

/**
 * Start the runner on a compiled model, wait for it, and show what its report says.
 *
 * With `draw`, the runner draws the run's dataflow as well. A drawing needs Graphviz, and a
 * runner that cannot draw stops before any step runs, writing no report; so when a run asked to
 * draw ends that way, it is launched once more without the drawing, which costs nothing since
 * nothing ran, and the panel says why it has none.
 */
async function launch(deps: RunDeps, token: number, run: Run, files: RunFiles, draw: boolean): Promise<void> {
    const { document, name, check } = run;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const cwd = folder?.uri.fsPath ?? path.dirname(document.uri.fsPath);
    const runnerArgs = withReport(runnerArguments(run.libraries, files.compiled.fsPath), files.report.fsPath, check, draw ? files.dataflow.fsPath : undefined);
    const invocation = await chooseInvocation(deps, token, folder, runnerArgs);
    if (!invocation) return;
    // Compiling and finding the environment take time, in which another run may have started, or
    // this one been stopped: a run no longer on show is never launched, where no ■ could reach it.
    if (!deps.session.isCurrent(token)) {
        deps.logger.info(`${name}: not launched, a newer run has taken its place`);
        return;
    }
    if (deps.session.stopped(token)) {
        deps.session.endWith(token, 'stopped', { text: `${name} was stopped before it started.`, action: null });
        return;
    }
    deps.logger.info(`${check ? 'Checking' : 'Running'} ${name}: ${invocation.program} ${invocation.args.join(' ')} (in ${cwd})`);

    const task = runTask(run, folder, cwd, invocation);
    const showOutput = (): void => terminalOf(task)?.show();
    let exitCode: number | undefined;
    try {
        exitCode = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `${check ? 'Checking' : 'Running'} ${name}…` },
            () => executed(task, execution => deps.session.attach(token, execution, showOutput)));
    } catch (err: unknown) {
        deps.session.endWith(token, 'blocked', { text: `Could not start jpipe-runner: ${messageOf(err)}`, action: null });
        return;
    }

    const read = await readReport(files.report);
    const ended: Ended = { taskName: task.name, exitCode, cwd, showOutput };
    if ('problem' in read) {
        await endedWithoutReport(deps, token, run, files, draw, ended, read.problem);
    } else {
        await showReport(deps, token, run, files, ended, read.report);
    }
}

/** How a run's task ended, for what is said about it. */
interface Ended {
    taskName: string;
    exitCode: number | undefined;
    /** Where it ran: the report's paths are relative to it. */
    cwd: string;
    /** Bring its terminal forward. */
    showOutput: () => void;
}

/** The task a run is launched as: a build-like action with a terminal of its own, kept in the background. */
function runTask(
    run: Run,
    folder: vscode.WorkspaceFolder | undefined,
    cwd: string,
    invocation: Command & { env?: Record<string, string> }
): vscode.Task {
    const { program, args, env } = invocation;
    const task = new vscode.Task(
        { type: RUN_TASK_TYPE, model: run.name },
        folder ?? vscode.TaskScope.Workspace,
        `${run.check ? 'Check' : 'Run'} ${run.name}`,
        'jPipe',
        new vscode.ProcessExecution(program, args, { cwd, ...(env ? { env } : {}) })
    );
    task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Never,
        panel: vscode.TaskPanelKind.Dedicated,
        clear: true,
        showReuseMessage: false
    };
    return task;
}

/**
 * Say why a run ended without a report: a usage error, a file that could not be read, a runner
 * that did not start — or one that could not draw, which is launched once more without drawing.
 */
async function endedWithoutReport(
    deps: RunDeps, token: number, run: Run, files: RunFiles, draw: boolean, ended: Ended, problem: string
): Promise<void> {
    const { name, check } = run;
    deps.logger.warn(`${ended.taskName} ended with exit code ${ended.exitCode ?? '(none)'}: ${problem}`);
    // A run another has taken the place of says nothing more: no second launch, no terminal
    // brought over the one the panel now speaks for.
    if (!deps.session.isCurrent(token)) return;
    if (deps.session.stopped(token)) {
        deps.session.endWith(token, 'stopped', { text: `${name} was stopped.`, action: { label: 'Show Output', id: 'showOutput' } });
        return;
    }
    if (draw && ended.exitCode === FILE_PROBLEM_EXIT) {
        deps.logger.warn(`${ended.taskName}: launched again without the drawing, which may need Graphviz`);
        await launch(deps, token, run, files, false);
        return;
    }
    ended.showOutput();
    deps.session.endWith(token, 'blocked', {
        text: `${name} was not ${check ? 'checked' : 'run'}: ${problem}. What jpipe-runner printed is in the terminal.`,
        action: { label: 'Show Output', id: 'showOutput' }
    });
}

/** Show a run's report and its drawing, in the panel and in Results, unless a newer run has taken its place. */
async function showReport(deps: RunDeps, token: number, run: Run, files: RunFiles, ended: Ended, report: RunReport): Promise<void> {
    const { name, check, steps } = run;
    deps.logger.info(`${ended.taskName}: ${verdictSentence(report, name, check)}`);
    if (!deps.session.isCurrent(token)) {
        deps.logger.info(`${ended.taskName}: not shown, a newer run has taken its place`);
        return;
    }
    const dataflow = await readText(files.dataflow, report.dataflow);
    const shown = deps.session.update(token, {
        phase: 'done',
        report,
        dataflow,
        drawingMissing: dataflow ? null : NO_DRAWING,
        endedAt: new Date(),
        notice: null
    });
    // A newer run may have started while the drawing was read: Results stays with it, as the panel does.
    if (!shown) return;
    await deps.results.show({ report, name, check, cwd: ended.cwd, steps, showOutput: ended.showOutput });
}

/** Why a run has no drawing: the runner could not draw, which is most often Graphviz missing. */
const NO_DRAWING = 'jpipe-runner could not draw this run. Drawing needs Graphviz\'s dot command, as the preview does: run Check jPipe Installation to see whether it is installed.';

/** The SVG the runner drew in `file`, when its report says it drew one. */
async function readText(file: vscode.Uri, recorded: string | null): Promise<string | null> {
    if (recorded === null) return null;
    try {
        return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(file));
    } catch {
        return null;
    }
}

/**
 * Run or check again the justification the run panel shows: the panel's ▶ and ✓. It is looked up
 * among the workspace's models, by name in its document, since it may have been renamed or removed
 * since; the panel says so then.
 */
export async function runShownAgain(deps: RunDeps, check: boolean): Promise<void> {
    const shown = deps.session.run;
    if (!shown) return;
    const model = (await deps.models.freshModels())
        .find(m => m.name === shown.name && vscode.Uri.parse(m.uri).toString() === shown.uri);
    if (!model) {
        deps.session.say({
            text: `${shown.name} is no longer in ${vscode.workspace.asRelativePath(vscode.Uri.parse(shown.uri))}: run a justification from its editor or the Models view.`,
            action: null
        });
        return;
    }
    await runModel(deps, model, check);
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
 * The end is listened for before the task starts, because a task that fails at once, a missing
 * program say, can end before `executeTask` resolves. Every end is therefore noted until then,
 * and the one waited for is that of the very execution `executeTask` resolves to: another task
 * of the same name, a run of a model so named in another folder, is not this one.
 */
function executed(task: vscode.Task, started: (execution: vscode.TaskExecution) => void): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
        const exitCodes = new Map<vscode.TaskExecution, number | undefined>();
        const ended = new Set<vscode.TaskExecution>();
        let execution: vscode.TaskExecution | undefined;
        const done = (settle: () => void): void => {
            for (const listener of listeners) listener.dispose();
            settle();
        };
        const settleIfEnded = (): void => {
            if (!execution || !ended.has(execution)) return;
            const exitCode = exitCodes.get(execution);
            done(() => resolve(exitCode));
        };
        const listeners = [
            vscode.tasks.onDidEndTaskProcess(e => exitCodes.set(e.execution, e.exitCode)),
            // Fires after the process's own event, and alone when there was no process.
            vscode.tasks.onDidEndTask(e => {
                ended.add(e.execution);
                settleIfEnded();
            })
        ];
        vscode.tasks.executeTask(task).then(
            begun => {
                execution = begun;
                started(begun);
                settleIfEnded();
            },
            (err: unknown) => done(() => reject(err)));
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
    token: number,
    folder: vscode.WorkspaceFolder | undefined,
    runnerArgs: string[]
): Promise<(Command & { env?: Record<string, string> }) | undefined> {
    const status = await deps.environment.settled();
    if (status.kind === 'external') {
        const configured = vscode.workspace.getConfiguration('jpipe', folder?.uri).get<string>(RUNNER_COMMAND_SETTING, '') ?? '';
        return { program: resolveRunner(configured, os.homedir()), args: runnerArgs };
    }
    const python = runnablePython(status);
    if (!python) {
        // Said in the panel, with the fix on its button; the run is started again once it is done.
        const fix = fixLabel(status);
        const notice: Notice = {
            text: statusMessage(status) ?? 'This workspace\'s Python environment cannot run step libraries.',
            action: fix ? { label: fix, id: 'fixEnvironment' } : null
        };
        deps.session.endWith(token, 'blocked', notice);
        return undefined;
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
    const kind = (await deps.models.freshModels())
        .find(m => m.name === name && vscode.Uri.parse(m.uri).toString() === uri)?.kind;
    return { document: editor.document, name, kind };
}

/** How many runs this window has started: what tells one run's folder from another's. */
let runs = 0;

/**
 * A folder of its own for one run, in the extension's storage for this workspace: where the
 * compiler writes the model and the runner its report. Each run has its own, so two runs under
 * way at once, a run and a check of one model say, or two models of one name, never read or
 * replace each other's files, and a report found there can only be this run's. It is removed
 * once the run has been read.
 */
async function runFolder(context: vscode.ExtensionContext): Promise<vscode.Uri> {
    const folder = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'runs', `${Date.now()}-${runs++}`);
    await vscode.workspace.fs.createDirectory(folder);
    return folder;
}

/** Remove a run's folder. What is left behind if it cannot be is a few small files in the extension's storage. */
async function discard(folder: vscode.Uri): Promise<void> {
    try {
        await vscode.workspace.fs.delete(folder, { recursive: true });
    } catch {
        // Nothing to do about it, and nothing depends on it.
    }
}
