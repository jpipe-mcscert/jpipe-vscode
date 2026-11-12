import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import { execFileText } from '../process-launcher.js';
import {
    PROBE_SCRIPT,
    createEnvironmentCommands,
    environmentStatus,
    fixLabel,
    installRunnerCommand,
    parseProbe,
    statusMessage,
    venvPython,
    type EnvironmentStatus,
    type ProjectFacts
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
        let probe;
        if (python) {
            try {
                const { stdout } = await execFileText(python, ['-c', PROBE_SCRIPT], {
                    cwd: folder?.uri.fsPath, timeout: 15_000, windowsHide: true
                });
                probe = parseProbe(stdout);
            } catch (err: unknown) {
                this.logger.debug(`Could not ask ${python} about jpipe-runner: ${messageOf(err)}`);
            }
        }
        this.current = environmentStatus(python, probe, project);
        this.logger.debug(`Runner environment: ${this.current.kind}${python ? ` (${python})` : ''}`);
        this.changeEmitter.fire();
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
                for (const { program, args } of createEnvironmentCommands(status.python, folder.uri.fsPath, process.platform)) {
                    if (!await this.runStep('Create Python environment', program, args, folder)) break;
                }
                await this.select(venvPython(path.join(folder.uri.fsPath, '.venv'), process.platform), folder);
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

    /** Make `python` the workspace folder's interpreter, through the Python extension when there is one. */
    private async select(python: string, folder: vscode.WorkspaceFolder | undefined): Promise<void> {
        if (!fs.existsSync(python)) return;
        if (this.api) {
            await this.api.updateActiveEnvironmentPath(python, folder?.uri);
        } else {
            void vscode.window.showInformationMessage(`Use ${python} as this workspace's Python interpreter so the editor and runs agree.`);
        }
    }

    /** One step, in a terminal the user can watch; resolves to whether it succeeded. */
    private runStep(name: string, program: string, args: string[], folder: vscode.WorkspaceFolder | undefined): Promise<boolean> {
        const task = new vscode.Task(
            { type: 'jpipe', model: name },
            folder ?? vscode.TaskScope.Workspace,
            name,
            'jPipe',
            new vscode.ProcessExecution(program, args, { cwd: folder?.uri.fsPath })
        );
        task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared, clear: false };
        return new Promise(resolve => {
            let execution: vscode.TaskExecution | undefined;
            const subscription = vscode.tasks.onDidEndTaskProcess(e => {
                if (e.execution !== execution) return;
                subscription.dispose();
                resolve(e.exitCode === 0);
            });
            vscode.tasks.executeTask(task).then(started => { execution = started; }, (err: unknown) => {
                subscription.dispose();
                void vscode.window.showErrorMessage(`${name} could not start: ${messageOf(err)}`);
                resolve(false);
            });
        });
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
    }
}
