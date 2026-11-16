import { describe, expect, test } from 'vitest';
import { parseReport, type RunReport } from '../src/extension/runner/run-report.js';
import {
    clockTime, elementCandidates, kindOf, outOfDateReason, panelState, startedRun, statusRow, underWay, type ShownRun
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
    dataflow: '<svg>dataflow</svg>',
    endedAt: new Date(2026, 10, 15, 14, 2),
    ...over
});

describe('a run starting', () => {

    test('is under way, with nothing to say yet', () => {
        const run = startedRun('release', 'file:///w/release.jd', true, LIBRARIES, undefined);
        expect(run).toMatchObject({ phase: 'running', check: true, report: null, notice: null, outOfDate: null, dataflow: null });
    });

    test('keeps the drawing of the same justification under it, and drops another\'s', () => {
        const previous = done();
        expect(startedRun('release', 'file:///w/release.jd', false, LIBRARIES, previous).dataflow).toBe(previous.dataflow);
        expect(startedRun('other', 'file:///w/release.jd', false, LIBRARIES, previous).dataflow).toBeNull();
        // Names are unique only within a file.
        expect(startedRun('release', 'file:///w/elsewhere.jd', false, LIBRARIES, previous).dataflow).toBeNull();
    });
});

describe('the page\'s state', () => {

    test('carries what was done, the verdict, its counts as links, when, and the libraries loaded', () => {
        const state = panelState(done(), 7);
        expect(state).toMatchObject({ revision: 7, name: 'release', check: false, phase: 'done', outOfDate: null });
        expect(state.verdict).toEqual({
            kind: 'execution', label: 'release passed', tone: 'pass',
            counts: [{ text: '2 passed', row: 'group/Passed' }],
            at: '14:02', libraries: ['steps.py']
        });
        expect(state.elements).toEqual(['release:e', 'release:c']);
        expect(state.dataflow).toBe('<svg>dataflow</svg>');
    });

    test('says a check is a check, never an execution that passed', () => {
        const state = panelState(done({ check: true, report: report({ verdict: 'valid', elements: [{ id: 'e', status: null }] }) }), 1);
        expect(state.verdict).toMatchObject({ kind: 'check', label: 'release is valid', tone: 'valid' });
        expect(kindOf(true)).toBe('check');
        expect(kindOf(false)).toBe('execution');
    });

    test('has no verdict while the run is under way, or when it ended without a report', () => {
        const running = startedRun('release', 'file:///w/release.jd', false, LIBRARIES, undefined);
        expect(panelState(running, 1)).toMatchObject({ verdict: null, elements: [], phase: 'running' });
        const notice = { text: 'No step library is checked.', action: { label: 'Show Libraries', id: 'showLibraries' as const } };
        expect(panelState({ ...running, phase: 'blocked', notice }, 2)).toMatchObject({ verdict: null, notice });
    });

    test('a run with no end time has no time', () => {
        expect(panelState(done({ endedAt: null }), 1).verdict?.at).toBeNull();
    });

    test('times are hours and minutes', () => {
        expect(clockTime(new Date(2026, 0, 1, 9, 5))).toBe('09:05');
    });
});

describe('going out of date', () => {
    const saved = (path: string, isModel: boolean) => ({ kind: 'saved' as const, path, display: path.split('/').pop()!, isModel });

    test('a saved jPipe file may be one the model loads, so any of them counts', () => {
        expect(outOfDateReason(done(), saved('/w/other.jd', true))).toBe('other.jd changed since this execution.');
        expect(outOfDateReason(done({ check: true }), saved('/w/release.jd', true))).toBe('release.jd changed since this check.');
    });

    test('a saved library counts when the run loaded it', () => {
        expect(outOfDateReason(done(), saved('/w/steps.py', false))).toBe('steps.py changed since this execution.');
        expect(outOfDateReason(done(), saved('/w/helper.py', false))).toBeUndefined();
    });

    test('the libraries checked count when they are no longer the ones the run loaded', () => {
        expect(outOfDateReason(done(), { kind: 'checked', paths: ['/w/steps.py'] })).toBeUndefined();
        expect(outOfDateReason(done(), { kind: 'checked', paths: ['/w/steps.py', '/w/more.py'] }))
            .toBe('The libraries checked are not the ones this execution loaded.');
        expect(outOfDateReason(done(), { kind: 'checked', paths: [] })).toBeDefined();
        expect(outOfDateReason(done(), { kind: 'checked', paths: ['/w/more.py'] })).toBeDefined();
    });

    test('a change made while the run is under way counts: it is not what the run read', () => {
        const running = startedRun('release', 'file:///w/release.jd', false, LIBRARIES, undefined);
        expect(outOfDateReason(running, saved('/w/release.jd', true))).toBe('release.jd changed since this execution.');
        expect(outOfDateReason(running, { kind: 'checked', paths: [] })).toBeDefined();
    });

    test('a run that ended without a report has nothing to be out of date', () => {
        const running = startedRun('release', 'file:///w/release.jd', false, LIBRARIES, undefined);
        expect(outOfDateReason({ ...running, phase: 'blocked' }, saved('/w/release.jd', true))).toBeUndefined();
        expect(outOfDateReason({ ...running, phase: 'stopped' }, saved('/w/release.jd', true))).toBeUndefined();
    });
});

describe('what Results lists while a run has no report', () => {
    const running = startedRun('release', 'file:///w/release.jd', false, LIBRARIES, undefined);

    test('a run under way, as one row', () => {
        expect(statusRow(running)).toMatchObject({ id: 'status', label: 'Executing release…', icon: 'running' });
        expect(statusRow({ ...running, check: true })?.label).toBe('Checking release…');
        expect(underWay('x', true)).toBe('Checking x…');
    });

    test('why it ended without one', () => {
        const notice = { text: 'No step library is checked.', action: null };
        expect(statusRow({ ...running, phase: 'blocked', notice })).toMatchObject({ label: 'No step library is checked.', icon: 'error' });
        expect(statusRow({ ...running, phase: 'stopped', notice })).toMatchObject({ icon: 'stopped' });
    });

    test('nothing, once there is a report to list', () => {
        expect(statusRow(done())).toBeUndefined();
        expect(statusRow(done({ notice: { text: 'release is no longer in release.jd', action: null } }))).toBeUndefined();
    });
});

describe('where to look for an element of the report', () => {

    test('an element of the justification shown is looked for in it, under the rest of its id', () => {
        expect(elementCandidates('release:c', 'release')).toEqual([{ model: 'release', element: 'c' }]);
    });

    test('an inherited element is looked for in the justification first, then in its template', () => {
        expect(elementCandidates('release:T:slot', 'release')).toEqual([
            { model: 'release', element: 'T:slot' },
            { model: 'T', element: 'slot' }
        ]);
    });

    test('an element of a composition\'s operand is looked for in that operand', () => {
        expect(elementCandidates('readiness:draft:changelog', 'readiness')).toEqual([
            { model: 'readiness', element: 'draft:changelog' },
            { model: 'draft', element: 'changelog' }
        ]);
    });

    test('an id with no model in it, or another justification\'s, has only what it names', () => {
        expect(elementCandidates('c', 'release')).toEqual([]);
        expect(elementCandidates('other:c', 'release')).toEqual([{ model: 'other', element: 'c' }]);
    });
});
