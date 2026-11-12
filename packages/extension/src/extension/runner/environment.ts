import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import { execFileText } from '../process-launcher.js';
import { envWithPath } from '../compiler/image-generator.js';
import {
    NO_BASE_PYTHON,
    PROBE_SCRIPT,
    basePythonCandidates,
    chooseBasePython,
    createEnvironmentCommands,
    environmentStatus,
    fixLabel,
    installRunnerCommand,
    parseProbe,
    statusMessage,
    venvPython,
    type EnvironmentStatus,
    type ProjectFacts,
    type PythonCommand,
    type Probe
} from './python-environment.js';

/**
 * The part of the Python extension's API this uses, declared structurally: the extension is an
 * optional companion, not a dependency, so neither its package nor its types are imported
 * (jpipe-vscode ADR-VSC-0026).
 */
interface PythonEnvironmentsApi {
    getActiveEnvironmentPath(resource?: vscode.Uri): { id: string; path: string };
    resolveEnvironment(environment: { id: string; path: string } | string): Promise<{ executable: { uri?: vscode.Uri } } | undefined>;
    updateActiveEnvironmentPath(environment: string, resource?: vscode.Uri): Promise<void>;
    onDidChangeActiveEnvironmentPath: vscode.Event<unknown>;
}

const PYTHON_EXTENSION = 'ms-python.python';
/** Remembers "Not now" for this workspace, so opening it does not ask again. */
const DECLINED_KEY = 'jpipe.runner.environmentDeclined';

/**
 * The Python that runs step libraries — the one VS Code uses — and whether it can.
 *
 * With the Python extension installed, that is the interpreter selected for the workspace folder,
 * the same one Pylance analyses libraries with. Without it, it is the folder's `.venv`, else the
 * `python3` on `PATH`. The status is worked out by asking that interpreter a short question
 * (`PROBE_SCRIPT`) and looking at the folder; `python-environment.ts` decides what it means.
 */
export class RunnerEnvironment implements vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;
    private readonly disposables: vscode.Disposable[] = [this.changeEmitter];
    private current: EnvironmentStatus = { kind: 'no-python' };
    private checking: Promise<void> | undefined;
    private api: PythonEnvironmentsApi | undefined;

    constructor(private readonly context: vscode.ExtensionContext, private readonly logger: JpipeLogger) {
        this.checking = this.connect().then(() => this.check());
    }

    get status(): EnvironmentStatus {
        return this.current;
    }

    /** The status once the check in progress, if any, is done. */
    async settled(): Promise<EnvironmentStatus> {
        await this.checking;
        return this.current;
    }

    private get folder(): vscode.WorkspaceFolder | undefined {
        return vscode.workspace.workspaceFolders?.[0];
    }

    private async connect(): Promise<void> {
        const extension = vscode.extensions.getExtension<{ environments?: PythonEnvironmentsApi }>(PYTHON_EXTENSION);
        if (!extension) return;
        try {
            const exports = extension.isActive ? extension.exports : await extension.activate();
            this.api = exports?.environments;
            if (this.api) {
                this.disposables.push(this.api.onDidChangeActiveEnvironmentPath(() => this.recheck()));
            }
        } catch (err: unknown) {
            this.logger.debug(`The Python extension did not activate: ${messageOf(err)}`);
        }
    }

    recheck(): void {
        this.checking = this.check();
    }

    private async check(): Promise<void> {
        const folder = this.folder;
        const project = this.projectFacts(folder);
        const python = await this.selectedPython(folder, project);
        const probe = python ? await this.probe({ program: python, args: [] }, folder) : undefined;
        this.current = environmentStatus(python, probe, project);
        this.logger.debug(`Runner environment: ${this.current.kind}${python ? ` (${python})` : ''}`);
        this.changeEmitter.fire();
    }

    /** Ask an interpreter what it is; `undefined` if it is not there or does not answer. */
    private async probe(python: PythonCommand, folder: vscode.WorkspaceFolder | undefined): Promise<Probe | undefined> {
        try {
            const { stdout } = await execFileText(python.program, [...python.args, '-c', PROBE_SCRIPT], {
                cwd: folder?.uri.fsPath, timeout: 15_000, windowsHide: true, env: envWithPath()
            });
            return parseProbe(stdout);
        } catch (err: unknown) {
            this.logger.debug(`Could not ask ${python.program} ${python.args.join(' ')} what it is: ${messageOf(err)}`);
            return undefined;
        }
    }

    /** The Python a new environment is made with: the selected one if recent enough, else the best found. */
    private async basePython(selected: string, folder: vscode.WorkspaceFolder | undefined): Promise<PythonCommand | undefined> {
        const answers = [];
        for (const command of basePythonCandidates(selected, process.platform)) {
            const probe = await this.probe(command, folder);
            answers.push({ command, version: probe?.version });
            const chosen = chooseBasePython(answers);
            if (chosen) {
                this.logger.info(`Creating the environment with ${[chosen.program, ...chosen.args].join(' ')} (Python ${probe?.version.join('.')})`);
                return chosen;
            }
        }
        return undefined;
    }

    private projectFacts(folder: vscode.WorkspaceFolder | undefined): ProjectFacts {
        if (!folder) return {};
        const root = folder.uri.fsPath;
        const localVenvPython = ['.venv', 'venv']
            .map(dir => venvPython(path.join(root, dir), process.platform))
            .find(file => fs.existsSync(file));
        const manager = fs.existsSync(path.join(root, 'Pipfile')) ? 'Pipenv' as const
            : fs.existsSync(path.join(root, 'poetry.lock')) ? 'Poetry' as const
            : undefined;
        return { ...(localVenvPython ? { localVenvPython } : {}), ...(manager ? { manager } : {}) };
    }

    private async selectedPython(folder: vscode.WorkspaceFolder | undefined, project: ProjectFacts): Promise<string | undefined> {
        if (this.api) {
            try {
                const active = this.api.getActiveEnvironmentPath(folder?.uri);
                const resolved = await this.api.resolveEnvironment(active);
                return resolved?.executable.uri?.fsPath ?? active.path;
            } catch (err: unknown) {
                this.logger.debug(`The Python extension could not say which interpreter is selected: ${messageOf(err)}`);
            }
        }
        return project.localVenvPython ?? (process.platform === 'win32' ? 'python' : 'python3');
    }

    /** The one-line explanation for the Libraries view, if anything needs doing. */
    message(): string | undefined {
        return statusMessage(this.current);
    }

    /**
     * Offer the fix, once per workspace unless `insist` — a run asked for, rather than a workspace
     * opened. Resolves to whether the environment is ready afterwards.
     */
    async offer(insist: boolean): Promise<boolean> {
        const status = await this.settled();
        if (status.kind === 'ready') return true;
        const label = fixLabel(status);
        const message = statusMessage(status);
        if (!label || !message) {
            if (insist && message) void vscode.window.showWarningMessage(message);
            return false;
        }
        if (!insist && this.context.workspaceState.get<boolean>(DECLINED_KEY)) return false;
        const notNow = 'Not Now';
        const answer = await vscode.window.showInformationMessage(message, label, notNow);
        if (answer === label) return this.fix();
        if (answer === notNow) await this.context.workspaceState.update(DECLINED_KEY, true);
        return false;
    }

    /** Do what `fixLabel` promised for the current status. */
    async fix(): Promise<boolean> {
        const status = await this.settled();
        const folder = this.folder;
        this.logger.info(`Fixing the runner environment: ${status.kind}`);
        switch (status.kind) {
            case 'missing-runner': {
                const { program, args } = installRunnerCommand(status.python);
                await this.runStep('Install jpipe-runner', program, args, folder);
                break;
            }
            case 'unselected-venv':
                await this.select(status.venvPython, folder);
                break;
            case 'no-environment': {
                if (!folder) return false;
                const base = await this.basePython(status.python, folder);
                if (!base) {
                    void vscode.window.showErrorMessage(NO_BASE_PYTHON);
                    return false;
                }
                let created = true;
                for (const step of createEnvironmentCommands(base, folder.uri.fsPath, process.platform)) {
                    if (!await this.runStep(step.name, step.program, step.args, folder)) {
                        created = false;
                        break;
                    }
                }
                if (created) await this.select(venvPython(path.join(folder.uri.fsPath, '.venv'), process.platform), folder);
                break;
            }
            case 'managed':
            case 'old-python':
                await vscode.commands.executeCommand('python.setInterpreter');
                break;
            default:
                break;
        }
        this.recheck();
        return (await this.settled()).kind === 'ready';
    }

    /**
     * Make `python` the workspace folder's interpreter, through the Python extension when there is
     * one. The extension may refuse an environment it has not discovered yet; then the user is
     * asked to pick it, rather than left with an environment nothing uses.
     */
    private async select(python: string, folder: vscode.WorkspaceFolder | undefined): Promise<void> {
        if (!fs.existsSync(python)) {
            this.logger.error(`Cannot select ${python}: it does not exist.`);
            return;
        }
        const ask = `Select ${python} as this workspace's Python interpreter, so the editor and runs use the same one.`;
        if (!this.api) {
            void vscode.window.showInformationMessage(ask);
            return;
        }
        try {
            await this.api.updateActiveEnvironmentPath(python, folder?.uri);
            this.logger.info(`Selected ${python} as the workspace's Python interpreter.`);
        } catch (err: unknown) {
            this.logger.error(`The Python extension did not select ${python}: ${messageOf(err)}`);
            const pick = 'Select Interpreter';
            if (await vscode.window.showWarningMessage(ask, pick) === pick) {
                await vscode.commands.executeCommand('python.setInterpreter');
            }
        }
    }

    /**
     * One step, in a terminal the user can watch; resolves to whether it succeeded.
     *
     * Each step is its own task — its name is part of its identity — so a second step started as
     * the first ends is not taken for the first one still running. The end is matched by that
     * identity, and listened for before the task starts: a step that fails at once, a missing
     * program say, can end before `executeTask` has even resolved. A task that ends without its
     * process reporting an exit code never started, which is a failure too.
     */
    private runStep(name: string, program: string, args: string[], folder: vscode.WorkspaceFolder | undefined): Promise<boolean> {
        const definition = { type: 'jpipe', model: name };
        const task = new vscode.Task(
            definition,
            folder ?? vscode.TaskScope.Workspace,
            name,
            'jPipe',
            new vscode.ProcessExecution(program, args, { cwd: folder?.uri.fsPath, env: envWithPath() as Record<string, string> })
        );
        task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared, clear: false };
        const ours = (e: { execution: vscode.TaskExecution }) =>
            e.execution.task.source === 'jPipe' && e.execution.task.definition.model === name;
        this.logger.info(`${name}: ${program} ${args.join(' ')}`);
        return new Promise(resolve => {
            let exitCode: number | undefined;
            const finish = (ok: boolean) => {
                subscriptions.forEach(s => s.dispose());
                this.logger.info(`${name}: ${ok ? 'done' : `failed${exitCode !== undefined ? ` (exit code ${exitCode})` : ''}`}`);
                resolve(ok);
            };
            const subscriptions = [
                vscode.tasks.onDidEndTaskProcess(e => { if (ours(e)) exitCode = e.exitCode; }),
                vscode.tasks.onDidEndTask(e => { if (ours(e)) finish(exitCode === 0); })
            ];
            vscode.tasks.executeTask(task).then(undefined, (err: unknown) => {
                void vscode.window.showErrorMessage(`${name} could not start: ${messageOf(err)}`);
                finish(false);
            });
        });
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
    }
}
