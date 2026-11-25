import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
    PROBE_SCRIPT,
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
    moduleInvocation,
    parseEnvironmentPath,
    parseProbe,
    parseRunnerVersion,
    requirementChangeKind,
    requirementsFile,
    restorePublishedCommands,
    runnablePython,
    runnerRequirement,
    statusMessage,
    venvPython,
    withRunnerRequirement,
    withoutActiveEnvironment,
    workspaceEnvironment,
    type Probe
} from '../src/extension/runner/python-environment.js';

/**
 * Which environment is the workspace's own, whether it can run step libraries, and which fix is
 * offered when not. The failures that matter: taking another project's environment for this one's
 * — and installing into it —, creating a second environment beside the one a project already has,
 * installing behind the back of the tool that manages the project, and changing a project file
 * without having said so.
 */

const VENV = '/w/.venv/bin/python';
const probe = (over: Partial<Probe> = {}): Probe => ({ version: [3, 12, 1], hasRunner: false, isVirtualEnv: true, ...over });
const usable = probe({ hasRunner: true, runnerVersion: '4.0.0' });

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
        expect(parseProbe('{"version": [3, 14, 10], "runner": true, "release": "3.5.3", "venv": true}')?.runnerVersion).toBe('3.5.3');
        expect(parseProbe('{"version": [3, 14, 10], "runner": false, "release": null, "venv": true}')?.runnerVersion).toBeUndefined();
    });

    test('rejects output that is not its answer', () => {
        expect(parseProbe('')).toBeUndefined();
        expect(parseProbe('Python was not found; run without arguments to install from the Microsoft Store')).toBeUndefined();
        expect(parseProbe('{"version": "3.12"}')).toBeUndefined();
    });
});

describe('the workspace\'s own environment', () => {

    test('is the one its manager keeps for it, wherever that is', () => {
        expect(workspaceEnvironment({ manager: 'Pipenv', managedEnvironment: '/envs/app-Oi4O8zst' }, 'darwin'))
            .toEqual({ python: path.join('/envs/app-Oi4O8zst', 'bin', 'python'), manager: 'Pipenv' });
        // Before a stray directory in the folder, which the tool does not use.
        expect(workspaceEnvironment({ manager: 'Poetry', managedEnvironment: '/envs/app', folderVenvPython: '/w/venv/bin/python' }, 'darwin').python)
            .toBe(path.join('/envs/app', 'bin', 'python'));
    });

    test('else the virtual environment at its root, which is also where uv keeps one', () => {
        expect(workspaceEnvironment({ folderVenvPython: VENV }, 'darwin')).toEqual({ python: VENV });
        expect(workspaceEnvironment({ manager: 'uv', folderVenvPython: VENV }, 'darwin')).toEqual({ python: VENV, manager: 'uv' });
    });

    test('and nothing else: there is no interpreter to fall back on', () => {
        expect(workspaceEnvironment({}, 'darwin')).toEqual({});
        expect(workspaceEnvironment({ manager: 'Pipenv' }, 'darwin')).toEqual({ manager: 'Pipenv' });
    });
});

describe('the status', () => {

    test('ready when the workspace\'s environment has jpipe-runner and the editor uses it, or cannot be told', () => {
        expect(environmentStatus({ python: VENV }, usable, 'same')).toEqual({ kind: 'ready', python: VENV });
        expect(environmentStatus({ python: VENV }, usable, 'none')).toEqual({ kind: 'ready', python: VENV });
        expect(environmentStatus({ python: '/envs/app/bin/python', manager: 'Pipenv' }, usable, 'same').kind).toBe('ready');
    });

    test('an editor on another Python does not stop a run: only the editor is behind', () => {
        const status = environmentStatus({ python: VENV }, usable, 'other');
        expect(status).toEqual({ kind: 'unselected', python: VENV });
        expect(runnablePython(status)).toBe(VENV);
        expect(fixLabel(status)).toBe('Use the Workspace\'s Environment');
        // Nothing of the project's changes, so there is nothing to agree to.
        expect(fixConsequences(status)).toBeUndefined();
    });

    test('a workspace with no environment gets one created — whatever Python is selected in VS Code', () => {
        // The status is not even told which interpreter is selected: another project's cannot count.
        const status = environmentStatus({}, undefined, 'other');
        expect(status).toEqual({ kind: 'no-environment' });
        expect(fixLabel(status)).toBe('Create Environment');
        expect(runnablePython(status)).toBeUndefined();
    });

    test('a managed project with no environment yet has its tool make it', () => {
        const status = environmentStatus({ manager: 'Pipenv' }, undefined, 'other');
        expect(status).toEqual({ kind: 'missing-runner', manager: 'Pipenv' });
        expect(fixLabel(status)).toBe('Add jpipe-runner with Pipenv');
    });

    test('an environment that does not answer is rebuilt, by the tool or over itself', () => {
        expect(environmentStatus({ python: VENV }, undefined, 'none')).toEqual({ kind: 'no-environment' });
        expect(environmentStatus({ python: VENV, manager: 'uv' }, undefined, 'none')).toEqual({ kind: 'missing-runner', manager: 'uv' });
    });

    test('an environment without jpipe-runner gets it: with pip, or by the tool that manages it', () => {
        expect(environmentStatus({ python: VENV }, probe(), 'same')).toEqual({ kind: 'missing-runner', python: VENV });
        expect(fixLabel(environmentStatus({ python: VENV }, probe(), 'same'))).toBe('Install jpipe-runner');
        const managed = environmentStatus({ python: '/envs/app/bin/python', manager: 'Poetry' }, probe(), 'same');
        expect(managed).toEqual({ kind: 'missing-runner', python: '/envs/app/bin/python', manager: 'Poetry' });
        expect(fixLabel(managed)).toBe('Add jpipe-runner with Poetry');
    });

    test('a jpipe-runner too old for step libraries is not ready: it imports, and has no @evidence', () => {
        const old = probe({ hasRunner: true, runnerVersion: '3.5.3' });
        const statuses = [
            environmentStatus({ python: '/envs/app/bin/python', manager: 'Pipenv' }, old, 'same'),
            environmentStatus({ python: VENV }, old, 'same')
        ];
        expect(statuses[0]).toEqual({ kind: 'missing-runner', python: '/envs/app/bin/python', manager: 'Pipenv', outdated: '3.5.3' });
        expect(statuses[1]).toEqual({ kind: 'missing-runner', python: VENV, outdated: '3.5.3' });
        for (const status of statuses) {
            expect(statusMessage(status)).toContain('3.5.3');
            expect(fixLabel(status)).toContain('Upgrade');
        }
    });

    test('a jpipe-runner recent enough, or one with no release to read, is taken as it is', () => {
        expect(environmentStatus({ python: VENV }, probe({ hasRunner: true, runnerVersion: '4.1.0rc1' }), 'same').kind).toBe('ready');
        expect(environmentStatus({ python: VENV }, probe({ hasRunner: true }), 'same').kind).toBe('ready');
    });

    test('an environment below Python 3.11 is too old, even with jpipe-runner somehow in it, and is not ours to rebuild', () => {
        const status = environmentStatus({ python: VENV }, probe({ version: [3, 10, 12], hasRunner: true }), 'same');
        expect(status).toEqual({ kind: 'old-python', python: VENV, version: '3.10.12' });
        expect(statusMessage(status)).toContain('3.10.12');
        expect(fixLabel(status)).toBeUndefined();
        expect(environmentStatus({ python: VENV }, probe({ version: [3, 11, 0], hasRunner: true }), 'same').kind).toBe('ready');
    });

    test('every status that needs doing says why', () => {
        const statuses = [
            environmentStatus({ python: VENV }, probe({ version: [3, 9, 0] }), 'same'),
            environmentStatus({ python: VENV }, probe(), 'same'),
            environmentStatus({ python: VENV }, usable, 'other'),
            environmentStatus({ manager: 'Poetry' }, undefined, 'none'),
            environmentStatus({}, undefined, 'none')
        ];
        for (const status of statuses) expect(statusMessage(status), status.kind).toBeTruthy();
        expect(statusMessage(environmentStatus({ python: VENV }, usable, 'same'))).toBeUndefined();
    });
});

describe('the report', () => {

    const places = { folder: '/home/me/work/demo', home: '/home/me' };

    test('fits a narrow dialog: a few words a line, the environment by its folder, paths from the workspace or ~', () => {
        expect(environmentReport({
            environment: { python: '/home/me/work/demo/.venv/bin/python' },
            probe: probe({ version: [3, 15, 2], hasRunner: true, runnerVersion: '4.0.0' }),
            editorPython: '/home/me/work/demo/.venv/bin/python',
            editorFollows: true,
            machineRunner: '4.0.0'
        }, places)).toBe([
            'Environment: .venv',
            'Python: 3.15.2',
            'jpipe-runner: 4.0.0',
            '  4.1.0 or newer shows runs as they go',
            '  4.4.0 or newer runs steps together',
            'Editor: uses this environment',
            'Also on this computer: 4.0.0'
        ].join('\n'));
    });

    test('says what upgrading jpipe-runner brings, from the release that brings it, and only when its release is known', () => {
        const report = (runnerVersion?: string) => environmentReport({
            environment: { python: '/home/me/work/demo/.venv/bin/python' },
            probe: probe({ version: [3, 15, 2], hasRunner: true, ...(runnerVersion ? { runnerVersion } : {}) }),
            editorPython: '/home/me/work/demo/.venv/bin/python',
            editorFollows: true
        }, places);
        expect(report('4.0.3')).toContain('4.1.0 or newer shows runs as they go\n  4.4.0 or newer runs steps together');
        for (const version of ['4.1.0', '4.1.0.dev0', '4.3.2']) {
            expect(report(version)).not.toContain('or newer shows runs');
            expect(report(version)).toContain('4.4.0 or newer runs steps together');
        }
        for (const version of ['4.4.0', '4.4.0.dev0', '5.0.0rc1', undefined]) {
            expect(report(version)).not.toContain(' or newer ');
        }
    });

    test('a local runner has its version too, with where it is, beside the one on this computer', () => {
        expect(environmentReport({
            environment: { python: '/home/me/work/demo/.venv/bin/python' },
            probe: probe({ version: [3, 15, 2], hasRunner: true, runnerVersion: '4.1.0.dev0', localSource: '/home/me/work/jpipe-runner' }),
            editorPython: '/home/me/work/demo/.venv/bin/python',
            editorFollows: true,
            machineRunner: '4.0.0',
            localSource: '/home/me/work/jpipe-runner'
        }, places)).toBe([
            'Environment: .venv',
            'Python: 3.15.2',
            'jpipe-runner: 4.1.0.dev0 (local copy)',
            `  ${path.join('~', 'work', 'jpipe-runner')}`,
            '  4.4.0 or newer runs steps together',
            'Editor: uses this environment',
            'Also on this computer: 4.0.0'
        ].join('\n'));
    });

    test('says what is off: an editor elsewhere, a local copy asked for and not installed, a managed environment', () => {
        expect(environmentReport({
            environment: { python: '/home/me/.local/share/virtualenvs/demo-Ab12/bin/python', manager: 'Pipenv' },
            probe: probe({ version: [3, 13, 0], hasRunner: false }),
            editorPython: '/opt/homebrew/bin/python3',
            editorFollows: false,
            localSource: '/home/me/work/jpipe-runner'
        }, places)).toBe([
            `Environment: ${path.join('~', '.local', 'share', 'virtualenvs', 'demo-Ab12')} (Pipenv)`,
            'Python: 3.13.0',
            'jpipe-runner: not installed',
            'Editor: uses another Python',
            '  /opt/homebrew/bin/python3',
            'Development mode asks for a local copy',
            `  ${path.join('~', 'work', 'jpipe-runner')}`
        ].join('\n'));
    });

    test('says so when there is nothing to lay out', () => {
        expect(environmentReport({ environment: {}, editorPython: null })).toBe([
            'Environment: none yet',
            'Editor: no Python extension'
        ].join('\n'));
    });

    test('a local runner whose version moved since it was installed is to be reinstalled, and still runs', () => {
        const environment = { python: '/w/.venv/bin/python' };
        const installed = probe({ hasRunner: true, runnerVersion: '4.0.0', localSource: '/src/jpipe-runner' });
        const status = environmentStatus(environment, installed, 'same', { path: '/src/jpipe-runner', declared: '4.1.0.dev0' });
        expect(status).toMatchObject({ kind: 'runner-source', wanted: '/src/jpipe-runner', stale: { recorded: '4.0.0', declared: '4.1.0.dev0' } });
        expect(statusMessage(status)).toContain('now 4.1.0.dev0');
        expect(fixLabel(status)).toBe('Reinstall the Local jpipe-runner');
        expect(fixConsequences(status)).toContain('so that it is 4.1.0.dev0 there too');
        expect(runnablePython(status)).toBe('/w/.venv/bin/python');
        // The same version, or a project that does not say its version, is left alone.
        expect(environmentStatus(environment, installed, 'same', { path: '/src/jpipe-runner', declared: '4.0.0' }).kind).toBe('ready');
        expect(environmentStatus(environment, installed, 'same', { path: '/src/jpipe-runner' }).kind).toBe('ready');
        expect(environmentReport({ environment, probe: installed, editorFollows: true, declaredLocal: '4.1.0.dev0' }).split('\n'))
            .toContain('  now 4.1.0.dev0: reinstall it');
    });

    test.each([
        ['[project]\nname = "x"\nversion = "1.2.3"\n', '1.2.3'],
        ['[tool.poetry]\nname = "jpipe-runner"\nversion = "4.1.0.dev0"\n[tool.other]\nversion = "9"\n', '4.1.0.dev0'],
        ["[project]\nversion = '2.0'  # released\n", '2.0'],
        ['[tool.black]\nversion = "9"\n[project]\ndynamic = ["version"]\n', undefined]
    ])('a project declares its version in pyproject.toml: %j', (pyproject, version) => {
        expect(declaredVersion(pyproject)).toBe(version);
    });

    test('no line is wider than a narrow dialog, home paths included', () => {
        const report = environmentReport({
            environment: { python: '/home/me/work/demo/.venv/bin/python' },
            probe: probe({ hasRunner: true, runnerVersion: '4.0.0.dev0', localSource: '/home/me/work/jpipe/jpipe-runner' }),
            editorPython: '/home/me/work/demo/.venv/bin/python',
            editorFollows: true
        }, places);
        expect(report).toContain(' or newer ');
        for (const line of report.split('\n')) expect(line.length, line).toBeLessThanOrEqual(40);
    });

    test('a runner program named by the user is not an environment to report on or fix', () => {
        expect(statusMessage({ kind: 'external' })).toBeUndefined();
        expect(fixLabel({ kind: 'external' })).toBeUndefined();
        expect(runnablePython({ kind: 'external' })).toBeUndefined();
    });
});

describe('what a fix changes is said before it is done', () => {

    test('creating an environment reads as a short list of what jPipe will do', () => {
        expect(fixConsequences({ kind: 'no-environment' }, { file: 'requirements.txt', change: 'create' }, 'jpipe-demo')).toBe([
            'jPipe will:',
            '• Create a Python environment for this workspace, in a new .venv folder, shown as “jpipe-demo” in VS Code and in your terminal',
            '• Install jpipe-runner in it',
            '• Create requirements.txt, so that the execution is reproducible',
            '',
            'Nothing else in this folder is changed.'
        ].join('\n'));
        expect(fixConsequences({ kind: 'no-environment' }, { file: 'requirements-dev.txt', change: 'add' }))
            .toContain('• Add jpipe-runner to requirements-dev.txt, so that the execution is reproducible');
    });

    test('it leaves versions out: they are a detail of how, not of what changes', () => {
        for (const text of [
            fixConsequences({ kind: 'no-environment' }, { file: 'requirements.txt', change: 'create' }),
            fixConsequences({ kind: 'missing-runner', manager: 'Pipenv' }),
            fixConsequences({ kind: 'missing-runner', python: VENV, outdated: '3.5.3' }, { file: 'requirements.txt', change: 'replace' })
        ]) expect(text).not.toMatch(/\d+\.\d+/);
    });

    test.each([
        ['Pipenv', 'Pipfile and Pipfile.lock'],
        ['Poetry', 'pyproject.toml and poetry.lock'],
        ['uv', 'pyproject.toml and uv.lock']
    ] as const)('%s is named as the one that updates %s', (manager, files) => {
        const text = fixConsequences({ kind: 'missing-runner', manager })!;
        expect(text).toContain(`• Ask ${manager} to add jpipe-runner to this project`);
        expect(text).toContain(`${manager} will update ${files}.`);
        expect(text).toContain('create the project\'s environment');
        expect(fixConsequences({ kind: 'missing-runner', manager, python: '/envs/app/bin/python' })).not.toContain('create the project\'s environment');
    });

    test('installing with pip says whether a project file changes with it', () => {
        expect(fixConsequences({ kind: 'missing-runner', python: VENV })).toContain('None of your project files is changed.');
        const upgraded = fixConsequences({ kind: 'missing-runner', python: VENV, outdated: '3.5.3' }, { file: 'requirements.txt', change: 'replace' })!;
        expect(upgraded).toContain('• Update the jpipe-runner line of requirements.txt');
        expect(upgraded).toContain('No other file of your project is changed.');
    });

    test('the change to a requirements file is named for what it is', () => {
        expect(requirementChangeKind(false, '')).toBe('create');
        expect(requirementChangeKind(true, 'requests\n')).toBe('add');
        expect(requirementChangeKind(true, 'requests\njpipe-runner==3.5.3\n')).toBe('replace');
    });
});

describe('an environment activated in the shell VS Code was started from', () => {

    const inherited = {
        HOME: '/home/me',
        VIRTUAL_ENV: '/envs/other-project',
        VIRTUAL_ENV_PROMPT: 'other-project',
        PIPENV_ACTIVE: '1',
        PATH: '/envs/other-project/bin:/opt/homebrew/bin:/usr/bin'
    };

    test('is taken out, so python3 and the managers see the workspace and not that project', () => {
        expect(withoutActiveEnvironment(inherited, 'darwin')).toEqual({ HOME: '/home/me', PATH: '/opt/homebrew/bin:/usr/bin' });
    });

    test('leaves an environment without one as it is', () => {
        const plain = { HOME: '/home/me', PATH: '/opt/homebrew/bin:/usr/bin' };
        expect(withoutActiveEnvironment(plain, 'darwin')).toEqual(plain);
    });

    test('on Windows, whatever the case of Path', () => {
        const cleaned = withoutActiveEnvironment({ VIRTUAL_ENV: 'C:\\envs\\other', Path: 'C:\\envs\\other\\Scripts;C:\\Python313' }, 'win32');
        expect(Object.keys(cleaned)).toEqual(['Path']);
    });

    test('a run has the workspace\'s own activated instead', () => {
        expect(activatedEnvironment(inherited, VENV, 'darwin')).toEqual({
            HOME: '/home/me',
            VIRTUAL_ENV: '/w/.venv',
            PATH: '/w/.venv/bin:/opt/homebrew/bin:/usr/bin'
        });
    });

    test('a task cannot drop what VS Code inherited, so a run blanks it', () => {
        // VS Code lays a task's environment over its own: leaving PYTHONHOME out would keep it.
        const parent = { ...inherited, PYTHONHOME: '/opt/other', PIPENV_ACTIVE: '1' };
        const run = overInherited(activatedEnvironment(parent, VENV, 'darwin'), parent);
        expect(run).toMatchObject({ VIRTUAL_ENV: '/w/.venv', PYTHONHOME: '', PIPENV_ACTIVE: '', HOME: '/home/me' });
        expect(run.PATH).toBe('/w/.venv/bin:/opt/homebrew/bin:/usr/bin');
    });

    test('with nothing inherited to drop, a run\'s environment is left as it is', () => {
        const plain = { HOME: '/home/me', PATH: '/usr/bin' };
        const activated = activatedEnvironment(plain, VENV, 'darwin');
        expect(overInherited(activated, plain)).toEqual(activated);
    });
});

describe('the editor\'s complaint', () => {

    test.each([
        'Import "jpipe_runner" could not be resolved',
        'Import "jpipe_runner.framework" could not be resolved from source',
        '"evidence" is unknown import symbol in jpipe_runner',
        'Cannot find implementation or library stub for module named "jpipe_runner"',
        'Unable to import \'jpipe_runner\'',
        'No module named jpipe_runner'
    ])('is recognised: %s', message => {
        expect(isRunnerImportProblem(message)).toBe(true);
    });

    test.each([
        'Import "requests" could not be resolved',
        '"jpipe_runner" is not accessed',
        'Import "my_jpipe_runner_helpers" could not be resolved'
    ])('is not mistaken for: %s', message => {
        expect(isRunnerImportProblem(message)).toBe(false);
    });
});

describe('the project\'s manager', () => {

    const project = (files: Record<string, string>) =>
        detectManager(file => file in files, file => files[file]);

    test.each([
        ['a Pipfile', { Pipfile: '' }, 'Pipenv'],
        ['Poetry\'s lock file', { 'poetry.lock': '', 'pyproject.toml': '' }, 'Poetry'],
        ['uv\'s lock file', { 'uv.lock': '', 'pyproject.toml': '' }, 'uv'],
        ['a pyproject configuring Poetry, before anything is locked', { 'pyproject.toml': '[project]\nname = "a"\n\n[tool.poetry.dependencies]\npython = "^3.12"\n' }, 'Poetry'],
        ['a pyproject configuring uv', { 'pyproject.toml': '[project]\nname = "a"\n[tool.uv]\ndev-dependencies = []\n' }, 'uv']
    ])('is read from %s', (_case, files, manager) => {
        expect(project(files)).toBe(manager);
    });

    test('is nobody for a project installed with pip, or with no project file at all', () => {
        expect(project({ 'pyproject.toml': '[project]\nname = "a"\n[tool.ruff]\nline-length = 100\n' })).toBeUndefined();
        expect(project({ 'requirements.txt': 'requests\n' })).toBeUndefined();
        expect(project({})).toBeUndefined();
    });

    test('adds jpipe-runner itself, as a development dependency', () => {
        expect(addRunnerCommand('Pipenv')).toMatchObject({ program: 'pipenv', args: ['install', '--dev', 'jpipe-runner>=4.0.0'] });
        expect(addRunnerCommand('Poetry')).toMatchObject({ program: 'poetry', args: ['add', '--group', 'dev', 'jpipe-runner>=4.0.0'] });
        expect(addRunnerCommand('uv')).toMatchObject({ program: 'uv', args: ['add', '--dev', 'jpipe-runner>=4.0.0'] });
    });

    test('says where its environment is, except uv, whose environment is the folder\'s .venv', () => {
        expect(locateEnvironmentCommand('Pipenv')).toEqual({ program: 'pipenv', args: ['--venv'] });
        expect(locateEnvironmentCommand('Poetry')).toEqual({ program: 'poetry', args: ['env', 'info', '--path'] });
        expect(locateEnvironmentCommand('uv')).toBeUndefined();
    });

    test('is believed about a directory, not about a notice', () => {
        const dir = path.resolve('/home/me/.local/share/virtualenvs/app-Oi4O8zst');
        expect(parseEnvironmentPath(`Courtesy Notice: Pipenv found itself running within a virtual environment.\n${dir}\n`)).toBe(dir);
        expect(parseEnvironmentPath('No virtualenv has been created for this project yet!\n')).toBeUndefined();
        expect(parseEnvironmentPath('')).toBeUndefined();
    });
});

describe('a project installed with pip', () => {

    test('records the runner in the requirements file it has, the development one first', () => {
        expect(requirementsFile(file => ['requirements.txt', 'requirements-dev.txt'].includes(file))).toBe('requirements-dev.txt');
        expect(requirementsFile(file => file === 'requirements.txt')).toBe('requirements.txt');
        expect(requirementsFile(() => false)).toBeUndefined();
    });

    test('gets jpipe-runner on a line of its own, once', () => {
        expect(withRunnerRequirement('')).toBe('jpipe-runner>=4.0.0\n');
        expect(withRunnerRequirement('requests>=2\n')).toBe('requests>=2\njpipe-runner>=4.0.0\n');
        expect(withRunnerRequirement('requests>=2')).toBe('requests>=2\njpipe-runner>=4.0.0\n');
        expect(withRunnerRequirement('requests\njpipe-runner==4.2.0\n')).toBeUndefined();
        expect(withRunnerRequirement('jpipe_runner>=2\n')).toBeUndefined();
        // A package whose name merely starts the same way is not the runner.
        expect(withRunnerRequirement('jpipe-runner-extras\n')).toBe('jpipe-runner-extras\njpipe-runner>=4.0.0\n');
    });

    test('has the line that held it on an old release replaced, when upgrading', () => {
        expect(withRunnerRequirement('requests\njpipe-runner==3.5.3\nrich\n', true)).toBe('requests\njpipe-runner>=4.0.0\nrich\n');
        expect(withRunnerRequirement('jpipe-runner>=4.0.0\n', true)).toBeUndefined();
    });
});

describe('the jpipe-runner installed on the machine', () => {

    test('says its release', () => {
        expect(parseRunnerVersion('jpipe-runner 4.0.0\n')).toBe('4.0.0');
        expect(parseRunnerVersion('jpipe-runner, version 4.1.2\n')).toBe('4.1.2');
        expect(parseRunnerVersion('usage: jpipe-runner [-h] file\n')).toBeUndefined();
        expect(parseRunnerVersion('')).toBeUndefined();
    });

    test('is the release pip installs in the workspace, so the button and the terminal agree', () => {
        expect(runnerRequirement('4.0.0')).toBe('jpipe-runner==4.0.0');
        expect(runnerRequirement('4.2.1')).toBe('jpipe-runner==4.2.1');
        expect(installRunnerCommand('/w/.venv/bin/python', runnerRequirement('4.2.1')).args).toEqual(['-m', 'pip', 'install', 'jpipe-runner==4.2.1']);
        expect(createEnvironmentCommands({ program: 'python3', args: [] }, '/w', 'darwin', runnerRequirement('4.2.1'))[1].args).toContain('jpipe-runner==4.2.1');
    });

    test('is not followed when there is none, when it is too old for step libraries, or when it is not a plain release', () => {
        expect(runnerRequirement(undefined)).toBe('jpipe-runner>=4.0.0');
        expect(runnerRequirement('3.5.3')).toBe('jpipe-runner>=4.0.0');
        expect(runnerRequirement('4.1.0.dev3+g1a2b3c')).toBe('jpipe-runner>=4.0.0');
    });

    test('is never what a project file records: any release from 4.0.0 on works, so that is what is written', () => {
        expect(withRunnerRequirement('requests\n')).toBe('requests\njpipe-runner>=4.0.0\n');
        expect(addRunnerCommand('Pipenv').args).toEqual(['install', '--dev', 'jpipe-runner>=4.0.0']);
    });
});

describe('a local jpipe-runner, for working on the runner itself', () => {

    const CHECKOUT = path.resolve('/home/me/work/jpipe-runner');
    const published = probe({ hasRunner: true, runnerVersion: '4.0.0' });
    const editable = probe({ hasRunner: true, runnerVersion: '4.0.0', localSource: CHECKOUT });

    test('is recognised from what pip records of an editable install, and only of one', () => {
        const answer = (local: unknown) => parseProbe(JSON.stringify({ version: [3, 13, 0], runner: true, release: '4.1.0.dev0', local, venv: true }));
        expect(answer('file:///home/me/work/jpipe-runner')?.localSource).toBe(CHECKOUT);
        expect(answer(null)?.localSource).toBeUndefined();
        expect(answer('not a url')?.localSource).toBeUndefined();
    });

    test('named in the settings and running in the environment: ready, whatever its release', () => {
        expect(environmentStatus({ python: VENV }, editable, 'same', { path: CHECKOUT }).kind).toBe('ready');
        expect(environmentStatus({ python: VENV }, editable, 'same', { path: CHECKOUT + path.sep }).kind).toBe('ready');
        const unreleased = probe({ hasRunner: true, runnerVersion: '0.0.1.dev0', localSource: CHECKOUT });
        expect(environmentStatus({ python: VENV }, unreleased, 'other', { path: CHECKOUT }).kind).toBe('unselected');
    });

    test('named in the settings while the environment runs a release, or another checkout: install it', () => {
        for (const found of [published, probe(), probe({ hasRunner: true, localSource: '/elsewhere/jpipe-runner' })]) {
            const status = environmentStatus({ python: VENV }, found, 'same', { path: CHECKOUT });
            expect(status).toEqual({ kind: 'runner-source', python: VENV, wanted: CHECKOUT });
            expect(fixLabel(status)).toBe('Install the Local jpipe-runner');
            expect(statusMessage(status)).toContain(CHECKOUT);
            expect(runnablePython(status)).toBeUndefined();
        }
    });

    test('goes into a managed project\'s environment too, with pip and the warning that its tool does not know', () => {
        const status = environmentStatus({ python: '/envs/app/bin/python', manager: 'Pipenv' }, published, 'same', { path: CHECKOUT });
        expect(status).toEqual({ kind: 'runner-source', python: '/envs/app/bin/python', manager: 'Pipenv', wanted: CHECKOUT });
        const agreed = fixConsequences(status)!;
        expect(agreed).toContain(`from your local copy (${CHECKOUT})`);
        expect(agreed).toContain('None of your project files is changed.');
        expect(agreed).toContain('Pipenv does not know about it');
    });

    test('no longer named while the environment still runs it: back to a published release', () => {
        const status = environmentStatus({ python: VENV }, editable, 'same');
        expect(status).toEqual({ kind: 'runner-source', python: VENV, installed: CHECKOUT });
        expect(fixLabel(status)).toBe('Install the Published jpipe-runner');
        expect(fixConsequences(status)).toContain('Remove the local jpipe-runner');
        expect(restorePublishedCommands(VENV).map(step => step.args)).toEqual([
            ['-m', 'pip', 'uninstall', '-y', 'jpipe-runner'],
            ['-m', 'pip', 'install', 'jpipe-runner>=4.0.0']
        ]);
    });

    test('installed by hand in a managed project, with no setting, is left to the user and their tool', () => {
        expect(environmentStatus({ python: '/envs/app/bin/python', manager: 'Poetry' }, editable, 'same').kind).toBe('ready');
    });

    test('is installed editable, so a change to the runner shows in the next run', () => {
        expect(installRunnerCommand(VENV, { local: CHECKOUT }).args).toEqual(['-m', 'pip', 'install', '-e', CHECKOUT]);
        expect(createEnvironmentCommands({ program: 'python3', args: [] }, '/w', 'darwin', { local: CHECKOUT })[1].args)
            .toEqual(['-m', 'pip', 'install', '-e', CHECKOUT]);
        expect(fixConsequences({ kind: 'no-environment' }, { file: 'requirements.txt', change: 'create' }, 'jpipe-w', { path: CHECKOUT }))
            .toContain(`• Install jpipe-runner in it, from your local copy (${CHECKOUT})`);
    });

    test('never reaches a project file: a path on one machine is nobody else\'s', () => {
        expect(withRunnerRequirement('requests\n')).toBe('requests\njpipe-runner>=4.0.0\n');
    });

    test('must be a Python project to be installed; otherwise it is said, and nothing is offered', () => {
        expect(isPythonProject(file => file === 'pyproject.toml')).toBe(true);
        expect(isPythonProject(file => file === 'setup.py')).toBe(true);
        expect(isPythonProject(() => false)).toBe(false);
        const status = { kind: 'no-local-source', path: CHECKOUT } as const;
        expect(statusMessage(status)).toContain(CHECKOUT);
        expect(fixLabel(status)).toBeUndefined();
    });

});

describe('the commands', () => {

    test('a new environment is .venv, made with the standard library, then given jpipe-runner, as two distinct steps', () => {
        expect(createEnvironmentCommands({ program: 'python3.13', args: [] }, '/w', 'darwin')).toEqual([
            { name: 'Create .venv', program: 'python3.13', args: ['-m', 'venv', '--prompt', 'jpipe-w', '.venv'] },
            { name: 'Install jpipe-runner', program: path.join('/w', '.venv', 'bin', 'python'), args: ['-m', 'pip', 'install', 'jpipe-runner>=4.0.0'] }
        ]);
        expect(createEnvironmentCommands({ program: 'py', args: ['-3.12'] }, 'C:\\w', 'win32', undefined, 'w')[0].args)
            .toEqual(['-3.12', '-m', 'venv', '--prompt', 'w', '.venv']);
    });

    test('the nickname says jPipe made it and which workspace it is for', () => {
        expect(environmentNickname('demo-bellairs-cse')).toBe('jpipe-demo-bellairs-cse');
        // A folder already named for jPipe does not get the word twice.
        expect(environmentNickname('jpipe-tutorial-2026')).toBe('jpipe-tutorial-2026');
        expect(environmentNickname('My jPipe models')).toBe('My jPipe models');
    });

    test('the new environment is nicknamed after the workspace, so it can be told from every other .venv', () => {
        const [create] = createEnvironmentCommands({ program: 'python3', args: [] }, '/home/me/work/checkout', 'darwin', undefined, 'Bellairs demo');
        expect(create.args).toEqual(['-m', 'venv', '--prompt', 'Bellairs demo', '.venv']);
        expect(fixConsequences({ kind: 'no-environment' }, undefined, 'Bellairs demo'))
            .toContain('in a new .venv folder, shown as “Bellairs demo” in VS Code and in your terminal');
    });

    test('the base Python is looked for after the selected one, by name, and with the py launcher on Windows', () => {
        expect(basePythonCandidates('/usr/bin/python3', 'darwin').map(c => c.program))
            .toEqual(['/usr/bin/python3', 'python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11']);
        expect(basePythonCandidates(undefined, 'win32')[0]).toEqual({ program: 'py', args: ['-3'] });
    });

    test('the base Python is the first install recent enough, never another project\'s environment', () => {
        const old = { command: { program: '/usr/bin/python3', args: [] }, version: [3, 9, 6], isVirtualEnv: false };
        const missing = { command: { program: 'python3.14', args: [] } };
        const foreign = { command: { program: '/envs/other/bin/python', args: [] }, version: [3, 14, 0], isVirtualEnv: true };
        const fine = { command: { program: 'python3.13', args: [] }, version: [3, 13, 1], isVirtualEnv: false };
        expect(chooseBasePython([foreign, old, missing, fine])).toEqual(fine.command);
        expect(chooseBasePython([foreign, old, missing])).toBeUndefined();
    });

    test('on Windows, a virtual environment keeps its Python in Scripts', () => {
        expect(venvPython(path.join('C:\\w', '.venv'), 'win32')).toBe(path.join('C:\\w', '.venv', 'Scripts', 'python.exe'));
    });

    test('jpipe-runner is installed with the environment\'s own pip', () => {
        expect(installRunnerCommand('/w/.venv/bin/python')).toEqual({ program: '/w/.venv/bin/python', args: ['-m', 'pip', 'install', 'jpipe-runner>=4.0.0'] });
    });

    test('a run starts the runner as a module of the workspace\'s Python', () => {
        expect(moduleInvocation('/w/.venv/bin/python', ['-l', 'a.py', 'r.json']))
            .toEqual({ program: '/w/.venv/bin/python', args: ['-m', 'jpipe_runner', '-l', 'a.py', 'r.json'] });
    });
});
