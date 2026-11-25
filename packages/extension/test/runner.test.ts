import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { bindSteps, designates, stepLabel, stepNote, type LibraryStep } from '../src/extension/runner/step-binding.js';
import {
    DEFAULT_RUNNER, cannotRun, dataflowFlag, jobsArguments, readJobs, relaunchWithout, resolveRunner, runnerArguments, runsJobs, streamsEvents
} from '../src/extension/runner/runner-invocation.js';
import manifest from '../package.json' with { type: 'json' };

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

    test('a step reads as the function the runner will call', () => {
        expect(stepLabel(step(['e'], 'tests_pass'))).toBe('tests_pass()');
        expect(stepLabel({ kind: 'evidence', ids: ['e'], libraryUri: 'file:///w/steps.py', line: 0 })).toBe('step');
    });

    test('an inherited element is reached by a step written for its own id', () => {
        const bound = bindSteps('release', ['e1', 'lib:Signoff:s'], [step(['s'], 'sign', 'strategy')]);
        expect(bound.get('lib:Signoff:s')!.map(s => s.functionName)).toEqual(['sign']);
    });

    test.each([
        ['nothing before any library is checked', 'evidence', undefined, false, undefined],
        ['nothing when one step implements it, which is a row of its own', 'evidence', [step(['e'], 'tests_pass')], true, undefined],
        ['that two steps claim it', 'evidence', [step(['e'], 'a'), step(['e'], 'b')], true, '2 steps'],
        ['that a required element has no step', 'strategy', undefined, true, 'no step'],
        ['nothing for an optional element without one', 'conclusion', undefined, true, undefined],
        ['nothing for an @support, which is never run', 'support', undefined, true, undefined]
    ])('%s', (_case, kind, steps, checked, note) => {
        expect(stepNote(kind as string, steps as LibraryStep[] | undefined, checked as boolean)).toBe(note);
    });
});

describe('launching the runner', () => {

    test('a named program is used as written, with ~ expanded', () => {
        expect(resolveRunner('~/bin/jpipe-runner', '/home/me')).toBe(path.join('/home/me', 'bin', 'jpipe-runner'));
        expect(resolveRunner('  /opt/tools/jpipe-runner ', '/home/me')).toBe('/opt/tools/jpipe-runner');
    });

    test('with none named, it is jpipe-runner from PATH', () => {
        expect(resolveRunner('', '/home/me')).toBe(DEFAULT_RUNNER);
    });

    test('one --library per library, then the compiled justification', () => {
        expect(runnerArguments(['/w/a.py', '/w/b.py'], '/tmp/release.json'))
            .toEqual(['-l', '/w/a.py', '-l', '/w/b.py', '/tmp/release.json']);
    });

    test('jpipe-runner 4.0 draws the dataflow with --dataflow', () => {
        // Its --diagram draws the argument alone, without the files and values.
        expect(dataflowFlag('4.0.0')).toBe('--dataflow');
        expect(dataflowFlag('4.0.3')).toBe('--dataflow');
        expect(dataflowFlag('4.0.1rc1')).toBe('--dataflow');
    });

    test('the releases after it draw it with --diagram, and refuse --dataflow', () => {
        expect(dataflowFlag('4.1.0')).toBe('--diagram');
        expect(dataflowFlag('4.1.0.dev0')).toBe('--diagram');
        expect(dataflowFlag('5.0.0rc1')).toBe('--diagram');
    });

    test('a runner whose release is unknown is asked for --diagram, which every release accepts', () => {
        // On 4.0 that draws less; --dataflow on a later release would stop every run.
        expect(dataflowFlag(undefined)).toBe('--diagram');
        expect(dataflowFlag('')).toBe('--diagram');
        expect(dataflowFlag('installed')).toBe('--diagram');
    });

    test('4.1 and the releases after it stream their events, development builds included', () => {
        expect(streamsEvents('4.1.0')).toBe(true);
        expect(streamsEvents('4.1.0.dev0')).toBe(true);
        expect(streamsEvents('4.2.3')).toBe(true);
        expect(streamsEvents('5.0.0rc1')).toBe(true);
    });

    test('4.0 does not, and neither is a runner whose release is unknown asked: the option would stop it', () => {
        expect(streamsEvents('4.0.3')).toBe(false);
        expect(streamsEvents('3.6.0')).toBe(false);
        expect(streamsEvents(undefined)).toBe(false);
        expect(streamsEvents('')).toBe(false);
        expect(streamsEvents('installed')).toBe(false);
        expect(streamsEvents('4')).toBe(false);
    });

    const asked = (drew: boolean, streamed: boolean, jobs = false) => ({ drew, streamed, jobs });

    test('a runner that refuses --events is launched again without it: a 4.1 build from before the option', () => {
        expect(relaunchWithout(2, asked(true, true))).toBe('events');
        expect(relaunchWithout(2, asked(false, true))).toBe('events');
        // Not asked for the events, a usage error is the user's to read.
        expect(relaunchWithout(2, asked(true, false))).toBeUndefined();
    });

    // Only a 4.4 build is asked for --jobs, and every 4.4 build knows --events: what it refused is --jobs.
    test('a runner that refuses --jobs is launched again without it: a 4.4 build from before the option', () => {
        expect(relaunchWithout(2, asked(true, true, true))).toBe('jobs');
        expect(relaunchWithout(2, asked(false, false, true))).toBe('jobs');
        expect(relaunchWithout(4, asked(false, true, true))).toBeUndefined();
    });

    test('a runner that cannot draw is launched again without the drawing', () => {
        expect(relaunchWithout(4, asked(true, true))).toBe('drawing');
        expect(relaunchWithout(4, asked(true, true, true))).toBe('drawing');
        expect(relaunchWithout(4, asked(false, true))).toBeUndefined();
    });

    test('any other end is not launched again', () => {
        for (const code of [0, 1, 3, 42, undefined]) expect(relaunchWithout(code, asked(true, true, true))).toBeUndefined();
    });

    test('a template cannot be run', () => {
        expect(cannotRun('template', 'Signoff')).toContain('abstract');
        expect(cannotRun('justification', 'Release')).toBeUndefined();
        expect(cannotRun(undefined, 'Release')).toBeUndefined();
    });
});

describe('the jobs setting (#136)', () => {

    test('4.4 and the releases after it run several steps at once, development builds included', () => {
        for (const release of ['4.4.0', '4.4.0.dev0', '4.5.1', '5.0.0rc1']) expect(runsJobs(release), release).toBe(true);
    });

    test('older releases, and a runner whose release is unknown, are not asked: the option would stop them', () => {
        for (const release of ['4.3.0', '4.1.0', '4.0.3', '4', '', 'installed', undefined]) expect(runsJobs(release), String(release)).toBe(false);
    });

    test('a check calls no step, so it is not asked either', () => {
        expect(runsJobs('4.4.0', true)).toBe(false);
    });

    test('is auto unless it says otherwise', () => {
        expect(readJobs(undefined)).toEqual({ jobs: 'auto', invalid: false });
        expect(readJobs(null)).toEqual({ jobs: 'auto', invalid: false });
        expect(readJobs('auto')).toEqual({ jobs: 'auto', invalid: false });
    });

    test('is a whole number of at least 1, written as a number or as text', () => {
        expect(readJobs(4)).toEqual({ jobs: 4, invalid: false });
        expect(readJobs('4')).toEqual({ jobs: 4, invalid: false });
        expect(readJobs('12')).toEqual({ jobs: 12, invalid: false });
        expect(readJobs(1)).toEqual({ jobs: 1, invalid: false });
    });

    test('runs as auto when it is anything else, and says it is', () => {
        for (const value of [0, -2, 2.5, '0', '04', ' 4', 'two', '4 jobs', 'AUTO', '', true, {}]) {
            expect(readJobs(value), JSON.stringify(value)).toEqual({ jobs: 'auto', invalid: true });
        }
    });

    test('is accepted by the Settings editor exactly when it is read as written', () => {
        const property = manifest.contributes.configuration
            .flatMap(group => Object.entries(group.properties))
            .find(([id]) => id === 'jpipe.runner.jobs')![1] as { default: string; pattern: string };
        expect(property.default).toBe('auto');
        const pattern = new RegExp(property.pattern);
        for (const value of ['auto', '1', '4', '64', '0', '04', ' 4', '-1', '2.5', 'two', 'AUTO', '']) {
            expect(pattern.test(value), value).toBe(!readJobs(value).invalid);
        }
    });

    test('is passed to the runner as it is, auto counting the processors itself', () => {
        expect(jobsArguments('auto', 8)).toEqual({ args: ['--jobs', 'auto'] });
        expect(jobsArguments(1, 8)).toEqual({ args: ['--jobs', '1'] });
        expect(jobsArguments(8, 8)).toEqual({ args: ['--jobs', '8'] });
    });

    test('is lowered to the processors there are, saying from what', () => {
        expect(jobsArguments(32, 8)).toEqual({ args: ['--jobs', '8'], loweredFrom: 32 });
        expect(jobsArguments(2, 0)).toEqual({ args: ['--jobs', '1'], loweredFrom: 2 });
    });
});
