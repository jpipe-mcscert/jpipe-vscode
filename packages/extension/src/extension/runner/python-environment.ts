/**
 * The workspace's own Python environment: which it is, whether it can run step libraries, and
 * what to do when it cannot.
 *
 * The principle: a workspace runs its libraries with an environment that is its own — a virtual
 * environment in the folder, or the one its Pipenv, Poetry or uv project keeps — and the editor is
 * pointed at that same one. An environment belonging to another project is never used, and never
 * modified, however it came to be selected in VS Code. Everything here is a decision over facts
 * gathered elsewhere, so it is tested (jpipe-vscode ADR-VSC-0004, ADR-VSC-0026).
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** jpipe-runner's minimum, from its README. */
export const MIN_PYTHON: readonly [number, number] = [3, 11];

/**
 * The first jpipe-runner whose API step libraries are written against: `from jpipe_runner import
 * evidence, strategy`, which is what New Library… writes and what the Libraries view looks for.
 * Earlier releases install and import, but have neither decorator, so the editor flags every
 * import of them and a run finds no step.
 */
export const MIN_RUNNER: readonly [number, number, number] = [4, 0, 0];

/** jpipe-runner as a requirement, when nothing says which release: any recent enough, so an old one is upgraded. */
export const RUNNER_REQUIREMENT = `jpipe-runner>=${MIN_RUNNER.join('.')}`;

/** A program and the arguments it is started with. */
export interface Command {
    program: string;
    args: string[];
}

/** One step of a fix, run in a terminal named after it. */
export interface FixStep extends Command {
    name: string;
}

/** How the jpipe-runner installed on the machine — with Homebrew, apt, pipx — is asked its release. */
export const GLOBAL_RUNNER_VERSION: Command = { program: 'jpipe-runner', args: ['--version'] };

/** The release in what `jpipe-runner --version` prints (`jpipe-runner 4.0.0`), if it is one. */
export function parseRunnerVersion(stdout: string): string | undefined {
    // The last word of a line, with or without a `v` in front.
    for (const line of stdout.trim().split('\n')) {
        const last = line.trim().split(/\s+/).pop() ?? '';
        const version = last.startsWith('v') ? last.slice(1) : last;
        if (/^\d+\.\d[\w.]*$/.test(version)) return version;
    }
    return undefined;
}

/**
 * What pip is asked to install into the workspace's environment.
 *
 * The machine's own jpipe-runner is not what a run uses — it lives in an environment of its own,
 * where the project's packages are out of reach — but it is the release the user has, and the one
 * a terminal runs. So the workspace's environment is given that same release, and a library
 * behaves the same from the ▶ button and from the command line. With no runner on the machine, or
 * one too old for step libraries, it is given the latest.
 *
 * This is only what is installed. What a project file records is `RUNNER_REQUIREMENT`: any
 * release from the minimum on works with this extension, and a project is not pinned to what one
 * machine happened to have.
 */
export function runnerRequirement(globalRelease: string | undefined): string {
    return globalRelease !== undefined && /^\d+(\.\d+)*$/.test(globalRelease) && isRunnerRecentEnough(globalRelease)
        ? `jpipe-runner==${globalRelease}`
        : RUNNER_REQUIREMENT;
}

/**
 * Asked of an interpreter to learn what it is, without importing jpipe_runner: `find_spec` locates
 * a top-level package without running it. One line of JSON on stdout.
 */
export const PROBE_SCRIPT = [
    'import importlib.util, json, sys',
    'release = None',
    'local = None',
    'try:',
    '    from importlib.metadata import distribution',
    '    dist = distribution("jpipe-runner")',
    '    release = dist.version',
    '    direct = json.loads(dist.read_text("direct_url.json") or "null")',
    '    if direct and direct.get("dir_info", {}).get("editable"):',
    '        local = direct.get("url")',
    'except Exception:',
    '    pass',
    'print(json.dumps({"version": list(sys.version_info[:3]),',
    ' "runner": importlib.util.find_spec("jpipe_runner") is not None,',
    ' "release": release,',
    ' "local": local,',
    ' "venv": sys.prefix != sys.base_prefix}))'
].join('\n');

export interface Probe {
    version: [number, number, number];
    hasRunner: boolean;
    /** The jpipe-runner release installed, when the interpreter knows it as an installed package. */
    runnerVersion?: string;
    /**
     * The checkout the runner is installed from, when it is an editable install of a local copy
     * (`pip install -e`): the environment then runs that source as it stands, release or not.
     */
    localSource?: string;
    /** Whether the interpreter belongs to a virtual environment rather than a system install. */
    isVirtualEnv: boolean;
}

/** The probe's answer, or `undefined` if the output is not what the script prints. */
export function parseProbe(stdout: string): Probe | undefined {
    try {
        const line = stdout.trim().split(/\r?\n/).pop() ?? '';
        const data = JSON.parse(line) as { version?: unknown; runner?: unknown; release?: unknown; local?: unknown; venv?: unknown };
        const version = data.version;
        if (!Array.isArray(version) || version.length < 2 || !version.every(n => typeof n === 'number')) return undefined;
        const localSource = typeof data.local === 'string' ? localPath(data.local) : undefined;
        return {
            version: [version[0], version[1], version[2] ?? 0] as [number, number, number],
            hasRunner: data.runner === true,
            ...(typeof data.release === 'string' ? { runnerVersion: data.release } : {}),
            ...(localSource ? { localSource } : {}),
            isVirtualEnv: data.venv === true
        };
    } catch {
        return undefined;
    }
}

/** The directory a `file:` URL names, as pip records the source of an editable install. */
function localPath(url: string): string | undefined {
    try {
        return fileURLToPath(url);
    } catch {
        return undefined;
    }
}

/** Whether two paths name the same directory, written with or without a trailing separator. */
const sameDirectory = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

/** A tool that owns a project's environment and the record of what goes in it. */
export type Manager = 'Pipenv' | 'Poetry' | 'uv';

/** What the workspace folder says about its Python environment. */
export interface WorkspaceFacts {
    /** The tool managing the project, read from the files at the folder's root. */
    manager?: Manager;
    /** The environment directory that tool reports for this folder, when it has made one. */
    managedEnvironment?: string;
    /** A virtual environment directory at the folder's root, as a path to its interpreter. */
    folderVenvPython?: string;
}

/** The environment that is the workspace's own. */
export interface WorkspaceEnvironment {
    /** Its interpreter; absent when the workspace has no environment yet. */
    python?: string;
    /** The tool that manages it, and so the one that installs into it. */
    manager?: Manager;
}

/**
 * The workspace's own environment, from what its folder says: the one its manager keeps for it,
 * else a virtual environment at its root. Nothing else qualifies — not the interpreter selected in
 * VS Code, not an environment activated in the shell VS Code was started from, not `PATH`.
 */
export function workspaceEnvironment(facts: WorkspaceFacts, platform: NodeJS.Platform): WorkspaceEnvironment {
    const python = facts.managedEnvironment ? venvPython(facts.managedEnvironment, platform) : facts.folderVenvPython;
    return { ...(python ? { python } : {}), ...(facts.manager ? { manager: facts.manager } : {}) };
}

/** The directory names a virtual environment at the root of a project goes by, likeliest first. */
export const VENV_DIRECTORIES: readonly string[] = ['.venv', 'venv', 'env', '.env'];

/**
 * The tool managing the project in a folder, from the files it keeps there.
 *
 * A lock file or a `Pipfile` names its tool outright. A `pyproject.toml` only does through the
 * tool's own table, since the file is shared: one that configures neither Poetry nor uv is a
 * project installed with pip, which has no manager.
 */
export function detectManager(has: (file: string) => boolean, read: (file: string) => string | undefined): Manager | undefined {
    if (has('Pipfile')) return 'Pipenv';
    if (has('poetry.lock')) return 'Poetry';
    if (has('uv.lock')) return 'uv';
    const pyproject = has('pyproject.toml') ? read('pyproject.toml') ?? '' : '';
    if (/^[ \t]*\[tool\.poetry[\].]/m.test(pyproject)) return 'Poetry';
    if (/^[ \t]*\[tool\.uv[\].]/m.test(pyproject)) return 'uv';
    return undefined;
}

export type EnvironmentStatus =
    /** The workspace's environment can run step libraries, and the editor uses it. */
    | { kind: 'ready'; python: string }
    /** Not known yet: the workspace is still being looked at. */
    | { kind: 'checking' }
    /** Runs use a program the user named: no environment is looked at, and none is ours to fix. */
    | { kind: 'external' }
    /** The workspace's environment can run step libraries, but the editor uses another Python. */
    | { kind: 'unselected'; python: string }
    /** The workspace's environment has a Python older than jpipe-runner supports. */
    | { kind: 'old-python'; python: string; version: string }
    /**
     * The workspace's environment has no jpipe-runner, or one too old (`outdated` is its version).
     * With a `manager`, that tool adds it — and makes the environment, when there is no `python` yet.
     */
    | { kind: 'missing-runner'; python?: string; manager?: Manager; outdated?: string }
    /**
     * The workspace's environment and the settings disagree about a local jpipe-runner: `wanted`
     * is the checkout the settings name and the environment does not run; `installed` the one the
     * environment runs while the settings name none. pip puts it right, in the environment only.
     */
    | { kind: 'runner-source'; python: string; manager?: Manager; wanted?: string; installed?: string; stale?: { recorded: string; declared: string } }
    /** The settings name a local jpipe-runner that is not a Python project on this machine. */
    | { kind: 'no-local-source'; path: string }
    /** The workspace has no environment of its own, and no tool to make one: create `.venv`. */
    | { kind: 'no-environment' };

/** Which Python the editor uses, compared with the workspace's: `none` without the Python extension. */
export type EditorSelection = 'same' | 'other' | 'none';

/**
 * What the workspace's own environment means for running step libraries.
 *
 * Only that environment is looked at. With none, the project's manager makes one while adding the
 * runner, and a project without a manager gets a `.venv`. An interpreter that does not answer — a
 * broken link, a half-deleted directory — is no environment: the manager, or creating `.venv`
 * over it, rebuilds it.
 *
 * Having jpipe-runner means having one recent enough for the libraries this extension writes and
 * lists (`MIN_RUNNER`). An older one is treated as none, and the same fix upgrades it. A runner
 * the interpreter finds but has no release for — a source checkout on its path — is taken as it is.
 *
 * With a local jpipe-runner named in the settings (`localSource`), having the runner means
 * running that checkout, installed editable; without one, an environment that runs a checkout is
 * put back on a published release.
 *
 * An environment that can run libraries while the editor uses another Python is `unselected`: a
 * run goes ahead with the workspace's, and the editor is still to be pointed at it.
 */
export function environmentStatus(
    environment: WorkspaceEnvironment,
    probe: Probe | undefined,
    editor: EditorSelection,
    localSource?: string,
    declaredLocal?: string
): EnvironmentStatus {
    const { python, manager } = environment;
    const managed = manager ? { manager } : {};
    if (python === undefined || probe === undefined) {
        return manager ? { kind: 'missing-runner', manager } : { kind: 'no-environment' };
    }
    if (!isRecentEnough(probe.version)) return { kind: 'old-python', python, version: probe.version.join('.') };
    const selected: EnvironmentStatus = { kind: editor === 'other' ? 'unselected' : 'ready', python };
    // A local runner, for working on the runner itself: the checkout is run as it stands, so
    // neither its release nor the machine's has a say.
    if (localSource !== undefined) {
        const wanted: EnvironmentStatus = { kind: 'runner-source', python, ...managed, wanted: localSource };
        if (probe.localSource === undefined || !sameDirectory(probe.localSource, localSource)) return wanted;
        const stale = staleInstall(probe.runnerVersion, declaredLocal);
        return stale ? { ...wanted, stale } : selected;
    }
    // One installed by hand in a managed project is the user's arrangement with their tool.
    if (probe.localSource !== undefined && !manager) return { kind: 'runner-source', python, installed: probe.localSource };
    if (!probe.hasRunner) return { kind: 'missing-runner', python, ...managed };
    if (probe.runnerVersion !== undefined && !isRunnerRecentEnough(probe.runnerVersion)) {
        return { kind: 'missing-runner', python, ...managed, outdated: probe.runnerVersion };
    }
    return selected;
}

/**
 * How a local copy's install has fallen behind the copy, if it has.
 *
 * The code of a local copy is run as it stands, but what the environment knows about it — its
 * version, its dependencies, its commands — was written down when it was installed. A copy whose
 * version has moved since is to be installed again.
 */
function staleInstall(recorded: string | undefined, declared: string | undefined): { recorded: string; declared: string } | undefined {
    if (recorded === undefined || declared === undefined || recorded === declared) return undefined;
    return { recorded, declared };
}

/**
 * The version a Python project declares in its `pyproject.toml`: the `version` of `[project]`, or
 * of `[tool.poetry]`. `undefined` when it declares none there, as a project that computes it does.
 */
export function declaredVersion(pyproject: string): string | undefined {
    let section = '';
    for (const line of pyproject.split(/\r?\n/)) {
        const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
        if (header) {
            section = header[1].trim();
            continue;
        }
        if (section !== 'project' && section !== 'tool.poetry') continue;
        const version = /^\s*version\s*=\s*(["'])(.*?)\1/.exec(line);
        if (version) return version[2];
    }
    return undefined;
}

/** What a check found, for the report the user can ask for. */
export interface EnvironmentFacts {
    environment: WorkspaceEnvironment;
    probe?: Probe;
    /** The editor's interpreter; `null` when no Python extension is there to say. */
    editorPython?: string | null;
    /** Whether the editor's interpreter is the workspace's environment. */
    editorFollows?: boolean;
    machineRunner?: string;
    /** The local jpipe-runner the settings name, if any. */
    localSource?: string;
    /** The version that local jpipe-runner declares now. */
    declaredLocal?: string;
}

/** `file` as a reader would say it: from the workspace folder if it is in it, else from `~`. */
export function shortPath(file: string, places: { folder?: string; home?: string }): string {
    const within = (root: string | undefined): string | undefined => {
        if (!root) return undefined;
        const relative = path.relative(root, file);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : undefined;
    };
    const inFolder = within(places.folder);
    if (inFolder) return inFolder;
    const inHome = within(places.home);
    return inHome ? path.join('~', inHome) : file;
}

/**
 * The facts behind a status, as Check the Python Environment shows them: in a dialog too narrow
 * for a path, so each line is a few words, paths are given from the workspace or from `~`, the
 * environment is named by its folder rather than by the interpreter inside it, and a line that
 * would repeat another is left out.
 */
export function environmentReport(facts: EnvironmentFacts, places: { folder?: string; home?: string } = {}): string {
    const { environment, probe } = facts;
    const short = (file: string) => shortPath(file, places);
    const local = probe?.localSource;
    const lines: string[] = [];
    if (environment.python) {
        // `.venv/bin/python` is the environment `.venv`.
        const where = short(path.dirname(path.dirname(environment.python)));
        lines.push(
            environment.manager ? `Environment: ${where} (${environment.manager})` : `Environment: ${where}`,
            `Python: ${probe ? probe.version.join('.') : 'does not answer'}`,
            ...runnerLines(probe, facts.declaredLocal, short)
        );
    } else {
        lines.push(environment.manager ? `Environment: none yet (${environment.manager} project)` : 'Environment: none yet');
    }
    lines.push(...editorLines(facts, short));
    // Only what the lines above do not already say.
    if (facts.localSource && (!local || !sameDirectory(local, facts.localSource))) {
        lines.push('Settings ask for a local copy', `  ${short(facts.localSource)}`);
    }
    if (facts.machineRunner) lines.push(`Also on this computer: ${facts.machineRunner}`);
    return lines.join('\n');
}

/** The report's lines about the jpipe-runner an environment has. */
function runnerLines(probe: Probe | undefined, declaredLocal: string | undefined, short: (file: string) => string): string[] {
    if (!probe?.hasRunner) return ['jpipe-runner: not installed'];
    // The version first, always: a local copy has one too, and it is what a report is read for.
    const version = probe.runnerVersion ?? 'installed';
    const local = probe.localSource;
    if (!local) return [`jpipe-runner: ${version}`];
    const lines = [`jpipe-runner: ${version} (local copy)`, `  ${short(local)}`];
    if (declaredLocal && declaredLocal !== probe.runnerVersion) lines.push(`  now ${declaredLocal}: reinstall it`);
    return lines;
}

/** The report's lines about the interpreter the editor uses. */
function editorLines(facts: EnvironmentFacts, short: (file: string) => string): string[] {
    if (facts.editorPython === null) return ['Editor: no Python extension'];
    if (facts.editorFollows) return ['Editor: uses this environment'];
    return ['Editor: uses another Python', `  ${facts.editorPython ? short(facts.editorPython) : 'none selected'}`];
}

/** The interpreter a run can use: the workspace's, once it can run libraries, selected or not. */
export function runnablePython(status: EnvironmentStatus): string | undefined {
    // A local runner installed before its version moved still runs, with its current code.
    const stale = status.kind === 'runner-source' && status.stale !== undefined;
    return status.kind === 'ready' || status.kind === 'unselected' || stale ? status.python : undefined;
}

export const isRecentEnough = (version: readonly number[]): boolean => compareVersion(version, MIN_PYTHON) >= 0;

/** Whether a jpipe-runner release (`4.0.0`, `4.1.0rc1`) has the API step libraries use. */
export function isRunnerRecentEnough(release: string): boolean {
    const numbers = release.split('.').map(part => Number.parseInt(part, 10));
    return numbers.every(n => !Number.isNaN(n)) ? compareVersion(numbers, MIN_RUNNER) >= 0 : true;
}

/** A program to try as the Python an environment is created with, and the arguments that select it. */
export type PythonCommand = Command;

/**
 * Where to look for a Python to create an environment with, best first, after the one the editor
 * has selected:
 * the `python3` on `PATH`, then each minor version jpipe-runner supports by name — Homebrew, the
 * python.org installer and most Linux distributions install them that way — and, on Windows, the
 * `py` launcher, which knows every Python installed.
 */
export function basePythonCandidates(selected: string | undefined, platform: NodeJS.Platform): PythonCommand[] {
    const minors = [14, 13, 12, 11];
    const candidates: PythonCommand[] = selected ? [{ program: selected, args: [] }] : [];
    if (platform === 'win32') {
        candidates.push({ program: 'py', args: ['-3'] }, ...minors.map(m => ({ program: 'py', args: [`-3.${m}`] })), { program: 'python', args: [] });
    } else {
        candidates.push({ program: 'python3', args: [] }, ...minors.map(m => ({ program: `python3.${m}`, args: [] })));
    }
    return candidates;
}

/**
 * The first candidate that answered, is recent enough, and is a Python install of its own. One
 * that is another project's virtual environment is passed over: the new environment is the
 * workspace's, and should not hang off somebody else's.
 */
export function chooseBasePython(candidates: ReadonlyArray<{ command: PythonCommand; version?: readonly number[]; isVirtualEnv?: boolean }>): PythonCommand | undefined {
    return candidates.find(c => c.version !== undefined && isRecentEnough(c.version) && !c.isVirtualEnv)?.command;
}

function compareVersion(version: readonly number[], minimum: readonly number[]): number {
    for (let i = 0; i < minimum.length; i++) {
        if ((version[i] ?? 0) !== minimum[i]) return (version[i] ?? 0) - minimum[i];
    }
    return 0;
}

/** One line for the Libraries view, or `undefined` when there is nothing to say. */
export function statusMessage(status: EnvironmentStatus): string | undefined {
    switch (status.kind) {
        case 'ready':
        case 'external':
        case 'checking': return undefined;
        case 'unselected': return 'The editor uses another Python than this workspace\'s environment.';
        case 'old-python': return `This workspace's environment has Python ${status.version}; jpipe-runner needs ${MIN_PYTHON.join('.')} or newer. Recreate it with a newer Python.`;
        case 'missing-runner': return status.outdated
            ? `This workspace's Python environment has jpipe-runner ${status.outdated}; step libraries need ${MIN_RUNNER.join('.')} or newer.`
            : 'jpipe-runner is not installed in this workspace\'s Python environment.';
        case 'runner-source': return runnerSourceMessage(status);
        case 'no-local-source': return `The local jpipe-runner named in the settings is not a Python project on this computer: ${status.path}`;
        case 'no-environment': return 'This workspace has no Python environment of its own.';
    }
}

/** The label of the action that fixes `status`, or `undefined` if none can be offered. */
export function fixLabel(status: EnvironmentStatus): string | undefined {
    switch (status.kind) {
        case 'missing-runner':
            if (status.manager) return `${status.outdated ? 'Upgrade' : 'Add'} jpipe-runner with ${status.manager}`;
            return `${status.outdated ? 'Upgrade' : 'Install'} jpipe-runner`;
        case 'unselected': return 'Use the Workspace\'s Environment';
        case 'runner-source':
            if (status.stale) return 'Reinstall the Local jpipe-runner';
            return status.wanted ? 'Install the Local jpipe-runner' : 'Install the Published jpipe-runner';
        case 'no-environment': return 'Create Environment';
        default: return undefined;
    }
}

/** The project files a manager rewrites when it adds a dependency. */
const MANAGER_FILES: Record<Manager, string> = {
    Pipenv: 'Pipfile and Pipfile.lock',
    Poetry: 'pyproject.toml and poetry.lock',
    uv: 'pyproject.toml and uv.lock'
};

/** What a fix does to a requirements file: which one, and whether it is made, added to or corrected. */
export interface RequirementChange {
    file: string;
    change: 'create' | 'add' | 'replace';
}

function runnerSourceMessage(status: Extract<EnvironmentStatus, { kind: 'runner-source' }>): string {
    if (status.stale) {
        return `Your local jpipe-runner is now ${status.stale.declared}, but this workspace's Python environment still has it as ${status.stale.recorded}, as it was when installed. Runs use its current code; its version and dependencies are the old ones.`;
    }
    return status.wanted
        ? `This workspace's Python environment does not run the local jpipe-runner named in the settings (${status.wanted}).`
        : `This workspace's Python environment runs a local jpipe-runner (${status.installed}), and the settings no longer name one.`;
}

/**
 * What accepting the fix for `status` changes, said before anything is done so it can be refused:
 * a short list of what jPipe will do, each line naming a folder or a file of the user's, and a
 * last line saying that is all. `undefined` when the fix touches nothing of the project's —
 * pointing the editor at an environment already there.
 */
export function fixConsequences(status: EnvironmentStatus, requirement?: RequirementChange, nickname?: string, localSource?: string): string | undefined {
    const recorded = recordedStep(requirement);
    switch (status.kind) {
        case 'no-environment': {
            const created = 'Create a Python environment for this workspace, in a new .venv folder';
            return fixPlan([
                nickname ? `${created}, shown as “${nickname}” in VS Code and in your terminal` : created,
                localSource ? `Install jpipe-runner in it, from your local copy (${localSource})` : 'Install jpipe-runner in it',
                recorded
            ], 'Nothing else in this folder is changed.');
        }
        case 'missing-runner': return addRunnerConsequences(status, recorded);
        case 'runner-source': return runnerSourceConsequences(status);
        default: return undefined;
    }
}

function addRunnerConsequences(status: Extract<EnvironmentStatus, { kind: 'missing-runner' }>, recorded: string | undefined): string {
    if (status.manager) {
        return fixPlan([
            `Ask ${status.manager} to add jpipe-runner to this project`,
            status.python ? undefined : `Let ${status.manager} create the project's environment, which does not exist yet`
        ], `${status.manager} will update ${MANAGER_FILES[status.manager]}.`);
    }
    return fixPlan([
        'Install jpipe-runner in this workspace\'s Python environment',
        recorded
    ], recorded ? 'No other file of your project is changed.' : 'None of your project files is changed.');
}

function runnerSourceConsequences(status: Extract<EnvironmentStatus, { kind: 'runner-source' }>): string {
    if (!status.wanted) {
        return fixPlan([
            'Remove the local jpipe-runner from this workspace\'s Python environment',
            'Install the published jpipe-runner in its place'
        ], 'None of your project files is changed.');
    }
    const overridden = status.manager
        ? ` ${status.manager} does not know about it, and may put its own back the next time it installs.`
        : '';
    return fixPlan([
        status.stale
            ? `Install your local jpipe-runner (${status.wanted}) again in this workspace's Python environment, so that it is ${status.stale.declared} there too, with its current dependencies`
            : `Install jpipe-runner in this workspace's Python environment, from your local copy (${status.wanted})`
    ], `None of your project files is changed.${overridden}`);
}

/** A fix's plan as the dialog shows it: what jPipe will do, a line per step, then what it leaves alone. */
function fixPlan(steps: ReadonlyArray<string | undefined>, unchanged: string): string {
    return ['jPipe will:', ...steps.filter(step => step !== undefined).map(step => `• ${step}`), '', unchanged].join('\n');
}

/** The step of a plan that records the runner in a requirements file, if the fix writes one. */
function recordedStep(requirement: RequirementChange | undefined): string | undefined {
    if (requirement === undefined) return undefined;
    switch (requirement.change) {
        case 'create': return `Create ${requirement.file}, so that the execution is reproducible`;
        case 'add': return `Add jpipe-runner to ${requirement.file}, so that the execution is reproducible`;
        case 'replace': return `Update the jpipe-runner line of ${requirement.file}`;
    }
}

/** The directory of a virtual environment's programs. */
const venvBin = (venvDir: string, platform: NodeJS.Platform): string => path.join(venvDir, platform === 'win32' ? 'Scripts' : 'bin');

/** The interpreter inside a virtual environment directory. */
export function venvPython(venvDir: string, platform: NodeJS.Platform): string {
    return path.join(venvBin(venvDir, platform), platform === 'win32' ? 'python.exe' : 'python');
}

/**
 * What an environment created here is nicknamed: `jpipe-` and the workspace folder's name.
 *
 * An environment is only created for a workspace that had none, so for a user who did not set
 * Python up and may not know what a `.venv` is. The name says where it came from and which
 * workspace it is for, in the one list they will meet it in. A folder already named for jPipe is
 * not given the word twice.
 */
export function environmentNickname(folderName: string): string {
    return /jpipe/i.test(folderName) ? folderName : `jpipe-${folderName}`;
}

/**
 * The steps that create `.venv` in `folder` with `base`, then install jpipe-runner in it.
 *
 * The directory keeps the name every tool looks for; what tells it apart from the next project's
 * `.venv` is its nickname (`environmentNickname`), given with venv's `--prompt`. It is what an
 * activated terminal shows, and what VS Code lists the environment under.
 */
export function createEnvironmentCommands(base: PythonCommand, folder: string, platform: NodeJS.Platform, runner: RunnerSource = RUNNER_REQUIREMENT, nickname: string = environmentNickname(path.basename(folder))): FixStep[] {
    const python = venvPython(path.join(folder, '.venv'), platform);
    return [
        { name: 'Create .venv', program: base.program, args: [...base.args, '-m', 'venv', ...(nickname ? ['--prompt', nickname] : []), '.venv'] },
        { name: 'Install jpipe-runner', ...installRunnerCommand(python, runner) }
    ];
}

/** Why no environment can be created, when no Python recent enough was found. */
export const NO_BASE_PYTHON = `Creating an environment needs Python ${MIN_PYTHON.join('.')} or newer, and none was found. Install one (python.org, Homebrew, or your distribution), then try again.`;

/** What pip installs the runner from: a requirement, or a local checkout, installed editable. */
export type RunnerSource = string | { local: string };

/**
 * The command that installs jpipe-runner into the environment `python` belongs to. A local
 * checkout is installed editable, so the environment runs its source as it stands and a change
 * to the runner shows in the next run, with nothing to reinstall.
 */
export function installRunnerCommand(python: string, runner: RunnerSource = RUNNER_REQUIREMENT): Command {
    return { program: python, args: ['-m', 'pip', 'install', ...(typeof runner === 'string' ? [runner] : ['-e', runner.local])] };
}

/**
 * The steps that put an environment running a local checkout back on a published release. The
 * checkout is removed first: pip, asked only to install, finds a jpipe-runner there and stops.
 */
export function restorePublishedCommands(python: string, runner: string = RUNNER_REQUIREMENT): FixStep[] {
    return [
        { name: 'Remove the local jpipe-runner', program: python, args: ['-m', 'pip', 'uninstall', '-y', 'jpipe-runner'] },
        { name: 'Install jpipe-runner', ...installRunnerCommand(python, runner) }
    ];
}

/** Whether a directory holds a Python project pip can install, from the files at its root. */
export function isPythonProject(has: (file: string) => boolean): boolean {
    return has('pyproject.toml') || has('setup.py');
}

/**
 * How a manager adds jpipe-runner to its project: recorded in the project's own dependency file
 * and installed in its environment, which the tool creates if there is none yet. As a development
 * dependency — the runner checks the project, the project's code does not import it.
 */
export function addRunnerCommand(manager: Manager, runner: string = RUNNER_REQUIREMENT): FixStep {
    const name = `Add jpipe-runner with ${manager}`;
    switch (manager) {
        case 'Pipenv': return { name, program: 'pipenv', args: ['install', '--dev', runner] };
        case 'Poetry': return { name, program: 'poetry', args: ['add', '--group', 'dev', runner] };
        case 'uv': return { name, program: 'uv', args: ['add', '--dev', runner] };
    }
}

/**
 * The command asking a manager where the project's environment is, or `undefined` for uv, which
 * always keeps it in the project's `.venv`. Pipenv and Poetry keep theirs outside the folder.
 */
export function locateEnvironmentCommand(manager: Manager): Command | undefined {
    switch (manager) {
        case 'Pipenv': return { program: 'pipenv', args: ['--venv'] };
        case 'Poetry': return { program: 'poetry', args: ['env', 'info', '--path'] };
        case 'uv': return undefined;
    }
}

/** The directory a manager answered with: the last line it printed, after any notice. */
export function parseEnvironmentPath(stdout: string): string | undefined {
    const line = stdout.trim().split(/\r?\n/).pop()?.trim();
    return line && path.isAbsolute(line) ? line : undefined;
}

/**
 * Which requirements file records the runner in a project installed with pip, among those the
 * folder has: the development one when there is one. `undefined` when the project has neither —
 * it records its dependencies some other way, and it is not for us to start a second record.
 */
export function requirementsFile(has: (file: string) => boolean): string | undefined {
    return ['requirements-dev.txt', 'dev-requirements.txt', 'requirements.txt'].find(has);
}

/** The line of a requirements file that names jpipe-runner, however its name is spelled. */
const RUNNER_LINE = /^[ \t]*jpipe[-_.]runner(?![\w.-]).*$/im;

/**
 * `requirements` asking for a jpipe-runner recent enough, or `undefined` if nothing needs writing.
 *
 * A file that does not name the runner gets it on a line of its own. One that does is left as it
 * is, unless `upgrade`: then its line is what held the environment on the old release, and it is
 * replaced, or the environment rebuilt from the file would be the one just fixed.
 */
export function withRunnerRequirement(requirements: string, upgrade = false, runner: string = RUNNER_REQUIREMENT): string | undefined {
    if (RUNNER_LINE.test(requirements)) {
        const replaced = requirements.replace(RUNNER_LINE, runner);
        return upgrade && replaced !== requirements ? replaced : undefined;
    }
    const separator = requirements.length === 0 || requirements.endsWith('\n') ? '' : '\n';
    return `${requirements}${separator}${runner}\n`;
}

/** How `withRunnerRequirement` changes a requirements file that `exists` and reads `before`. */
export function requirementChangeKind(exists: boolean, before: string): RequirementChange['change'] {
    if (!exists) return 'create';
    return RUNNER_LINE.test(before) ? 'replace' : 'add';
}

const pathKey = (env: NodeJS.ProcessEnv): string => Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
const pathSeparator = (platform: NodeJS.Platform): string => platform === 'win32' ? ';' : ':';

/**
 * `env` without the virtual environment activated in it, if any.
 *
 * VS Code started from a shell with an environment activated hands that activation to every
 * window and every program an extension starts. `python3` is then that environment's, and Pipenv
 * and Poetry, finding `VIRTUAL_ENV` set, install into it rather than into the project's own. So
 * every program run to look at, or change, a workspace's environment runs without it.
 */
export function withoutActiveEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
    const { VIRTUAL_ENV: active, VIRTUAL_ENV_PROMPT: _prompt, PIPENV_ACTIVE: _pipenv, POETRY_ACTIVE: _poetry, PYTHONHOME: _home, ...rest } = env;
    if (!active) return rest;
    const key = pathKey(rest);
    const separator = pathSeparator(platform);
    const bin = path.normalize(venvBin(active, platform));
    const entries = (rest[key] ?? '').split(separator).filter(entry => entry && path.normalize(entry) !== bin);
    return { ...rest, [key]: entries.join(separator) };
}

/** `env` with the environment `python` belongs to activated, as a run in a terminal would have it. */
export function activatedEnvironment(env: NodeJS.ProcessEnv, python: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
    const clean = withoutActiveEnvironment(env, platform);
    const key = pathKey(clean);
    const bin = path.dirname(python);
    return { ...clean, VIRTUAL_ENV: path.dirname(bin), [key]: [bin, clean[key]].filter(Boolean).join(pathSeparator(platform)) };
}

/**
 * `env` as the environment of a VS Code task, which is laid over the one VS Code `inherited`: a
 * variable left out of `env` is not removed, it keeps its inherited value. So each variable that
 * was taken out is given an empty value, which Python reads as unset (`PYTHONHOME`) and which
 * says "no" for the others. Only good for a run, whose `VIRTUAL_ENV` is always set: Poetry takes
 * an empty `VIRTUAL_ENV` for an environment, so a fix is started with exactly its environment
 * instead (`step-terminal.ts`).
 */
export function overInherited(env: NodeJS.ProcessEnv, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const removed = Object.keys(inherited).filter(key => inherited[key] !== undefined && env[key] === undefined);
    return { ...env, ...Object.fromEntries(removed.map(key => [key, ''])) };
}

/**
 * Whether a diagnostic on a Python file says the editor cannot find jpipe-runner — the visible
 * half of an environment that cannot run step libraries. Worded for Pylance and Pyright
 * (`Import "jpipe_runner" could not be resolved`), mypy and Pylint, which each say it their way.
 */
export function isRunnerImportProblem(message: string): boolean {
    return /\bjpipe_runner\b/.test(message)
        && /could not be resolved|unable to import|cannot find|no module named|unknown import symbol/i.test(message);
}

/** How a run invokes the runner through the workspace's interpreter: `<python> -m jpipe_runner …`. */
export function moduleInvocation(python: string, args: readonly string[]): Command {
    return { program: python, args: ['-m', 'jpipe_runner', ...args] };
}
