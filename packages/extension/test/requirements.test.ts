import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCompilerVersion } from '../src/extension/compiler/compiler-invocation.js';
import {
    compilerLine,
    compilerTooOldMessage,
    compilerUpdate,
    compilerVerdict,
    CompilerTooOldError,
    formatRelease,
    installationSummary,
    meetsMinimum,
    PYLANCE_EXTENSION,
    pylanceLine,
    RECOMMENDED,
    releaseNumbers,
    REQUIREMENTS,
    RUNNER_FEATURES,
    runnerHas,
    runnerMayLack,
    type InstallationFacts
} from '../src/extension/requirements.js';

describe('meetsMinimum', () => {
    test('compares release numbers, most significant first', () => {
        expect(meetsMinimum([3, 0, 0], [3, 0, 0])).toBe(true);
        expect(meetsMinimum([3, 0, 1], [3, 0, 0])).toBe(true);
        expect(meetsMinimum([4, 0, 0], [3, 9, 9])).toBe(true);
        expect(meetsMinimum([2, 99, 99], [3, 0, 0])).toBe(false);
        expect(meetsMinimum([3, 0, 0], [3, 0, 1])).toBe(false);
    });

    test('a missing number counts as 0, on either side', () => {
        expect(meetsMinimum([3, 11], [3, 11, 0])).toBe(true);
        expect(meetsMinimum([3, 12, 1], [3, 11])).toBe(true);
        expect(meetsMinimum([3, 10, 9], [3, 11])).toBe(false);
    });
});

describe('compilerVerdict', () => {
    const at = (output: string) => compilerVerdict(parseCompilerVersion(output));
    const minimum = formatRelease(REQUIREMENTS.compiler);

    test('the required compiler and anything newer is supported', () => {
        expect(at(`jPipe ${minimum}`)).toEqual({ kind: 'supported', version: minimum });
        expect(at('jPipe 99.0.0').kind).toBe('supported');
    });

    test('anything older is too old, and says which it is', () => {
        expect(at('jPipe 2.5.0')).toEqual({ kind: 'too-old', version: '2.5.0' });
        expect(at('jPipe 1.9.9').kind).toBe('too-old');
    });

    test('a prerelease of the required compiler counts as that compiler', () => {
        // Semver orders `3.0.0-SNAPSHOT` below `3.0.0`, which is right for "which is newer" and
        // wrong here: it would refuse every development build of the release that is required.
        expect(at(`jPipe ${minimum}-SNAPSHOT`)).toEqual({ kind: 'supported', version: `${minimum}-SNAPSHOT` });
        expect(at(`jPipe ${minimum}-rc1`).kind).toBe('supported');
    });

    test('a prerelease of an older release is still too old', () => {
        expect(at('jPipe 2.5.0-SNAPSHOT')).toEqual({ kind: 'too-old', version: '2.5.0-SNAPSHOT' });
    });

    test('a compiler that says no version is let through, not refused', () => {
        // The run then works or reports the real problem; refusing would block a working
        // compiler whose banner merely changed.
        expect(compilerVerdict(undefined)).toEqual({ kind: 'unknown' });
        expect(at('command not found')).toEqual({ kind: 'unknown' });
    });
});

describe('what a user is told about the compiler', () => {
    const minimum = formatRelease(REQUIREMENTS.compiler);

    test('the refusal names the version found and the version needed', () => {
        expect(compilerTooOldMessage('2.5.0')).toBe(
            `jPipe compiler 2.5.0 is too old for this version of the extension, which needs ${minimum} or newer.`);
        expect(compilerTooOldMessage(undefined)).toMatch(/^This jPipe compiler is too old/);
    });

    test('the refusal is an error a caller can recognise', () => {
        const error = new CompilerTooOldError('2.5.0');
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(compilerTooOldMessage('2.5.0'));
        expect(error.version).toBe('2.5.0');
    });

    test('the managed mode updates the compiler itself; the others are sent to the guide', () => {
        expect(compilerUpdate('managed').kind).toBe('install');
        expect(compilerUpdate('cli').kind).toBe('guide');
        expect(compilerUpdate('jar').kind).toBe('guide');
    });

    test('the report line says the version, and what is needed when it is not enough', () => {
        expect(compilerLine({ kind: 'supported', version: '4.0.0' })).toBe('Compiler: 4.0.0');
        expect(compilerLine({ kind: 'too-old', version: '2.5.0' })).toBe(`Compiler: 2.5.0, too old (needs ${minimum} or newer)`);
        expect(compilerLine({ kind: 'unknown' })).toContain(`needs ${minimum} or newer`);
    });
});

describe('installationSummary', () => {
    const ready: InstallationFacts = { compiler: 'ready', runner: 'ready', pylance: true };

    test('a compiler that cannot be reached is an error, with nothing to press', () => {
        expect(installationSummary({ ...ready, compiler: 'unreachable' })).toEqual({
            severity: 'error', title: 'Cannot access the jPipe compiler.'
        });
    });

    test('a compiler too old is an error whose fix is the compiler, whatever else is wrong', () => {
        const summary = installationSummary({ compiler: 'too-old', runner: 'needs-setup', pylance: false });
        expect(summary.severity).toBe('error');
        expect(summary.action).toBe('compiler');
    });

    test('a workspace that cannot run is a warning whose fix is the environment', () => {
        const summary = installationSummary({ ...ready, runner: 'needs-setup', pylance: false });
        expect(summary).toMatchObject({ severity: 'warning', action: 'runner' });
    });

    test('Pylance missing is offered, not warned about', () => {
        expect(installationSummary({ ...ready, pylance: false })).toMatchObject({ severity: 'info', action: 'pylance' });
        expect(installationSummary({ ...ready, runner: 'external', pylance: false })).toMatchObject({ action: 'pylance' });
    });

    test('a workspace with no step library is not told about runs or Pylance', () => {
        // A model-only user has no reason to install Python tooling.
        expect(installationSummary({ compiler: 'ready', runner: 'none', pylance: false }))
            .toEqual({ severity: 'info', title: 'jPipe is ready.' });
    });

    test('all present: ready, nothing to press', () => {
        expect(installationSummary(ready)).toEqual({ severity: 'info', title: 'jPipe is ready and can run models.' });
    });
});

describe('pylanceLine', () => {
    test('a missing Pylance may be a disabled one, and the line does not pretend to know which', () => {
        // The editor reports a disabled extension as absent.
        expect(pylanceLine(true)).toBe('Pylance: installed');
        expect(pylanceLine(false)).toBe('Pylance: not installed, or disabled');
    });
});

describe('Pylance stays a soft dependency', () => {
    // Declaring it would stop jPipe from activating in any editor without it, which is every
    // build of VS Code that is not Microsoft's (jpipe-vscode ADR-VSC-0032).
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as Record<string, unknown>;

    test('it is neither an extension dependency nor part of an extension pack', () => {
        for (const key of ['extensionDependencies', 'extensionPack']) {
            expect((manifest[key] as string[] | undefined) ?? []).not.toContain(PYLANCE_EXTENSION);
        }
    });
});

describe('the release numbers a version starts with', () => {
    test.each([
        ['4.1.0', [4, 1, 0]],
        ['4.1.0.dev0', [4, 1, 0]],
        ['5.0.0rc1', [5, 0, 0]],
        ['4', [4]],
        ['installed', undefined],
        ['', undefined],
        [undefined, undefined]
    ])('%s → %j', (version, numbers) => {
        expect(releaseNumbers(version)).toEqual(numbers);
    });

    test('the recommended jpipe-runner is no older than the one required', () => {
        expect(meetsMinimum(RECOMMENDED.runner, REQUIREMENTS.runner)).toBe(true);
    });

    // The oldest release that has everything this release uses: the newest feature's.
    test('the recommended jpipe-runner is the one that brought the newest feature used', () => {
        const releases = Object.values(RUNNER_FEATURES).map(feature => feature.since);
        const newest = releases.reduce((a, b) => (meetsMinimum(a, b) ? a : b));
        expect(RECOMMENDED.runner).toEqual(newest);
        for (const since of releases) expect(meetsMinimum(since, REQUIREMENTS.runner)).toBe(true);
    });

    test('a jpipe-runner has a feature from the release that brought it, its development builds included', () => {
        expect(runnerHas('4.1.0', 'events')).toBe(true);
        expect(runnerHas('4.1.0.dev0', 'events')).toBe(true);
        expect(runnerHas('4.0.3', 'events')).toBe(false);
        expect(runnerHas('4.3.0', 'jobs')).toBe(false);
        expect(runnerHas('4.4.0.dev0', 'jobs')).toBe(true);
        expect(runnerHas('5.0.0rc1', 'jobs')).toBe(true);
        expect(runnerHas(undefined, 'events')).toBe(false);
        expect(runnerHas('installed', 'jobs')).toBe(false);
    });

    // What tells a refused option from the user's own usage error, which is not launched again.
    test('only a pre-release of the release that brought a feature may lack it', () => {
        for (const version of ['4.4.0.dev0', '4.4.0rc1', '4.4.dev3']) expect(runnerMayLack(version, 'jobs'), version).toBe(true);
        for (const version of ['4.4.0', '4.4', '4.4.0.post1', '4.4.0.post1.dev0', '4.4.0+local', '4.4.1.dev0', '4.5.0', '4.3.0.dev0', 'installed', undefined]) {
            expect(runnerMayLack(version, 'jobs'), String(version)).toBe(false);
        }
        expect(runnerMayLack('4.1.0.dev0', 'events')).toBe(true);
        expect(runnerMayLack('4.4.0.dev0', 'events')).toBe(false);
        expect(runnerMayLack('4.1.0.post1', 'events')).toBe(false);
        expect(runnerMayLack('4.4.0a1', 'jobs')).toBe(true);
        expect(runnerMayLack('4.4.0b2', 'jobs')).toBe(true);
    });
});

describe('the Marketplace page states the same requirements', () => {
    // Users read the minimums there before installing; a raised minimum must not leave it behind.
    const readme = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');

    test('the compiler, jpipe-runner and Python minimums are the ones the code enforces', () => {
        expect(readme).toContain(`version ${formatRelease(REQUIREMENTS.compiler)} or newer`);
        expect(readme).toContain(`${formatRelease(REQUIREMENTS.runner)} or newer`);
        expect(readme).toContain(`Python ${formatRelease(REQUIREMENTS.python)} or`);
    });

    test('so is the recommended jpipe-runner, which follows a run as it goes', () => {
        expect(readme).toContain(`jpipe-runner ${formatRelease(RECOMMENDED.runner)} or newer, the recommended release`);
    });
});
