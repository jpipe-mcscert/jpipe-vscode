import { describe, expect, test } from 'vitest';
import { parseReport, type RunReport } from '../src/extension/runner/run-report.js';
import {
    clockTime, elementLocation, outOfDateReason, panelState, startedRun, type ShownRun
} from '../src/extension/runner/run-state.js';

/**
 * What the run panel is told about the last run, and when that run stops saying what a run would
 * now (jpipe-vscode ADR-VSC-0031). The panel and its page are checked by hand; these are the
 * decisions behind them.
 */

const report = (over: Record<string, unknown>): RunReport => {
    const parsed = parseReport(JSON.stringify({
        schema_version: '1.0', justification: 'release', verdict: 'pass', elements: [], diagnostics: [],
        diagram: null, dataflow: null, ...over
    }));
    if ('problem' in parsed) throw new Error(parsed.problem);
    return parsed.report;
};

const LIBRARIES = [{ path: '/w/steps.py', display: 'steps.py' }];

const done = (over: Partial<ShownRun> = {}): ShownRun => ({
    ...startedRun('release', 'file:///w/release.jd', false, LIBRARIES, undefined),
    phase: 'done',
    report: report({ elements: [{ id: 'release:e', status: 'pass' }, { id: 'release:c', status: 'pass' }] }),
    diagrams: { dataflow: '<svg>dataflow</svg>', argument: '<svg>argument</svg>' },
    endedAt: new Date(2026, 10, 15, 14, 2),
    ...over
});

describe('a run starting', () => {

    test('is under way, with nothing to say yet', () => {
        const run = startedRun('release', 'file:///w/release.jd', true, LIBRARIES, undefined);
        expect(run).toMatchObject({ phase: 'running', check: true, report: null, notice: null, outOfDate: null });
        expect(run.diagrams).toEqual({ dataflow: null, argument: null });
    });

    test('keeps the drawing of the same justification under it, and drops another\'s', () => {
        const previous = done();
        expect(startedRun('release', 'file:///w/release.jd', false, LIBRARIES, previous).diagrams).toBe(previous.diagrams);
        expect(startedRun('other', 'file:///w/release.jd', false, LIBRARIES, previous).diagrams).toEqual({ dataflow: null, argument: null });
        // Names are unique only within a file.
        expect(startedRun('release', 'file:///w/elsewhere.jd', false, LIBRARIES, previous).diagrams).toEqual({ dataflow: null, argument: null });
    });
});

describe('the page\'s state', () => {

    test('carries the verdict, its counts as links, when, and the libraries loaded', () => {
        const state = panelState(done(), 7);
        expect(state).toMatchObject({ revision: 7, name: 'release', check: false, phase: 'done', outOfDate: null });
        expect(state.verdict).toEqual({
            label: 'release passed', tone: 'pass',
            counts: [{ text: '2 passed', row: 'group/Passed' }],
            when: 'run · 14:02', libraries: ['steps.py']
        });
        expect(state.elements).toEqual(['release:e', 'release:c']);
        expect(state.diagrams.dataflow).toBe('<svg>dataflow</svg>');
    });

    test('says a check is a check', () => {
        const state = panelState(done({ check: true, report: report({ verdict: 'valid', elements: [{ id: 'e', status: null }] }) }), 1);
        expect(state.verdict).toMatchObject({ label: 'release is valid', tone: 'valid', when: 'check · 14:02' });
    });

    test('has no verdict while the run is under way, or when it ended without a report', () => {
        const running = startedRun('release', 'file:///w/release.jd', false, LIBRARIES, undefined);
        expect(panelState(running, 1)).toMatchObject({ verdict: null, elements: [], phase: 'running' });
        const notice = { text: 'No step library is checked.', action: { label: 'Show Libraries', id: 'showLibraries' as const } };
        expect(panelState({ ...running, phase: 'blocked', notice }, 2)).toMatchObject({ verdict: null, notice });
    });

    test('a run with no end time says only what it was', () => {
        expect(panelState(done({ endedAt: null }), 1).verdict?.when).toBe('run');
    });

    test('times are hours and minutes', () => {
        expect(clockTime(new Date(2026, 0, 1, 9, 5))).toBe('09:05');
    });
});

describe('going out of date', () => {
    const saved = (path: string, isModel: boolean) => ({ kind: 'saved' as const, path, display: path.split('/').pop()!, isModel });

    test('a saved jPipe file may be one the model loads, so any of them counts', () => {
        expect(outOfDateReason(done(), saved('/w/other.jd', true))).toBe('other.jd changed since this run.');
        expect(outOfDateReason(done({ check: true }), saved('/w/release.jd', true))).toBe('release.jd changed since this check.');
    });

    test('a saved library counts when the run loaded it', () => {
        expect(outOfDateReason(done(), saved('/w/steps.py', false))).toBe('steps.py changed since this run.');
        expect(outOfDateReason(done(), saved('/w/helper.py', false))).toBeUndefined();
    });

    test('the libraries checked count when they are no longer the ones the run loaded', () => {
        expect(outOfDateReason(done(), { kind: 'checked', paths: ['/w/steps.py'] })).toBeUndefined();
        expect(outOfDateReason(done(), { kind: 'checked', paths: ['/w/steps.py', '/w/more.py'] }))
            .toBe('The libraries checked are not the ones this run loaded.');
        expect(outOfDateReason(done(), { kind: 'checked', paths: [] })).toBeDefined();
        expect(outOfDateReason(done(), { kind: 'checked', paths: ['/w/more.py'] })).toBeDefined();
    });

    test('only a run that ended can be out of date', () => {
        const running = startedRun('release', 'file:///w/release.jd', false, LIBRARIES, undefined);
        expect(outOfDateReason(running, saved('/w/release.jd', true))).toBeUndefined();
        expect(outOfDateReason({ ...running, phase: 'blocked' }, saved('/w/release.jd', true))).toBeUndefined();
    });
});

describe('where an element is declared', () => {

    test.each([
        ['release:c', 'release', 'c'],
        ['readiness:draft:changelog', 'draft', 'changelog'],
        ['c', null, 'c']
    ])('%s is %s, in %s', (id, model, element) => {
        expect(elementLocation(id)).toEqual({ model, element });
    });
});
