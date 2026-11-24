import { describe, expect, test } from 'vitest';
import { parseReport, type RunReport } from '../src/extension/runner/run-report.js';
import {
    clockTime, elementCandidates, endedWithout, outOfDateReason, panelState, progressOf, rowsWithoutReport, startedRun, statusRow,
    type ShownRun
} from '../src/extension/runner/run-state.js';
import { kindOf, underWay } from '../src/shared/run-kind.js';
import { RunEventReader, type RunProgress } from '../src/extension/runner/run-events.js';

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
    ...startedRun('release', 'file:///w/release.jd', false, LIBRARIES),
    phase: 'done',
    report: report({ elements: [{ id: 'release:e', status: 'pass' }, { id: 'release:c', status: 'pass' }] }),
    drawing: { kind: 'final', svg: '<svg>dataflow</svg>' },
    endedAt: new Date(2026, 10, 15, 14, 2),
    ...over
});

describe('a run starting', () => {

    test('is under way, with nothing to say yet', () => {
        const run = startedRun('release', 'file:///w/release.jd', true, LIBRARIES);
        expect(run).toMatchObject({ phase: 'running', check: true, report: null, notice: null, outOfDate: null, drawing: null });
    });

    test('starts from an empty panel: nothing of the previous run stays, not even its drawing', () => {
        const run = startedRun('release', 'file:///w/release.jd', false, LIBRARIES);
        expect(run).toMatchObject({ drawing: null, progress: null, report: null });
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
        expect(state.drawingMissing).toBeNull();
    });

    test('says a check is a check, never an execution that passed', () => {
        const state = panelState(done({ check: true, report: report({ verdict: 'valid', elements: [{ id: 'e', status: null }] }) }), 1);
        expect(state.verdict).toMatchObject({ kind: 'check', label: 'release is valid', tone: 'valid' });
        expect(kindOf(true)).toBe('check');
        expect(kindOf(false)).toBe('execution');
    });

    test('has no verdict while the run is under way, or when it ended without a report', () => {
        const running = startedRun('release', 'file:///w/release.jd', false, LIBRARIES);
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
        const running = startedRun('release', 'file:///w/release.jd', false, LIBRARIES);
        expect(outOfDateReason(running, saved('/w/release.jd', true))).toBe('release.jd changed since this execution.');
        expect(outOfDateReason(running, { kind: 'checked', paths: [] })).toBeDefined();
    });

    test('a run that ended without a report has nothing to be out of date', () => {
        const running = startedRun('release', 'file:///w/release.jd', false, LIBRARIES);
        expect(outOfDateReason({ ...running, phase: 'blocked' }, saved('/w/release.jd', true))).toBeUndefined();
        expect(outOfDateReason({ ...running, phase: 'stopped' }, saved('/w/release.jd', true))).toBeUndefined();
    });
});

describe('what Results lists while a run has no report', () => {
    const running = startedRun('release', 'file:///w/release.jd', false, LIBRARIES);

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

describe('a run under way whose events are read', () => {

    const reading = (...events: Record<string, unknown>[]): RunProgress => {
        const reader = new RunEventReader();
        events.forEach((event, seq) => reader.read(new TextEncoder().encode(`${JSON.stringify({ seq, elapsed_ms: 0, ...event })}\n`)));
        return reader.progress!;
    };
    const progress = reading(
        { event: 'run.started', schema_version: '1.0', elements: ['release:e1', 'release:e2', 'release:c'] },
        { event: 'element.decided', element: { id: 'release:e1', status: 'fail' }, diagnostics: [] },
        { event: 'element.started', id: 'release:e2' }
    );
    const running: ShownRun = { ...startedRun('release', 'file:///w/release.jd', false, LIBRARIES), progress };

    test('the verdict bar says how far it is, and which step runs', () => {
        expect(panelState(running, 3).progress).toEqual({
            decided: '1 of 3 decided', counts: [{ text: '1 failed', row: 'group/Failed' }], running: ['release:e2'],
            underway: ['release:e2'], pending: ['release:c']
        });
        // No drawing of its own yet: it is waited for under the busy overlay.
        expect(panelState(running, 3).colouring).toBeNull();
    });

    test('on its own drawing, the elements decided are sent to be coloured, with what the drawing needs', () => {
        const decided = reading(
            { event: 'run.started', schema_version: '1.0', elements: ['j:e1', 'j:e2', 'j:s'] },
            { event: 'element.decided', element: {
                id: 'j:e1', status: 'fail', reason: 'cannot read x', produced: {},
                artifacts: [{ path: 'x', declared: 'x', reachable: false }, { path: 'a/y', declared: 'a/*', reachable: true }]
            }, diagnostics: [] },
            { event: 'element.decided', element: { id: 'j:e2', status: 'skip', reason: 'later', produced: { ok: { value: true } } }, diagnostics: [] },
            { event: 'element.decided', element: { id: 'j:s', status: 'skip', blocked_by: ['j:e1'] }, diagnostics: [] });
        const live: ShownRun = { ...startedRun('j', 'file:///w/j.jd', false, LIBRARIES), progress: decided, drawing: { kind: 'live', svg: '<svg>own</svg>' } };
        expect(panelState(live, 1).colouring?.statuses).toEqual([
            { id: 'j:e1', status: 'fail', reason: 'cannot read x', rootCause: false, produced: [], unreachable: ['x'] },
            { id: 'j:e2', status: 'skip', reason: 'later', rootCause: true, produced: ['ok'], unreachable: [] },
            { id: 'j:s', status: 'skip', reason: null, rootCause: false, produced: [], unreachable: [] }
        ]);
        expect(panelState(live, 1).dataflow).toBe('<svg>own</svg>');
        // A drawing that is not the run's own is not coloured with what it decided.
        expect(panelState({ ...live, drawing: { kind: 'final', svg: '<svg>other</svg>' } }, 1).colouring).toBeNull();
    });

    test('the step running is named by its label, when the compiled model has one', () => {
        const labels = new Map([['release:e2', 'The changelog is up to date']]);
        expect(panelState({ ...running, labels }, 3).progress?.running).toEqual(['The changelog is up to date']);
        expect(rowsWithoutReport({ ...running, labels }).find(r => r.id === 'group/Running')!.children[0].label)
            .toBe('The changelog is up to date');
    });

    test('stopped, its own drawing keeps the colours of what it decided, and nothing runs or waits', () => {
        const notice = { text: 'release was stopped.', action: null };
        const stopped = endedWithout({ ...running, drawing: { kind: 'live', svg: '<svg>own</svg>' } }, 'stopped', notice, new Date(2026, 10, 21));
        expect(stopped).toMatchObject({ phase: 'stopped', notice, drawing: { kind: 'live', svg: '<svg>own</svg>' } });
        expect(panelState(stopped, 4).colouring).toMatchObject({ statuses: [{ id: 'release:e1', status: 'fail' }] });
        expect(panelState(stopped, 4).progress).toBeNull();
    });

    test('stopped before the runner drew it, it has no drawing, and nothing to colour', () => {
        const notice = { text: 'release could not start.', action: null };
        const stopped = endedWithout(running, 'blocked', notice, new Date());
        expect(stopped.drawing).toBeNull();
        expect(panelState(stopped, 4)).toMatchObject({ dataflow: null, colouring: null, progress: null });
    });

    test('its elements can be selected and opened from the drawing before the report, and after a stop', () => {
        expect(panelState(running, 3).elements).toEqual(['release:e1', 'release:e2', 'release:c']);
        const stopped = endedWithout(running, 'stopped', { text: 'release was stopped.', action: null }, new Date());
        expect(panelState(stopped, 4).elements).toEqual(['release:e1', 'release:e2', 'release:c']);
        // Once there is one, the report says which elements there are.
        expect(panelState({ ...done(), progress }, 5).elements).toEqual(['release:e', 'release:c']);
    });

    // With --jobs, from jpipe-runner 4.4, several steps run at once (#136).
    test('several steps running at once are each named, by their labels, in the order they started', () => {
        const two = reading(
            { event: 'run.started', schema_version: '1.0', elements: ['j:a', 'j:b', 'j:c'] },
            { event: 'element.started', id: 'j:b' }, { event: 'element.started', id: 'j:a' });
        expect(progressOf(two, new Map([['j:a', 'Tests pass']])).running).toEqual(['j:b', 'Tests pass']);
        expect(progressOf(reading({ event: 'run.started', schema_version: '1.0', elements: ['j:a'] })).running).toEqual([]);
    });

    test('none is running once the run is no longer under way', () => {
        const one = reading({ event: 'run.started', schema_version: '1.0', elements: ['j:a'] }, { event: 'element.started', id: 'j:a' });
        const stopped = endedWithout({ ...running, progress: one }, 'stopped', { text: 'stopped', action: null }, new Date());
        expect(panelState(stopped, 4).progress).toBeNull();
    });

    test('ended with no drawing, says why', () => {
        const ended = done({ drawing: { kind: 'missing', reason: 'Drawing needs Graphviz.' } });
        expect(panelState(ended, 4)).toMatchObject({ dataflow: null, drawingMissing: 'Drawing needs Graphviz.', colouring: null });
    });

    test('once it ended, the verdict says the rest', () => {
        expect(panelState({ ...done(), progress }, 4).progress).toBeNull();
        expect(panelState(startedRun('release', 'file:///w/release.jd', false, LIBRARIES), 1).progress).toBeNull();
    });

    test('Results lists its elements below the row that says it is under way', () => {
        const rows = rowsWithoutReport(running);
        expect(rows[0]).toMatchObject({ id: 'status', label: 'Executing release…', description: '1 of 3 decided' });
        expect(rows.slice(1).map(r => r.id)).toEqual(['group/Failed', 'group/Running', 'group/Waiting']);
    });

    test('without events, the one row; once ended without a report, why; with a report, nothing', () => {
        const bare = startedRun('release', 'file:///w/release.jd', false, LIBRARIES);
        expect(rowsWithoutReport(bare)).toEqual([statusRow(bare)]);
        const notice = { text: 'release was stopped.', action: null };
        expect(rowsWithoutReport({ ...running, phase: 'stopped', notice }).map(r => r.label)).toEqual(['release was stopped.']);
        expect(rowsWithoutReport({ ...done(), progress })).toEqual([]);
    });
});
