import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
    addRunnerCommand,
    branchHeadCommand,
    branchUrl,
    createEnvironmentCommands,
    developmentRunnerLabel,
    environmentReport,
    environmentStatus,
    fixConsequences,
    fixLabel,
    installLocalCommands,
    isChosenRelease,
    parseCommit,
    parseProbe,
    runnablePython,
    runnerRequirement,
    statusMessage,
    type Probe
} from '../src/extension/runner/python-environment.js';
import { choosableReleases, isPypiHost, PYPI_RELEASES_URL, releaseItems } from '../src/extension/runner/runner-releases.js';
import { validateRequestUrl } from '../src/extension/compiler/release-download.js';

/**
 * Which jpipe-runner a workspace runs (jpipe-vscode ADR-VSC-0036): a release chosen from those PyPI
 * lists, or, in development mode, a local copy, as it stands or as one of its branches was last
 * committed. The failures that matter: an environment left on another release than the one chosen
 * with nothing said, a branch with new commits run as if it had none, and a development runner
 * taken for a release.
 */

const VENV = '/w/.venv/bin/python';
const CHECKOUT = path.resolve('/home/me/work/jpipe-runner');
const HEAD = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);
const probe = (over: Partial<Probe> = {}): Probe => ({ version: [3, 12, 1], hasRunner: true, runnerVersion: '4.4.0', isVirtualEnv: true, ...over });

describe('the release list PyPI gives', () => {

    const file = (time: string, yanked = false) => ({ upload_time_iso_8601: time, yanked });
    const answer = {
        releases: {
            '2.0.0b27': [file('2024-01-01T00:00:00Z')],
            '3.6.0': [file('2025-01-01T00:00:00Z')],
            '4.0.0': [file('2026-01-02T10:00:00Z'), file('2026-01-01T09:00:00Z')],
            '4.9.0': [file('2026-09-01T00:00:00Z')],
            '4.10.0': [file('2026-10-01T00:00:00Z')],
            '4.11.0rc1': [file('2026-11-01T00:00:00Z')],
            '4.11.0.dev0': [file('2026-11-02T00:00:00Z')],
            '4.7.0': [file('2026-07-01T00:00:00Z', true)],
            '4.8.0': []
        }
    };

    test('offers final releases from the minimum on, with a file to install, newest first', () => {
        expect(choosableReleases(answer).map(r => r.version)).toEqual(['4.10.0', '4.9.0', '4.0.0']);
    });

    test('dates each by its first upload', () => {
        expect(choosableReleases(answer).at(-1)).toEqual({ version: '4.0.0', date: '2026-01-01' });
    });

    test('refuses an answer that lists nothing, rather than offering an empty list', () => {
        expect(() => choosableReleases({ message: 'Not Found' })).toThrow('PyPI did not list');
        expect(() => choosableReleases(null)).toThrow();
    });

    test('is asked of PyPI only', () => {
        expect(validateRequestUrl(PYPI_RELEASES_URL, 0, isPypiHost).hostname).toBe('pypi.org');
        expect(() => validateRequestUrl('https://pypi.org.evil.example/x', 0, isPypiHost)).toThrow('untrusted host');
        // The compiler's downloads keep their own list, which PyPI is not on.
        expect(() => validateRequestUrl(PYPI_RELEASES_URL, 0)).toThrow('untrusted host');
    });
});

describe('the release picker', () => {

    const releases = [{ version: '4.5.0', date: '2026-11-20' }, { version: '4.4.0', date: '2026-11-01' }, { version: '4.1.0' }];

    test('starts with no release in particular, then each, marked newest, installed and chosen', () => {
        const items = releaseItems(releases, { installed: '4.4.0', chosen: '4.4.0' });
        expect(items.map(i => [i.label, i.description])).toEqual([
            ['Any release', undefined],
            ['4.5.0', 'newest'],
            ['4.4.0', 'installed, chosen'],
            ['4.1.0', undefined]
        ]);
        expect(items[0].version).toBe('');
        expect(releaseItems(releases, {})[0].description).toBe('chosen');
    });

    test('says when each was published, and what the first to bring a feature brings', () => {
        const items = releaseItems(releases, {});
        expect(items[2].detail).toBe('Published 2026-11-01 · the first that runs steps together');
        expect(items[3].detail).toBe('the first that shows runs as they go');
    });
});

describe('a chosen release', () => {

    test('is installed exactly, and only when it is a final release from the minimum on', () => {
        expect(runnerRequirement('4.4.0', '4.5.0')).toBe('jpipe-runner==4.5.0');
        expect(runnerRequirement(undefined, '4.5.0')).toBe('jpipe-runner==4.5.0');
        for (const release of ['3.6.0', '4.5.0rc1', 'latest', '']) {
            expect(isChosenRelease(release), release).toBe(false);
            expect(runnerRequirement('4.4.0', release)).toBe('jpipe-runner==4.4.0');
        }
    });

    test('an environment with another release is to be given it before a run', () => {
        const status = environmentStatus({ python: VENV }, probe(), 'same', undefined, '4.5.0');
        expect(status).toEqual({ kind: 'other-release', python: VENV, installed: '4.4.0', wanted: '4.5.0' });
        expect(statusMessage(status)).toBe('This workspace\'s Python environment has jpipe-runner 4.4.0; the settings choose 4.5.0.');
        expect(fixLabel(status)).toBe('Install jpipe-runner 4.5.0');
        expect(fixConsequences(status)).toContain('in place of 4.4.0');
        expect(fixConsequences(status)).toContain('None of your project files is changed.');
        expect(runnablePython(status)).toBeUndefined();
    });

    test('in a managed project, the tool records it, and says which files it changes', () => {
        const status = environmentStatus({ python: VENV, manager: 'uv' }, probe(), 'same', undefined, '4.5.0');
        expect(fixLabel(status)).toBe('Switch to jpipe-runner 4.5.0 with uv');
        expect(fixConsequences(status)).toContain('uv will update pyproject.toml and uv.lock.');
        expect(addRunnerCommand('uv', 'jpipe-runner==4.5.0').args).toEqual(['add', '--dev', 'jpipe-runner==4.5.0']);
    });

    test('the release the environment has already, or no runner at all, is not a change of release', () => {
        expect(environmentStatus({ python: VENV }, probe({ runnerVersion: '4.5.0' }), 'same', undefined, '4.5.0').kind).toBe('ready');
        expect(environmentStatus({ python: VENV }, probe({ hasRunner: false, runnerVersion: undefined }), 'same', undefined, '4.5.0').kind).toBe('missing-runner');
    });

    test('is said in the report', () => {
        expect(environmentReport({ environment: { python: VENV }, probe: probe(), editorPython: null, release: '4.5.0' }).split('\n'))
            .toContain('Chosen release: 4.5.0');
    });
});

describe('a branch of a local jpipe-runner, in development mode', () => {

    const local = { path: CHECKOUT, branch: 'feat/x', head: HEAD };
    const fromBranch = (over: Partial<Probe> = {}) => probe({ runnerVersion: '4.6.0.dev0', localSource: CHECKOUT, localBranch: 'feat/x', localCommit: HEAD, ...over });

    test('is recognised from what pip records of an install from a git branch', () => {
        const answer = parseProbe(JSON.stringify({
            version: [3, 13, 0], runner: true, release: '4.6.0.dev0', local: pathToFileURL(CHECKOUT).href, branch: 'feat/x', commit: HEAD, venv: true
        }));
        expect(answer).toMatchObject({ localSource: CHECKOUT, localBranch: 'feat/x', localCommit: HEAD });
        // Only of a local install: a commit means nothing without one.
        expect(parseProbe(JSON.stringify({ version: [3, 13, 0], runner: true, local: null, branch: 'x', commit: HEAD, venv: true })))
            .not.toHaveProperty('localCommit');
    });

    test('installed at the commit the branch is at: ready', () => {
        expect(environmentStatus({ python: VENV }, fromBranch(), 'same', local).kind).toBe('ready');
    });

    test('installed from an older commit: to be installed again before a run, which would use the older code', () => {
        const status = environmentStatus({ python: VENV }, fromBranch({ localCommit: OLDER }), 'same', local);
        expect(status).toMatchObject({ kind: 'runner-source', wanted: CHECKOUT, branch: 'feat/x', behind: { installed: OLDER, head: HEAD } });
        expect(statusMessage(status)).toBe(
            'Branch feat/x of your local jpipe-runner has moved on to aaaaaaa, but this workspace\'s Python environment has it at bbbbbbb. Install it again to run the new commits.');
        expect(fixLabel(status)).toBe('Reinstall the Local jpipe-runner');
        expect(fixConsequences(status)).toContain('at its latest commit, aaaaaaa');
        expect(runnablePython(status)).toBeUndefined();
    });

    test('another branch, the working copy, or a release installed: install the branch', () => {
        for (const found of [fromBranch({ localBranch: 'main' }), probe({ localSource: CHECKOUT }), probe()]) {
            const status = environmentStatus({ python: VENV }, found, 'same', local);
            expect(status).toEqual({ kind: 'runner-source', python: VENV, wanted: CHECKOUT, branch: 'feat/x' });
            expect(fixConsequences(status)).toContain(`from branch feat/x of your local copy (${CHECKOUT})`);
            expect(runnablePython(status)).toBeUndefined();
        }
    });

    test('an install from a branch is not the working copy asked for without one', () => {
        expect(environmentStatus({ python: VENV }, fromBranch(), 'same', { path: CHECKOUT }).kind).toBe('runner-source');
    });

    test('out of development mode, an install from a branch is put back on a release', () => {
        expect(environmentStatus({ python: VENV }, fromBranch(), 'same')).toEqual({ kind: 'runner-source', python: VENV, installed: CHECKOUT });
    });

    test('is installed from its commits, never from the working copy\'s files', () => {
        const url = `git+${pathToFileURL(CHECKOUT).href}@feat/x`;
        expect(branchUrl(CHECKOUT, 'feat/x')).toBe(url);
        expect(createEnvironmentCommands({ program: 'python3', args: [] }, '/w', 'darwin', { local: CHECKOUT, branch: 'feat/x' })[1].args)
            .toEqual(['-m', 'pip', 'install', url]);
    });

    test('again, in two steps: pip stops at a version it has, however many commits came since', () => {
        expect(installLocalCommands(VENV, { local: CHECKOUT, branch: 'feat/x' }, 'Reinstall').map(step => [step.name, step.args])).toEqual([
            ['Reinstall the local jpipe-runner', ['-m', 'pip', 'install', '--force-reinstall', '--no-deps', `git+${pathToFileURL(CHECKOUT).href}@feat/x`]],
            ['Install its dependencies', ['-m', 'pip', 'install', `git+${pathToFileURL(CHECKOUT).href}@feat/x`]]
        ]);
        // The working copy, editable, is installed again in one.
        expect(installLocalCommands(VENV, { local: CHECKOUT }).map(step => step.args)).toEqual([['-m', 'pip', 'install', '-e', CHECKOUT]]);
    });

    test('is found with git, as a local branch only', () => {
        expect(branchHeadCommand(CHECKOUT, 'feat/x').args).toEqual(['-C', CHECKOUT, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/x^{commit}']);
        expect(parseCommit(`${HEAD}\n`)).toBe(HEAD);
        expect(parseCommit('')).toBeUndefined();
        expect(parseCommit('fatal: not a git repository')).toBeUndefined();
    });

    test('a branch the folder does not have, or no folder at all, is said plainly, with no fix to offer', () => {
        const noBranch = { kind: 'no-local-source', path: CHECKOUT, branch: 'feat/x' } as const;
        expect(statusMessage(noBranch)).toBe(`jPipe could not find branch feat/x in the local jpipe-runner named in the settings (${CHECKOUT}). Is it a branch of that folder, and is git installed?`);
        expect(statusMessage({ kind: 'no-local-source', path: '' })).toBe('Development mode is on, but no folder of jpipe-runner is set in the settings.');
        expect(fixLabel(noBranch)).toBeUndefined();
    });

    test('is named in the report with its branch and commit', () => {
        const report = environmentReport({ environment: { python: VENV }, probe: fromBranch(), editorPython: null }).split('\n');
        expect(report).toContain('jpipe-runner: 4.6.0.dev0 (branch feat/x at aaaaaaa)');
    });
});

describe('the Run panel names a development runner', () => {

    test('with its version, where it is, and which code of it runs', () => {
        expect(developmentRunnerLabel({ localSource: '/src/jpipe-runner', localBranch: 'feat/x', localCommit: HEAD, runnerVersion: '4.6.0.dev0' }))
            .toBe('Development jpipe-runner 4.6.0.dev0 · /src/jpipe-runner · branch feat/x at aaaaaaa');
        expect(developmentRunnerLabel({ localSource: '/src/jpipe-runner' })).toBe('Development jpipe-runner · /src/jpipe-runner · working copy');
    });

    test('and nothing for a release', () => {
        expect(developmentRunnerLabel({ runnerVersion: '4.5.0' })).toBeUndefined();
    });
});
