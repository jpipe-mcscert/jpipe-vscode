import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { bindSteps, designates, stepNote, type LibraryStep } from '../src/extension/runner/step-binding.js';
import { DEFAULT_RUNNER, cannotRun, resolveRunner, runnerArguments } from '../src/extension/runner/runner-invocation.js';

/**
 * Preparing a run: which step implements which element, and how the runner is launched.
 *
 * The binding cases are jpipe-runner's own, from the "Binding" section of its authoring guide, so
 * the Outline agrees with what a run will do.
 */

const step = (ids: string[], functionName: string, kind: LibraryStep['kind'] = 'evidence'): LibraryStep =>
    ({ kind, ids, functionName, libraryUri: 'file:///w/steps.py', line: 0 });

describe('an id designates an element', () => {

    // The guide's table, for an element `rigor:r17:e_metric`.
    const ids = ['rigor:r17:e_metric'];
    test.each([
        ['rigor:r17:e_metric', 'rigor:r17:e_metric'],   // exact
        ['r17:e_metric', 'rigor:r17:e_metric'],         // a tail, cut at `:`
        ['e_metric', 'rigor:r17:e_metric'],
        ['metric', undefined],                          // part of a segment
        ['r17', undefined]                              // not a tail
    ])('%s → %s', (stepId, expected) => {
        expect(designates(stepId, 'rigor', ids)).toBe(expected);
    });

    test('an exact match wins over a tail', () => {
        expect(designates('e_metric', 'j', ['e_metric', 'j:x:e_metric'])).toBe('e_metric');
    });

    test('a tail shared by two elements designates neither', () => {
        expect(designates('e', 'j', ['j:a:e', 'j:b:e'])).toBeUndefined();
    });

    test('a qualified id names the justification, then the element', () => {
        expect(designates('release:release:e1', 'release', ['release:e1'])).toBe('release:e1');
    });
});

describe('binding a model\'s elements', () => {

    test('each element gets the steps that designate it, by its id in the model', () => {
        const bound = bindSteps('release', ['e1', 'e2', 's'], [
            step(['release:e1'], 'tests_pass'),
            step(['e2'], 'changelog_ok'),
            step(['release:s'], 'gates', 'strategy'),
            step(['other:e9'], 'elsewhere')
        ]);
        expect(bound.get('e1')!.map(s => s.functionName)).toEqual(['tests_pass']);
        expect(bound.get('e2')!.map(s => s.functionName)).toEqual(['changelog_ok']);
        expect(bound.get('s')!.map(s => s.functionName)).toEqual(['gates']);
        expect(bound.size).toBe(3);
    });

    test('an element implemented twice keeps both steps, as the runner will report', () => {
        const bound = bindSteps('j', ['e'], [step(['j:e'], 'one'), step(['e'], 'two')]);
        expect(bound.get('e')!.map(s => s.functionName)).toEqual(['one', 'two']);
    });

    test('a step\'s aliases for one element bind it once', () => {
        const bound = bindSteps('j', ['e'], [step(['j:e', 'e'], 'one')]);
        expect(bound.get('e')).toHaveLength(1);
    });

    test('an override of a template\'s @support binds through its qualified id', () => {
        const bound = bindSteps('release', ['Signoff:review'], [step(['review'], 'reviewed')]);
        expect(bound.get('Signoff:review')!.map(s => s.functionName)).toEqual(['reviewed']);
    });
});

describe('what an Outline row says', () => {

    test.each([
        ['nothing before any library is checked', 'evidence', undefined, false, undefined],
        ['the function implementing it', 'evidence', [step(['e'], 'tests_pass')], true, 'tests_pass()'],
        ['that two steps claim it', 'evidence', [step(['e'], 'a'), step(['e'], 'b')], true, '2 steps'],
        ['that a required element has no step', 'strategy', undefined, true, 'no step'],
        ['nothing for an optional element without one', 'conclusion', undefined, true, undefined],
        ['nothing for an @support, which is never run', 'support', undefined, true, undefined]
    ])('%s', (_case, kind, steps, checked, note) => {
        expect(stepNote(kind as string, steps as LibraryStep[] | undefined, checked as boolean)).toBe(note);
    });
});

describe('launching the runner', () => {

    const base = { configured: '', folder: '/w', platform: 'darwin' as NodeJS.Platform, home: '/home/me' };

    test('a configured program wins, with ~ expanded', () => {
        expect(resolveRunner({ ...base, configured: '~/bin/jpipe-runner', exists: () => true }))
            .toBe(path.join('/home/me', 'bin', 'jpipe-runner'));
    });

    test('then the workspace\'s .venv, then its venv', () => {
        const venv = path.join('/w', 'venv', 'bin', 'jpipe-runner');
        expect(resolveRunner({ ...base, exists: f => f === venv })).toBe(venv);
        const dotVenv = path.join('/w', '.venv', 'bin', 'jpipe-runner');
        expect(resolveRunner({ ...base, exists: f => f === dotVenv || f === venv })).toBe(dotVenv);
    });

    test('a Windows virtual environment keeps its programs in Scripts', () => {
        const exe = path.join('C:\\w', '.venv', 'Scripts', 'jpipe-runner.exe');
        expect(resolveRunner({ ...base, folder: 'C:\\w', platform: 'win32', exists: f => f === exe })).toBe(exe);
    });

    test('and finally jpipe-runner from PATH', () => {
        expect(resolveRunner({ ...base, exists: () => false })).toBe(DEFAULT_RUNNER);
        expect(resolveRunner({ ...base, folder: undefined, exists: () => true })).toBe(DEFAULT_RUNNER);
    });

    test('one --library per library, then the compiled justification', () => {
        expect(runnerArguments(['/w/a.py', '/w/b.py'], '/tmp/release.json'))
            .toEqual(['-l', '/w/a.py', '-l', '/w/b.py', '/tmp/release.json']);
    });

    test('a template cannot be run', () => {
        expect(cannotRun('template', 'Signoff')).toContain('abstract');
        expect(cannotRun('justification', 'Release')).toBeUndefined();
        expect(cannotRun(undefined, 'Release')).toBeUndefined();
    });
});
