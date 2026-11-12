/**
 * Whether the Python VS Code uses can run step libraries, and what to do when it cannot.
 *
 * The principle: one Python for the editor and the run. Pylance analyses a library with the
 * interpreter selected in VS Code; the ▶ button runs it with `<that python> -m jpipe_runner`. When
 * that Python has no jpipe-runner, the editor flags every `from jpipe_runner import …` and a run
 * would fail, so the Libraries view says so and offers the fix that fits the project. Everything
 * here is a decision over facts gathered elsewhere, so it is tested (jpipe-vscode ADR-VSC-0004).
 */
import * as path from 'node:path';

/** jpipe-runner's minimum, from its README. */
export const MIN_PYTHON: readonly [number, number] = [3, 11];

/**
 * Asked of an interpreter to learn what it is, without importing jpipe_runner: `find_spec` locates
 * a top-level package without running it. One line of JSON on stdout.
 */
export const PROBE_SCRIPT = [
    'import importlib.util, json, sys',
    'print(json.dumps({"version": list(sys.version_info[:3]),',
    ' "runner": importlib.util.find_spec("jpipe_runner") is not None,',
    ' "venv": sys.prefix != sys.base_prefix}))'
].join('\n');

export interface Probe {
    version: [number, number, number];
    hasRunner: boolean;
    /** Whether the interpreter belongs to a virtual environment rather than a system install. */
    isVirtualEnv: boolean;
}

/** The probe's answer, or `undefined` if the output is not what the script prints. */
export function parseProbe(stdout: string): Probe | undefined {
    try {
        const line = stdout.trim().split(/\r?\n/).pop() ?? '';
        const data = JSON.parse(line) as { version?: unknown; runner?: unknown; venv?: unknown };
        const version = data.version;
        if (!Array.isArray(version) || version.length < 2 || !version.every(n => typeof n === 'number')) return undefined;
        return {
            version: [version[0], version[1], version[2] ?? 0] as [number, number, number],
            hasRunner: data.runner === true,
            isVirtualEnv: data.venv === true
        };
    } catch {
        return undefined;
    }
}

/** What the workspace folder holds that says how its Python is managed. */
export interface ProjectFacts {
    /** A `.venv` or `venv` directory at the root, as a path to its interpreter, if it has one. */
    localVenvPython?: string;
    /** `Pipfile` or Poetry's lock file: the environment lives outside the folder, managed by that tool. */
    manager?: 'Pipenv' | 'Poetry';
}

export type EnvironmentStatus =
    /** The selected Python can run step libraries. */
    | { kind: 'ready'; python: string }
    /** No Python could be found at all. */
    | { kind: 'no-python' }
    /** The selected Python is a project environment older than jpipe-runner supports. */
    | { kind: 'old-python'; python: string; version: string }
    /** The selected Python is a project environment without jpipe-runner: install it there. */
    | { kind: 'missing-runner'; python: string }
    /** The folder has its own `.venv`, but VS Code uses another Python: select it. */
    | { kind: 'unselected-venv'; python: string; venvPython: string }
    /** Pipenv or Poetry manage the environment: select it, the tool knows where it is. */
    | { kind: 'managed'; python: string; manager: 'Pipenv' | 'Poetry' }
    /** No project environment at all: create one. */
    | { kind: 'no-environment'; python: string };

/**
 * What the selected interpreter means for running step libraries.
 *
 * A system Python with jpipe-runner installed is accepted: it runs. A project environment is only
 * proposed when there is none — the selected Python is not one, and nothing in the folder says
 * where one is. When something does, the answer is to use it rather than make another.
 *
 * The selected Python's own version only matters when it is a project environment: a system
 * Python that is too old — macOS's own `/usr/bin/python3` is 3.9 — is not one to fix, it is one
 * to create an environment beside, with a newer Python (`chooseBasePython`).
 */
export function environmentStatus(python: string | undefined, probe: Probe | undefined, project: ProjectFacts): EnvironmentStatus {
    if (!python || !probe) return { kind: 'no-python' };
    const recentEnough = isRecentEnough(probe.version);
    if (probe.hasRunner && recentEnough) return { kind: 'ready', python };
    if (probe.isVirtualEnv) {
        return recentEnough
            ? { kind: 'missing-runner', python }
            : { kind: 'old-python', python, version: probe.version.join('.') };
    }
    if (project.localVenvPython && path.normalize(project.localVenvPython) !== path.normalize(python)) {
        return { kind: 'unselected-venv', python, venvPython: project.localVenvPython };
    }
    if (project.manager) return { kind: 'managed', python, manager: project.manager };
    return { kind: 'no-environment', python };
}

export const isRecentEnough = (version: readonly number[]): boolean => compareVersion(version, MIN_PYTHON) >= 0;

/** A program to try as the Python an environment is created with, and the arguments that select it. */
export interface PythonCommand {
    program: string;
    args: string[];
}

/**
 * Where to look for a Python to create an environment with, best first, after the selected one:
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

/** The first candidate whose version is recent enough, given each one's version, if it answered. */
export function chooseBasePython(candidates: ReadonlyArray<{ command: PythonCommand; version?: readonly number[] }>): PythonCommand | undefined {
    return candidates.find(c => c.version !== undefined && isRecentEnough(c.version))?.command;
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
        case 'ready': return undefined;
        case 'no-python': return 'No Python was found to run step libraries with. Install Python 3.11 or newer.';
        case 'old-python': return `jpipe-runner needs Python ${MIN_PYTHON.join('.')} or newer; the selected environment has Python ${status.version}.`;
        case 'missing-runner': return 'jpipe-runner is not installed in the selected Python environment.';
        case 'unselected-venv': return 'This folder has a virtual environment, but VS Code uses another Python.';
        case 'managed': return `${status.manager} manages this project's environment, but VS Code uses another Python.`;
        case 'no-environment': return 'This workspace has no Python environment with jpipe-runner.';
    }
}

/** The label of the action that fixes `status`, or `undefined` if none can be offered. */
export function fixLabel(status: EnvironmentStatus): string | undefined {
    switch (status.kind) {
        case 'missing-runner': return 'Install jpipe-runner';
        case 'unselected-venv': return 'Use the Folder\'s Environment';
        case 'managed': return 'Select Interpreter';
        case 'no-environment': return 'Create Environment';
        case 'old-python': return 'Select Interpreter';
        default: return undefined;
    }
}

/** The interpreter inside a virtual environment directory. */
export function venvPython(venvDir: string, platform: NodeJS.Platform): string {
    return platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python');
}

/** The steps that create `.venv` in `folder` with `base`, then install jpipe-runner in it. */
export function createEnvironmentCommands(base: PythonCommand, folder: string, platform: NodeJS.Platform): Array<{ name: string; program: string; args: string[] }> {
    const python = venvPython(path.join(folder, '.venv'), platform);
    return [
        { name: 'Create .venv', program: base.program, args: [...base.args, '-m', 'venv', '.venv'] },
        { name: 'Install jpipe-runner', program: python, args: ['-m', 'pip', 'install', 'jpipe-runner'] }
    ];
}

/** Why no environment can be created, when no Python recent enough was found. */
export const NO_BASE_PYTHON = `Creating an environment needs Python ${MIN_PYTHON.join('.')} or newer, and none was found. Install one (python.org, Homebrew, or your distribution), then try again.`;

/** The command that installs jpipe-runner into the environment `python` belongs to. */
export function installRunnerCommand(python: string): { program: string; args: string[] } {
    return { program: python, args: ['-m', 'pip', 'install', 'jpipe-runner'] };
}

/** How a run invokes the runner through an interpreter: `<python> -m jpipe_runner …`. */
export function moduleInvocation(python: string, args: readonly string[]): { program: string; args: string[] } {
    return { program: python, args: ['-m', 'jpipe_runner', ...args] };
}
