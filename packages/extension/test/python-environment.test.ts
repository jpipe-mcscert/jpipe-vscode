import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
    PROBE_SCRIPT,
    basePythonCandidates,
    chooseBasePython,
    createEnvironmentCommands,
    environmentStatus,
    fixLabel,
    installRunnerCommand,
    moduleInvocation,
    parseProbe,
    statusMessage,
    venvPython,
    type Probe
} from '../src/extension/runner/python-environment.js';

/**
 * Whether the Python VS Code uses can run step libraries, and which fix is offered when not. The
 * failure that matters is offering the wrong fix: creating a second environment beside the one a
 * project already has, or installing into a system Python.
 */

const PY = '/usr/bin/python3';
const probe = (over: Partial<Probe> = {}): Probe => ({ version: [3, 12, 1], hasRunner: false, isVirtualEnv: false, ...over });

/** A Python on this machine, if there is one: the probe is Python, so it is checked as Python. */
function systemPython(): string | undefined {
    for (const candidate of ['python3', 'python']) {
        try {
            execFileSync(candidate, ['--version'], { stdio: 'ignore' });
            return candidate;
        } catch { /* try the next */ }
    }
    return undefined;
}
const python = systemPython();

describe('the probe', () => {

    test.skipIf(!python)('runs on a real Python and is understood', () => {
        const stdout = execFileSync(python!, ['-c', PROBE_SCRIPT], { encoding: 'utf8' });
        const parsed = parseProbe(stdout);
        expect(parsed).toBeDefined();
        expect(parsed!.version[0]).toBe(3);
        expect(typeof parsed!.hasRunner).toBe('boolean');
    });

    test('reads the last line, ignoring anything a sitecustomize printed before it', () => {
        expect(parseProbe('Welcome!\n{"version": [3, 11, 4], "runner": true, "venv": true}\n'))
            .toEqual({ version: [3, 11, 4], hasRunner: true, isVirtualEnv: true });
    });

    test('rejects output that is not its answer', () => {
        expect(parseProbe('')).toBeUndefined();
        expect(parseProbe('Python was not found; run without arguments to install from the Microsoft Store')).toBeUndefined();
        expect(parseProbe('{"version": "3.12"}')).toBeUndefined();
    });
});

describe('the status', () => {

    test('ready when the selected Python has jpipe-runner, venv or not', () => {
        expect(environmentStatus(PY, probe({ hasRunner: true }), {}).kind).toBe('ready');
        expect(environmentStatus(PY, probe({ hasRunner: true, isVirtualEnv: true }), {}).kind).toBe('ready');
    });

    test('no Python when none answered', () => {
        expect(environmentStatus(undefined, undefined, {}).kind).toBe('no-python');
        expect(environmentStatus(PY, undefined, {}).kind).toBe('no-python');
    });

    test('a project environment below 3.11 is too old, even with jpipe-runner somehow in it', () => {
        const status = environmentStatus('/w/.venv/bin/python', probe({ version: [3, 10, 12], hasRunner: true, isVirtualEnv: true }), {});
        expect(status).toEqual({ kind: 'old-python', python: '/w/.venv/bin/python', version: '3.10.12' });
        expect(environmentStatus(PY, probe({ version: [3, 11, 0], hasRunner: true }), {}).kind).toBe('ready');
    });

    test('an old system Python — macOS ships 3.9 — gets an environment created, not a version error', () => {
        expect(environmentStatus('/usr/bin/python3', probe({ version: [3, 9, 6] }), {}).kind).toBe('no-environment');
    });

    test('a project environment without jpipe-runner gets it installed', () => {
        expect(environmentStatus('/w/.venv/bin/python', probe({ isVirtualEnv: true }), {}).kind).toBe('missing-runner');
    });

    test('a folder with its own .venv that VS Code does not use: use it, do not make another', () => {
        expect(environmentStatus(PY, probe(), { localVenvPython: '/w/.venv/bin/python', manager: 'Pipenv' }))
            .toEqual({ kind: 'unselected-venv', python: PY, venvPython: '/w/.venv/bin/python' });
    });

    test('a Pipenv or Poetry project: select its environment, do not make another', () => {
        expect(environmentStatus(PY, probe(), { manager: 'Pipenv' })).toEqual({ kind: 'managed', python: PY, manager: 'Pipenv' });
    });

    test('nothing at all: create one', () => {
        expect(environmentStatus(PY, probe(), {}).kind).toBe('no-environment');
    });

    test('every status that needs doing says why, and every fixable one says how', () => {
        const statuses = [
            environmentStatus(undefined, undefined, {}),
            environmentStatus('/v/python', probe({ version: [3, 9, 0], isVirtualEnv: true }), {}),
            environmentStatus('/v/python', probe({ isVirtualEnv: true }), {}),
            environmentStatus(PY, probe(), { localVenvPython: '/w/.venv/bin/python' }),
            environmentStatus(PY, probe(), { manager: 'Poetry' }),
            environmentStatus(PY, probe(), {})
        ];
        for (const status of statuses) expect(statusMessage(status), status.kind).toBeTruthy();
        expect(statuses.map(fixLabel)).toEqual([
            undefined, 'Select Interpreter', 'Install jpipe-runner', 'Use the Folder\'s Environment', 'Select Interpreter', 'Create Environment'
        ]);
        expect(statusMessage(environmentStatus(PY, probe({ hasRunner: true }), {}))).toBeUndefined();
    });
});

describe('the commands', () => {

    test('a new environment is .venv, made with the standard library, then given jpipe-runner, as two distinct steps', () => {
        expect(createEnvironmentCommands({ program: 'python3.13', args: [] }, '/w', 'darwin')).toEqual([
            { name: 'Create .venv', program: 'python3.13', args: ['-m', 'venv', '.venv'] },
            { name: 'Install jpipe-runner', program: path.join('/w', '.venv', 'bin', 'python'), args: ['-m', 'pip', 'install', 'jpipe-runner'] }
        ]);
        expect(createEnvironmentCommands({ program: 'py', args: ['-3.12'] }, 'C:\\w', 'win32')[0].args)
            .toEqual(['-3.12', '-m', 'venv', '.venv']);
    });

    test('the base Python is looked for after the selected one, by name, and with the py launcher on Windows', () => {
        expect(basePythonCandidates('/usr/bin/python3', 'darwin').map(c => c.program))
            .toEqual(['/usr/bin/python3', 'python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11']);
        expect(basePythonCandidates(undefined, 'win32')[0]).toEqual({ program: 'py', args: ['-3'] });
    });

    test('the base Python is the first one recent enough', () => {
        const old = { command: { program: '/usr/bin/python3', args: [] }, version: [3, 9, 6] };
        const missing = { command: { program: 'python3.14', args: [] } };
        const fine = { command: { program: 'python3.13', args: [] }, version: [3, 13, 1] };
        expect(chooseBasePython([old, missing, fine])).toEqual(fine.command);
        expect(chooseBasePython([old, missing])).toBeUndefined();
    });

    test('on Windows, a virtual environment keeps its Python in Scripts', () => {
        expect(venvPython(path.join('C:\\w', '.venv'), 'win32')).toBe(path.join('C:\\w', '.venv', 'Scripts', 'python.exe'));
    });

    test('jpipe-runner is installed with the environment\'s own pip', () => {
        expect(installRunnerCommand('/w/.venv/bin/python')).toEqual({ program: '/w/.venv/bin/python', args: ['-m', 'pip', 'install', 'jpipe-runner'] });
    });

    test('a run starts the runner as a module of the selected Python', () => {
        expect(moduleInvocation('/w/.venv/bin/python', ['-l', 'a.py', 'r.json']))
            .toEqual({ program: '/w/.venv/bin/python', args: ['-m', 'jpipe_runner', '-l', 'a.py', 'r.json'] });
    });
});
