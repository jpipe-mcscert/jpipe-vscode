import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import { runInTerminal } from './step-terminal.js';
import { installPylance, pylanceInstalled } from './pylance.js';
import { PYLANCE_OFFER, pylanceLine } from '../requirements.js';
import { execFileText } from '../process-launcher.js';
import { envWithPath } from '../compiler/image-generator.js';
import { expandTilde } from '../compiler/compiler-invocation.js';
import {
    GLOBAL_RUNNER_VERSION,
    NO_BASE_PYTHON,
    PROBE_SCRIPT,
    VENV_DIRECTORIES,
    activatedEnvironment,
    declaredVersion,
    overInherited,
    addRunnerCommand,
    basePythonCandidates,
    chooseBasePython,
    createEnvironmentCommands,
    detectManager,
    environmentNickname,
    environmentReport,
    environmentStatus,
    fixConsequences,
    fixLabel,
    installRunnerCommand,
    isPythonProject,
    isRunnerImportProblem,
    locateEnvironmentCommand,
    parseEnvironmentPath,
    parseProbe,
    parseRunnerVersion,
    requirementChangeKind,
    requirementsFile,
    restorePublishedCommands,
    moduleInvocation,
    runnablePython,
    runnerRequirement,
    statusMessage,
    venvPython,
    withRunnerRequirement,
    withoutActiveEnvironment,
    workspaceEnvironment,
    type Command,
    type EditorSelection,
    type EnvironmentFacts,
    type EnvironmentStatus,
    type FixStep,
    type Manager,
    type PythonCommand,
    type Probe,
    type RequirementChange,
    type WorkspaceEnvironment
} from './python-environment.js';
import { ENVIRONMENT_SETTING, LOCAL_SOURCE_SETTING, OFFER_SETUP_SETTING, SELECT_IN_EDITOR_SETTING, type EnvironmentMode } from './runner-invocation.js';

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

/**
 * The part of the Python Environments extension's API this uses, declared structurally for the
 * same reason. Where it is installed, it is the one that decides a folder's environment — from
 * the manager recorded in the folder's settings, then that manager's stored choice — so a
 * selection made through the Python extension's older API does not last: the recorded manager
 * hands its own choice back. Selecting through this API records the manager too.
 */
interface PythonEnvsEnvironment {
    execInfo?: { run?: { executable?: string } };
    environmentPath?: vscode.Uri;
}
interface PythonEnvsApi {
    resolveEnvironment(context: vscode.Uri): Promise<PythonEnvsEnvironment | undefined>;
    getEnvironment(scope: vscode.Uri | undefined): Promise<PythonEnvsEnvironment | undefined>;
    setEnvironment(scope: vscode.Uri | undefined, environment?: PythonEnvsEnvironment): Promise<void>;
    refreshEnvironments(scope: vscode.Uri | undefined): Promise<void>;
    onDidChangeEnvironment?: vscode.Event<unknown>;
}

/** Whether `root` has a file of that name, as the pure decisions ask it. */
const existsIn = (root: string) => (file: string): boolean => fs.existsSync(path.join(root, file));

/** The tool managing the project at `root`, from the files it keeps there. */
function environmentManager(root: string): Manager | undefined {
    return detectManager(
        existsIn(root),
        file => {
            try {
                return fs.readFileSync(path.join(root, file), 'utf8');
            } catch {
                return undefined;
            }
        });
}

const PYTHON_EXTENSION = 'ms-python.python';
const PYTHON_ENVS_EXTENSION = 'ms-python.vscode-python-envs';
/** Remembers "Not now" for this workspace, so opening it does not ask again. */
const DECLINED_KEY = 'jpipe.runner.environmentDeclined';
/** The same, for the offer to install Pylance. */
const PYLANCE_DECLINED_KEY = 'jpipe.runner.pylanceDeclined';
/** The interpreter last selected for the editor from here, so a later choice of the user's is left alone. */
const SELECTED_KEY = 'jpipe.runner.selectedEnvironment';

/** Whether two interpreter paths are the same environment's: its directory, not what the link points to. */
function sameInterpreter(a: string, b: string): boolean {
    try {
        return fs.realpathSync(path.dirname(a)) === fs.realpathSync(path.dirname(b));
    } catch {
        return path.normalize(a) === path.normalize(b);
    }
}

/** What a check found, in one line, for the log. */
function checkSummary(kind: string, facts: EnvironmentFacts, requirement: string): string {
    const { environment, probe } = facts;
    let workspace = `${kind}; the workspace's is ${environment.python ?? 'not there yet'}`;
    if (environment.manager) workspace += ` (${environment.manager})`;
    if (probe) workspace += `, jpipe-runner ${runnerSummary(probe)}`;
    const parts = [workspace];
    if (facts.localSource) parts.push(`the settings name the local jpipe-runner ${facts.localSource}`);
    // `null` is an editor with no Python extension, which has no interpreter to name.
    if (facts.editorPython !== null) parts.push(`the editor uses ${facts.editorPython ?? 'none'}`);
    parts.push(`this machine's jpipe-runner is ${facts.machineRunner ?? 'not installed'}, so pip installs ${requirement}`);
    return `Runner environment: ${parts.join('; ')}`;
}

function runnerSummary(probe: Probe): string {
    if (!probe.hasRunner) return 'not found';
    const version = probe.runnerVersion ?? 'found';
    return probe.localSource ? `${version} from ${probe.localSource}` : version;
}

/** A requirements file as a fix would leave it. */
interface RequirementEdit extends RequirementChange {
    path: string;
    content: string;
}

/**
 * The workspace's own Python environment — the one step libraries run with — and whether it can.
 *
 * It is found by looking at the workspace folder, never by asking which interpreter is selected:
 * the environment its Pipenv, Poetry or uv project keeps, else a virtual environment at its root
 * (`python-environment.ts` decides). With the Python extension installed, the editor is pointed at
 * that environment, so Pylance analyses libraries with the Python that runs them. Every program
 * started to look at or change it runs without whatever environment VS Code inherited.
 */
export class RunnerEnvironment implements vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;
    private readonly disposables: vscode.Disposable[] = [this.changeEmitter];
    private current: EnvironmentStatus = { kind: 'checking' };
    /** Whether the editor's own complaint about `jpipe_runner` has been answered in this window. */
    private answeredEditor = false;
    private checking: Promise<void> = Promise.resolve();
    /** Whether a check is waiting for the one under way to end. */
    private queued = false;
    private api: PythonEnvironmentsApi | undefined;
    private envs: PythonEnvsApi | undefined;
    /** What pip installs: the machine's own jpipe-runner release, when it has one. Project files record the minimum. */
    private requirement = runnerRequirement(undefined);
    /** What the last check found, for the report. */
    private facts: EnvironmentFacts = { environment: {} };

    constructor(private readonly context: vscode.ExtensionContext, private readonly logger: JpipeLogger) {
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('jpipe.runner') && !e.affectsConfiguration('jpipe.runner.libraries')) this.recheck();
            }),
            vscode.languages.onDidChangeDiagnostics(e => {
                const flagged = e.uris.find(uri => this.flagsRunnerImport(uri));
                if (flagged) void this.answerEditor(flagged);
            }),
            // The same fix, on the line the editor underlines: where the problem is looked at.
            vscode.languages.registerCodeActionsProvider({ language: 'python' }, {
                provideCodeActions: (_document, _range, context) => {
                    const flagged = context.diagnostics.filter(d => isRunnerImportProblem(d.message));
                    if (flagged.length === 0) return [];
                    this.logger.debug(`Offering the environment quick fix on: ${flagged[0].message}`);
                    const action = new vscode.CodeAction('Set up the Python environment for jpipe-runner', vscode.CodeActionKind.QuickFix);
                    action.command = { command: 'jpipe.runner.fixEnvironment', title: action.title };
                    action.diagnostics = flagged;
                    action.isPreferred = true;
                    return [action];
                }
            }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] })
        );
    }

    private flagsRunnerImport(uri: vscode.Uri): boolean {
        return uri.path.endsWith('.py')
            && vscode.workspace.getWorkspaceFolder(uri) !== undefined
            && vscode.languages.getDiagnostics(uri).some(d => isRunnerImportProblem(d.message));
    }

    /**
     * The editor has flagged a `jpipe_runner` import: say what to do about it, once per window.
     *
     * Asked afresh rather than read from the last check, since the flag may be the first sign that
     * the environment changed underneath. An earlier "Not Now" does not silence this: it was said
     * about a prompt on opening the workspace, and this answers a warning the user is looking at.
     * When the workspace's environment is in order and selected, the editor is merely behind,
     * and nothing is said: the Set Up command is there for a flag that does not go away.
     * Every decision is logged, since a prompt that does not come is otherwise unexplained.
     */
    private async answerEditor(uri: vscode.Uri): Promise<void> {
        if (this.answeredEditor || !this.setting(OFFER_SETUP_SETTING, true) || this.mode === 'command') return;
        this.answeredEditor = true;
        this.recheck();
        const status = await this.settled();
        const where = vscode.workspace.asRelativePath(uri);
        this.logger.info(`The editor flags a jpipe_runner import in ${where}; the runner environment is ${status.kind}.`);
        if (status.kind === 'ready') {
            // Nothing is wrong on our side and nothing was asked: the editor is catching up with
            // an environment it was just pointed at, and a notification would only be noise.
            return;
        }
        const label = fixLabel(status);
        const message = statusMessage(status);
        if (!label || !message) {
            this.logger.info('No fix can be offered for that status.');
            return;
        }
        const answer = await vscode.window.showWarningMessage(`The editor cannot find jpipe-runner. ${message}`, label, 'Not Now');
        this.logger.info(`Offered "${label}": ${answer ?? 'dismissed'}.`);
        if (answer === label) await this.fix();
    }

    /**
     * Set the environment up, asked for outright: from the Libraries view, the palette, or the
     * lightbulb on a flagged import. Looks again first, so it acts on the workspace as it is now
     * rather than as it was when the window opened, and always says something: either the fix
     * that fits, carried out once agreed to, or that the workspace is ready. That last is a
     * notification only when the editor still flags a `jpipe_runner` import, the one case with
     * something left to do; otherwise it is a few seconds in the status bar.
     */
    async setUp(): Promise<boolean> {
        this.recheck();
        const status = await this.settled();
        if (status.kind === 'external') {
            const open = 'Open Settings';
            const answer = await vscode.window.showInformationMessage(
                'Runs use the runner command named in the settings, so jPipe does not manage a Python environment for this workspace. Set the execution environment to "workspace" to have it set one up.', open);
            if (answer === open) await vscode.commands.executeCommand('workbench.action.openSettings', 'jpipe.runner');
            return true;
        }
        if (status.kind !== 'ready') return this.fix();
        const ready = `This workspace is ready to run your models${this.localRunner ? ' with your local jpipe-runner' : ''}.`;
        // Nothing to do and nothing to decide: a passing word, not a notification to dismiss.
        if (!vscode.languages.getDiagnostics().some(([uri]) => this.flagsRunnerImport(uri))) {
            vscode.window.setStatusBarMessage(`$(check) ${ready}`, 5000);
            return true;
        }
        const refresh = 'Refresh the Editor';
        const answer = await vscode.window.showInformationMessage(
            `${ready} The editor still underlines jpipe_runner imports: refresh it.`, refresh);
        if (answer === refresh) await this.tryCommand('python.analysis.restartLanguageServer');
        return true;
    }

    /** A command of the Python extension, which may not be installed. */
    private async tryCommand(command: string): Promise<void> {
        try {
            await vscode.commands.executeCommand(command);
        } catch (err: unknown) {
            this.logger.error(`${command} is not available: ${messageOf(err)}`);
            void vscode.window.showWarningMessage('That needs the Python extension, which is not installed.');
        }
    }

    /** Look at the workspace for the first time. Called once, as the extension activates. */
    start(): void {
        const first = (): Promise<void> => this.checked();
        this.checking = this.connect().then(first, first);
        // The editor may have flagged the import before this extension was listening: Pylance
        // does not wait for us. Look at what is already there once the first check is in.
        void this.checking.then(() => {
            const flagged = vscode.languages.getDiagnostics().find(([uri]) => this.flagsRunnerImport(uri));
            if (flagged) void this.answerEditor(flagged[0]);
        });
    }

    get status(): EnvironmentStatus {
        return this.current;
    }

    /** The status once the check in progress, if any, is done. */
    async settled(): Promise<EnvironmentStatus> {
        const awaited = this.checking;
        await awaited;
        // A check asked for while waiting is the one whose answer is wanted.
        return awaited === this.checking ? this.current : this.settled();
    }

    private get folder(): vscode.WorkspaceFolder | undefined {
        return vscode.workspace.workspaceFolders?.[0];
    }

    private setting<T>(name: string, fallback: T): T {
        return vscode.workspace.getConfiguration('jpipe', this.folder?.uri).get<T>(name, fallback) ?? fallback;
    }

    /** The local jpipe-runner checkout the settings name, as a path, or `undefined` for none. */
    private get localSource(): string | undefined {
        const configured = this.setting<string>(LOCAL_SOURCE_SETTING, '').trim();
        return configured ? path.resolve(expandTilde(configured, os.homedir())) : undefined;
    }

    /** The local checkout the workspace's environment runs, when it does: shown, so it is not mistaken for a release. */
    get localRunner(): string | undefined {
        return runnablePython(this.current) ? this.facts.probe?.localSource : undefined;
    }

    private get mode(): EnvironmentMode {
        return this.setting<string>(ENVIRONMENT_SETTING, 'workspace') === 'command' ? 'command' : 'workspace';
    }

    /**
     * Check the Python Environment for Runs: look again, and say what was found — the status in a
     * sentence, the facts behind it line by line, and the fix when there is one.
     */
    async report(): Promise<void> {
        this.recheck();
        const status = await this.settled();
        if (status.kind === 'external') {
            await this.setUp();
            return;
        }
        const detail = this.detail();
        const message = statusMessage(status);
        if (!message) {
            const install = 'Install Pylance';
            const offered = pylanceInstalled() ? [] : [install];
            const answer = await vscode.window.showInformationMessage('This workspace\'s Python environment can run step libraries.', { modal: true, detail }, ...offered);
            if (answer === install) await installPylance(this.logger);
            return;
        }
        const label = fixLabel(status);
        const answer = await vscode.window.showWarningMessage(message, { modal: true, detail }, ...(label ? [label] : []));
        if (label && answer === label) await this.fix();
    }

    /** The facts behind the status, line by line, as the reports show them. */
    private detail(): string {
        return environmentReport({ ...this.facts, pylance: pylanceInstalled() },
            { ...(this.folder ? { folder: this.folder.uri.fsPath } : {}), home: os.homedir() });
    }

    /**
     * The runner's part of Check jPipe Installation: whether this workspace can run models, and
     * the facts behind it. Looks again first, like the environment's own check.
     */
    async describe(): Promise<{ runner: 'ready' | 'needs-setup' | 'external'; detail: string }> {
        this.recheck();
        const status = await this.settled();
        if (status.kind === 'external') {
            return { runner: 'external', detail: `Runs use the runner command named in the settings.\n${pylanceLine(pylanceInstalled())}` };
        }
        return { runner: runnablePython(status) ? 'ready' : 'needs-setup', detail: this.detail() };
    }

    /**
     * Offer to install Pylance, once per workspace, to a workspace that has step libraries:
     * without it nothing checks them as they are written. Silenced, like the environment's own
     * offer, by the setting that turns set-up suggestions off.
     */
    async offerPylance(): Promise<void> {
        if (pylanceInstalled()) return;
        if (!this.setting(OFFER_SETUP_SETTING, true) || this.context.workspaceState.get<boolean>(PYLANCE_DECLINED_KEY)) return;
        const install = 'Install Pylance';
        const notNow = 'Not Now';
        const answer = await vscode.window.showInformationMessage(PYLANCE_OFFER, install, notNow);
        this.logger.info(`Offered Pylance: ${answer ?? 'dismissed'}.`);
        // Any answer but Install ends the offer for this workspace, dismissing it included: it is a
        // suggestion, made once, and Check jPipe Installation still offers it on request.
        if (answer === install) await installPylance(this.logger);
        else await this.context.workspaceState.update(PYLANCE_DECLINED_KEY, true);
    }

    /**
     * Find who selects the editor's interpreter: the Python Environments extension where it is
     * installed, since it then has the last word, and otherwise the Python extension.
     */
    private async connect(): Promise<void> {
        const envs = await this.activate<Partial<PythonEnvsApi>>(PYTHON_ENVS_EXTENSION);
        if (envs && typeof envs.setEnvironment === 'function' && typeof envs.getEnvironment === 'function' && typeof envs.resolveEnvironment === 'function') {
            this.envs = envs as PythonEnvsApi;
            if (this.envs.onDidChangeEnvironment) this.disposables.push(this.envs.onDidChangeEnvironment(() => this.recheck()));
            this.logger.info('The editor\'s interpreter is selected through the Python Environments extension.');
            return;
        }
        this.api = (await this.activate<{ environments?: PythonEnvironmentsApi }>(PYTHON_EXTENSION))?.environments;
        if (this.api) {
            this.disposables.push(this.api.onDidChangeActiveEnvironmentPath(() => this.recheck()));
            this.logger.info('The editor\'s interpreter is selected through the Python extension.');
        } else {
            this.logger.info('No Python extension to select an interpreter with; the editor cannot be pointed at the workspace\'s environment.');
        }
    }

    /** What an extension exports, activating it if need be; `undefined` when it is not installed or fails. */
    private async activate<T>(id: string): Promise<T | undefined> {
        const extension = vscode.extensions.getExtension<T>(id);
        if (!extension) return undefined;
        try {
            return extension.isActive ? extension.exports : await extension.activate();
        } catch (err: unknown) {
            this.logger.info(`${id} did not activate: ${messageOf(err)}`);
            return undefined;
        }
    }

    private get canSelect(): boolean {
        return this.envs !== undefined || this.api !== undefined;
    }

    /**
     * Look at the workspace again. Checks run one at a time, in the order asked, so the status
     * left standing is always that of the check started last, never a slower, older one; and the
     * first waits for the Python extensions to be reached. One check waiting is enough: it has
     * not started, so it will see whatever changed since.
     */
    recheck(): void {
        if (this.queued) return;
        this.queued = true;
        this.checking = this.checking.then(() => {
            this.queued = false;
            return this.checked();
        });
    }

    /** The environment for programs started here: VS Code's, without any environment activated in it. */
    private processEnv(): NodeJS.ProcessEnv {
        return withoutActiveEnvironment(envWithPath(), process.platform);
    }

    /** Run a program that looks at the workspace, in its folder, and give what it printed. */
    private execute(command: Command, folder: vscode.WorkspaceFolder | undefined, timeout = 15_000): Promise<{ stdout: string }> {
        return execFileText(command.program, command.args, {
            cwd: folder?.uri.fsPath, timeout, windowsHide: true, env: this.processEnv()
        });
    }

    /** The environment a run has: the workspace's own, activated, as in a terminal. */
    runEnv(python: string): NodeJS.ProcessEnv {
        const inherited = envWithPath();
        return overInherited(activatedEnvironment(inherited, python, process.platform), inherited);
    }

    /** Settle on `status`, say so in the log, and let the views know. */
    private conclude(status: EnvironmentStatus, summary: string): void {
        this.current = status;
        this.logger.info(summary);
        this.changeEmitter.fire();
    }

    /** The version the local jpipe-runner declares now, if its `pyproject.toml` says. */
    private declaredLocal(localSource: string): string | undefined {
        try {
            return declaredVersion(fs.readFileSync(path.join(localSource, 'pyproject.toml'), 'utf8'));
        } catch {
            return undefined;
        }
    }

    /** `check`, which a failure must not keep later checks from running. */
    private async checked(): Promise<void> {
        try {
            await this.check();
        } catch (err: unknown) {
            this.logger.error(`Runner environment: the check failed: ${messageOf(err)}`);
        }
    }

    private async check(): Promise<void> {
        const folder = this.folder;
        if (this.mode === 'command') {
            this.conclude({ kind: 'external' },
                'Runner environment: runs use the configured runner command; no Python environment is looked at.');
            return;
        }
        const localSource = this.localSource;
        if (localSource && !isPythonProject(existsIn(localSource))) {
            this.conclude({ kind: 'no-local-source', path: localSource },
                `Runner environment: the local jpipe-runner named in the settings, ${localSource}, is not a Python project.`);
            return;
        }
        const environment = folder ? await this.workspaceEnvironment(folder) : {};
        const machineRelease = await this.machineRunnerRelease(folder);
        this.requirement = runnerRequirement(machineRelease);
        const probe = environment.python ? await this.probe({ program: environment.python, args: [] }, folder) : undefined;
        // The editor follows an environment that answers; one that does not is left alone.
        const { selected, editor } = await this.editorSelection(probe ? environment.python : undefined, folder);
        const declaredLocal = localSource ? this.declaredLocal(localSource) : undefined;
        const status = environmentStatus(environment, probe, editor, localSource, declaredLocal);
        this.facts = {
            environment,
            ...(probe ? { probe } : {}),
            editorPython: this.canSelect ? selected : null,
            editorFollows: environment.python !== undefined && selected !== undefined && sameInterpreter(environment.python, selected),
            ...(machineRelease ? { machineRunner: machineRelease } : {}),
            ...(localSource ? { localSource } : {}),
            ...(declaredLocal ? { declaredLocal } : {})
        };
        this.conclude(status, checkSummary(status.kind, this.facts, this.requirement));
    }

    /**
     * The interpreter the editor uses, and how it stands to the workspace's (`python`, when it
     * has one that answers), once the editor has been pointed at it if that is ours to do.
     */
    private async editorSelection(
        python: string | undefined,
        folder: vscode.WorkspaceFolder | undefined
    ): Promise<{ selected: string | undefined; editor: EditorSelection }> {
        const selected = await this.selectedPython(folder);
        // With the editor left to the user, which interpreter it uses is not ours to report on.
        if (!this.setting(SELECT_IN_EDITOR_SETTING, true)) return { selected, editor: 'none' };
        const editor = this.selection(python, selected);
        // Seamless: the workspace has an environment, so the editor uses it. Done once per
        // environment, so an interpreter the user picks afterwards is not fought over.
        if (!python || editor !== 'other' || this.context.workspaceState.get<string>(SELECTED_KEY) === python) {
            return { selected, editor };
        }
        this.logger.info(`The editor uses ${selected ?? 'no interpreter'}, which is not this workspace's environment.`);
        await this.select(python, folder);
        const now = await this.selectedPython(folder);
        return { selected: now, editor: this.selection(python, now) };
    }

    /** The release of the jpipe-runner installed on the machine, outside any environment, if there is one. */
    /**
     * The release a runner says it is (`command` is its `--version`), or `undefined` when it does
     * not say. Asked with the environment and folder given, which are the run's, so that the
     * program that answers is the one that will run; `undefined` env is the editor's own.
     */
    async releaseOf(command: Command, where: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<string | undefined> {
        try {
            const { stdout } = await execFileText(command.program, command.args, {
                cwd: where.cwd, timeout: 15_000, windowsHide: true, env: where.env ?? process.env
            });
            return parseRunnerVersion(stdout);
        } catch (err: unknown) {
            this.logger.debug(`${command.program} ${command.args.join(' ')} did not answer: ${messageOf(err)}`);
            return undefined;
        }
    }

    /**
     * The jpipe-runner release the workspace's environment at `python` runs now. Asked rather
     * than read from the last check, which may predate an upgrade. A local copy runs as it
     * stands, so its release is the one its `pyproject.toml` declares now: what the environment
     * recorded is the version it had when it was installed.
     */
    async runnerReleaseNow(python: string, where: { cwd: string; env: NodeJS.ProcessEnv }): Promise<string | undefined> {
        const local = this.facts.probe?.localSource;
        const declared = local ? this.declaredLocal(local) : undefined;
        return declared ?? this.releaseOf(moduleInvocation(python, ['--version']), where);
    }

    private async machineRunnerRelease(folder: vscode.WorkspaceFolder | undefined): Promise<string | undefined> {
        try {
            const { stdout } = await this.execute(GLOBAL_RUNNER_VERSION, folder);
            return parseRunnerVersion(stdout);
        } catch {
            return undefined;
        }
    }

    private selection(python: string | undefined, selected: string | undefined): EditorSelection {
        if (!this.canSelect) return 'none';
        return python !== undefined && selected !== undefined && sameInterpreter(python, selected) ? 'same' : 'other';
    }

    /** Ask an interpreter what it is; `undefined` if it is not there or does not answer. */
    private async probe(python: PythonCommand, folder: vscode.WorkspaceFolder | undefined): Promise<Probe | undefined> {
        try {
            const { stdout } = await this.execute({ program: python.program, args: [...python.args, '-c', PROBE_SCRIPT] }, folder);
            return parseProbe(stdout);
        } catch (err: unknown) {
            this.logger.debug(`Could not ask ${python.program} ${python.args.join(' ')} what it is: ${messageOf(err)}`);
            return undefined;
        }
    }

    /**
     * The Python a new environment is made with: the first install recent enough, starting with
     * the one the editor has selected. A virtual environment is never built on.
     */
    private async basePython(folder: vscode.WorkspaceFolder): Promise<PythonCommand | undefined> {
        const answers = [];
        for (const command of basePythonCandidates(await this.selectedPython(folder), process.platform)) {
            const probe = await this.probe(command, folder);
            answers.push({ command, version: probe?.version, isVirtualEnv: probe?.isVirtualEnv });
            const chosen = chooseBasePython(answers);
            if (chosen) {
                this.logger.info(`Creating the environment with ${[chosen.program, ...chosen.args].join(' ')} (Python ${probe?.version.join('.')})`);
                return chosen;
            }
        }
        return undefined;
    }

    /** The folder's own environment: what its manager reports, else a virtual environment at its root. */
    private async workspaceEnvironment(folder: vscode.WorkspaceFolder): Promise<WorkspaceEnvironment> {
        const root = folder.uri.fsPath;
        const manager = environmentManager(root);
        const folderVenvPython = VENV_DIRECTORIES
            .map(dir => venvPython(path.join(root, dir), process.platform))
            .find(file => fs.existsSync(file));
        const managedEnvironment = manager ? await this.managedEnvironment(manager, folder) : undefined;
        const found = workspaceEnvironment({
            ...(manager ? { manager } : {}),
            ...(managedEnvironment ? { managedEnvironment } : {}),
            ...(folderVenvPython ? { folderVenvPython } : {})
        }, process.platform);
        if (found.python && !fs.existsSync(found.python)) delete found.python;
        return found;
    }

    /**
     * The environment `manager` keeps for the folder, if it has made one. uv's is the folder's
     * `.venv`, found as any other. Pipenv notes in each environment which project it belongs to;
     * one that names another folder is refused, whatever led Pipenv to report it.
     */
    private async managedEnvironment(manager: Manager, folder: vscode.WorkspaceFolder): Promise<string | undefined> {
        const locate = locateEnvironmentCommand(manager);
        if (!locate) return undefined;
        let directory: string | undefined;
        try {
            const { stdout } = await this.execute(locate, folder, 30_000);
            directory = parseEnvironmentPath(stdout);
        } catch (err: unknown) {
            this.logger.debug(`${manager} reports no environment for this folder: ${messageOf(err)}`);
            return undefined;
        }
        if (!directory) return undefined;
        try {
            const owner = fs.readFileSync(path.join(directory, '.project'), 'utf8').trim();
            if (owner && fs.realpathSync(owner) !== fs.realpathSync(folder.uri.fsPath)) {
                this.logger.info(`${directory} belongs to ${owner}, not to this workspace; ignoring it.`);
                return undefined;
            }
        } catch {
            // No note of the owner: Poetry's environments, and Pipenv's kept in the folder.
        }
        return directory;
    }

    /** The interpreter the editor uses for the folder, when there is an extension to say. */
    private async selectedPython(folder: vscode.WorkspaceFolder | undefined): Promise<string | undefined> {
        try {
            if (this.envs) {
                const environment = await this.envs.getEnvironment(folder?.uri);
                return environment?.execInfo?.run?.executable || undefined;
            }
            if (this.api) {
                const active = this.api.getActiveEnvironmentPath(folder?.uri);
                const resolved = await this.api.resolveEnvironment(active);
                return resolved?.executable.uri?.fsPath ?? (active.path || undefined);
            }
        } catch (err: unknown) {
            this.logger.debug(`Could not learn which interpreter is selected: ${messageOf(err)}`);
        }
        return undefined;
    }

    /** The one-line explanation for the Libraries view, if anything needs doing. */
    message(): string | undefined {
        return statusMessage(this.current);
    }

    /**
     * Offer the fix, once per workspace unless `insist` — a run asked for, rather than a workspace
     * opened. Resolves to whether a run can go ahead afterwards.
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
        if (!insist && (!this.setting(OFFER_SETUP_SETTING, true) || this.context.workspaceState.get<boolean>(DECLINED_KEY))) return false;
        const notNow = 'Not Now';
        const answer = await vscode.window.showInformationMessage(message, label, notNow);
        if (answer === label) return this.fix();
        if (answer === notNow) await this.context.workspaceState.update(DECLINED_KEY, true);
        return false;
    }

    /**
     * Do what `fixLabel` promised for the current status; resolves to whether a run can go ahead.
     *
     * Anything that changes the workspace — an environment made, a package installed, above all a
     * project file rewritten — is spelled out first, in a dialog that can be refused, and nothing
     * is done until it is accepted. Pointing the editor at the environment follows by itself: the
     * check after the fix does it.
     */
    async fix(): Promise<boolean> {
        const status = await this.settled();
        const label = fixLabel(status);
        if (!label) {
            const message = statusMessage(status);
            if (message) void vscode.window.showWarningMessage(message);
            return runnablePython(status) !== undefined;
        }
        const folder = this.folder;
        const requirement = this.requirementEdit(status, folder);
        const consequences = fixConsequences(status, requirement, folder ? environmentNickname(folder.name) : undefined, this.localSource);
        if (consequences) {
            const answer = await vscode.window.showWarningMessage(`${label}?`, { modal: true, detail: consequences }, label);
            this.logger.info(`${label}: ${answer === label ? 'accepted' : 'refused'}. ${consequences}`);
            if (answer !== label) return false;
        }
        await this.apply(status, folder, requirement);
        this.recheck();
        return runnablePython(await this.settled()) !== undefined;
    }

    private async apply(status: EnvironmentStatus, folder: vscode.WorkspaceFolder | undefined, requirement: RequirementEdit | undefined): Promise<void> {
        switch (status.kind) {
            case 'missing-runner':
                await this.addRunner(status, folder, requirement);
                break;
            case 'runner-source':
                await this.changeRunnerSource(status, folder);
                break;
            case 'unselected':
                // Asked for, so done again even if the user had moved the editor elsewhere since.
                await this.select(status.python, folder);
                break;
            case 'no-environment':
                if (folder) await this.createEnvironment(folder, requirement);
                break;
            default:
                break;
        }
    }

    /** Add the runner to an environment that lacks it: through the project's manager, else with pip. */
    private async addRunner(
        status: Extract<EnvironmentStatus, { kind: 'missing-runner' }>,
        folder: vscode.WorkspaceFolder | undefined,
        requirement: RequirementEdit | undefined
    ): Promise<void> {
        if (status.manager) {
            if (folder) await this.addWithManager(status.manager, folder);
        } else if (status.python) {
            const install = { name: 'Install jpipe-runner', ...installRunnerCommand(status.python, this.requirement) };
            if (await this.runStep(install, folder)) this.write(requirement);
        }
    }

    /** Install the local runner the settings name, or put a published one back in its place. */
    private async changeRunnerSource(
        status: Extract<EnvironmentStatus, { kind: 'runner-source' }>,
        folder: vscode.WorkspaceFolder | undefined
    ): Promise<void> {
        if (status.wanted) {
            const verb = status.stale ? 'Reinstall' : 'Install';
            await this.runStep({ name: `${verb} the local jpipe-runner`, ...installRunnerCommand(status.python, { local: status.wanted }) }, folder);
        } else if (folder) {
            await this.runSteps(restorePublishedCommands(status.python, this.requirement), folder);
        }
    }

    /** Give a workspace that has none an environment of its own, with the runner in it. */
    private async createEnvironment(folder: vscode.WorkspaceFolder, requirement: RequirementEdit | undefined): Promise<void> {
        const base = await this.basePython(folder);
        if (!base) {
            void vscode.window.showErrorMessage(NO_BASE_PYTHON);
            return;
        }
        const runner = this.localSource ? { local: this.localSource } : this.requirement;
        const steps = createEnvironmentCommands(base, folder.uri.fsPath, process.platform, runner, environmentNickname(folder.name));
        if (await this.runSteps(steps, folder)) this.write(requirement);
    }

    /**
     * Have the project's manager add the runner.
     *
     * The tool does both halves of the job: it records the dependency where the project records
     * them, so a colleague and CI get it too, and it installs it in the project's environment,
     * creating that if need be. When the tool is not installed, or refuses, the user is told and
     * nothing else is tried: installing with pip behind the tool's back would put the environment
     * out of step with its lock file.
     */
    private async addWithManager(manager: Manager, folder: vscode.WorkspaceFolder): Promise<void> {
        const step = addRunnerCommand(manager);
        if (!await this.runStep(step, folder)) {
            void vscode.window.showErrorMessage(
                `${manager} could not add jpipe-runner — see the terminal. Is ${step.program} installed and on your PATH?`);
        }
    }

    /**
     * The requirements file a fix would write, as it would leave it, or `undefined` if it writes none.
     *
     * Only for a project installed with pip: a manager keeps its own record. In the file the
     * project already has; a workspace given its first environment gets `requirements.txt`, so
     * the environment can be rebuilt, while one that already has an environment and no such file
     * records its dependencies some other way and is not given a second record.
     */
    private requirementEdit(status: EnvironmentStatus, folder: vscode.WorkspaceFolder | undefined): RequirementEdit | undefined {
        if (!folder || (status.kind !== 'no-environment' && (status.kind !== 'missing-runner' || status.manager))) return undefined;
        const root = folder.uri.fsPath;
        const file = requirementsFile(existsIn(root))
            ?? (status.kind === 'no-environment' ? 'requirements.txt' : undefined);
        if (!file) return undefined;
        try {
            const target = path.join(root, file);
            const exists = fs.existsSync(target);
            const before = exists ? fs.readFileSync(target, 'utf8') : '';
            const content = withRunnerRequirement(before, status.kind === 'missing-runner' && status.outdated !== undefined);
            return content === undefined ? undefined : { file, path: target, content, change: requirementChangeKind(exists, before) };
        } catch (err: unknown) {
            this.logger.error(`Could not read ${file}: ${messageOf(err)}`);
            return undefined;
        }
    }

    private write(requirement: RequirementEdit | undefined): void {
        if (!requirement) return;
        try {
            fs.writeFileSync(requirement.path, requirement.content);
            this.logger.info(`Recorded jpipe-runner in ${requirement.file}.`);
        } catch (err: unknown) {
            this.logger.error(`Could not add jpipe-runner to ${requirement.file}: ${messageOf(err)}`);
        }
    }

    /**
     * Make `python` the workspace folder's interpreter for the editor, and remember it was done.
     *
     * The selecting extension may not know an environment made a moment ago, or may refuse it;
     * then the user is asked to pick it, rather than left with an editor that analyses with
     * another. Whether the selection held is not assumed: the check that follows reads it back.
     */
    private async select(python: string, folder: vscode.WorkspaceFolder | undefined): Promise<void> {
        if (!this.canSelect) return;
        await this.context.workspaceState.update(SELECTED_KEY, python);
        try {
            if (this.envs) {
                const target = vscode.Uri.file(python);
                let environment = await this.envs.resolveEnvironment(target);
                if (!environment) {
                    await this.envs.refreshEnvironments(folder?.uri);
                    environment = await this.envs.resolveEnvironment(target);
                }
                if (!environment) throw new Error('the Python Environments extension does not recognise it as an environment');
                await this.envs.setEnvironment(folder?.uri, environment);
            } else if (this.api) {
                await this.api.updateActiveEnvironmentPath(python, folder?.uri);
            }
            this.logger.info(`Selected ${python} as the workspace's Python interpreter.`);
        } catch (err: unknown) {
            this.logger.error(`Could not select ${python}: ${messageOf(err)}`);
            const pick = 'Select Interpreter';
            const ask = `Select ${python} as this workspace's Python interpreter, so the editor and runs use the same one.`;
            if (await vscode.window.showWarningMessage(ask, pick) === pick) {
                await this.tryCommand('python.setInterpreter');
            }
        }
    }

    /** Each step in turn, stopping at the first that fails; resolves to whether all succeeded. */
    private async runSteps(steps: readonly FixStep[], folder: vscode.WorkspaceFolder): Promise<boolean> {
        for (const step of steps) {
            if (!await this.runStep(step, folder)) return false;
        }
        return true;
    }

    /** One step, in a terminal the user can watch, without any environment VS Code inherited. */
    private async runStep(step: FixStep, folder: vscode.WorkspaceFolder | undefined): Promise<boolean> {
        this.logger.info(`${step.name}: ${step.program} ${step.args.join(' ')}`);
        const { ok, exitCode } = await runInTerminal(step, { folder, env: this.processEnv() });
        let outcome = 'done';
        if (!ok) outcome = exitCode === undefined ? 'failed' : `failed (exit code ${exitCode})`;
        this.logger.info(`${step.name}: ${outcome}`);
        return ok;
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
    }
}
