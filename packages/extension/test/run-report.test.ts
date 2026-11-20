import { describe, expect, test } from 'vitest';
import {
    fileSize, parseReport, resultRows, stepLocation, verdictLinks, verdictSentence, withReport,
    type ResultRow, type RunReport
} from '../src/extension/runner/run-report.js';

/**
 * A run's JSON report, as the Results view lists it.
 *
 * The reports are the examples of jpipe-runner's `docs/report-schema.md`, cut to the fields that
 * matter here, plus an evidence shared by two strategies: the case the list exists for.
 */

const element = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 'x', label: 'X', kind: 'evidence', aliases: [], supports: [], status: 'pass', reason: null,
    blocked_by: [], ran: true, bound_to: null, bound_by: [], observes: [], consumes: [], produces: [],
    produced: {}, artifacts: [], ...over
});

const document = (over: Record<string, unknown>): string => JSON.stringify({
    schema_version: '1.0', justification: 'release', verdict: 'pass', strict: false, summary: {},
    elements: [], diagnostics: [], diagram: null, dataflow: null, ...over
});

const read = (over: Record<string, unknown>): RunReport => {
    const parsed = parseReport(document(over));
    if ('problem' in parsed) throw new Error(parsed.problem);
    return parsed.report;
};

const RELEASE = {
    verdict: 'fail',
    elements: [
        element({
            id: 'release:e1', label: 'The test suite passes', supports: ['release:s', 'release:s2'], status: 'fail',
            reason: 'mock/junit.xml: 2 tests failed', bound_to: 'steps.the_test_suite_passes',
            observes: ['mock/junit.xml'], artifacts: [{ path: 'mock/junit.xml', reachable: true, sha256: 'f7', size: 187 }]
        }),
        element({
            id: 'release:e2', label: 'The changelog is up to date', supports: ['release:s'],
            produced: { changelog_ok: { value: true }, where: { repr: "PosixPath('CHANGELOG.md')", type: 'pathlib.PosixPath' } }
        }),
        element({
            id: 'release:s', label: 'All release gates pass', kind: 'strategy', supports: ['release:c'], status: 'skip',
            reason: 'not run: release:e1 did not pass', blocked_by: ['release:e1'], ran: false,
            consumes: ['tests_pass'], observes: ['gates/*.txt']
        }),
        element({
            id: 'release:s2', label: 'Coverage is sufficient', kind: 'strategy', supports: ['release:c'], status: 'skip',
            reason: 'not run: release:e1 did not pass', blocked_by: ['release:e1'], ran: false
        }),
        element({
            id: 'release:c', label: 'Version 2.0 is ready to ship', kind: 'conclusion', status: 'skip',
            reason: 'not run: release:e1 did not pass', blocked_by: ['release:e1'], ran: false
        })
    ]
};

const flat = (rows: readonly ResultRow[]): ResultRow[] => rows.flatMap(r => [r, ...flat(r.children)]);
const row = (rows: readonly ResultRow[], id: string): ResultRow => {
    const found = flat(rows).find(r => r.id === id);
    if (!found) throw new Error(`no row ${id}`);
    return found;
};

describe('reading the report', () => {

    test('fields this version does not know are ignored, and missing ones read as empty', () => {
        const parsed = parseReport(JSON.stringify({
            schema_version: '1.7', verdict: 'pass', duration: 3, elements: [{ id: 'e', status: 'pass', colour: 'red' }]
        }));
        expect(parsed).toMatchObject({ report: { justification: null, elements: [{ id: 'e', supports: [], artifacts: [] }] } });
    });

    test.each([
        ['what is not JSON', 'jpipe-runner 4.0.0\n{}', 'not JSON'],
        ['a major version this extension does not know', document({ schema_version: '3.0' }), 'version 3.0'],
        ['a report without a version', '{"verdict":"pass"}', 'version (none)'],
        ['a report without a verdict', document({ verdict: 'maybe' }), 'no verdict']
    ])('%s is refused, with the reason', (_case, content, reason) => {
        expect(parseReport(content)).toEqual({ problem: expect.stringContaining(reason) });
    });
});

describe('the rows of a failed run', () => {
    const rows = resultRows(read(RELEASE), 'release');

    test('the verdict comes first, with the counts that are not zero', () => {
        expect(rows[0]).toMatchObject({ label: 'release failed', description: '1 passed · 1 failed · 3 skipped', icon: 'fail' });
    });

    test('then the elements by outcome, failures first, and what passed folded away', () => {
        expect(rows.slice(1).map(r => [r.label, r.description, r.expanded])).toEqual([
            ['Failed', '1', true], ['Skipped', '3', true], ['Passed', '1', false]
        ]);
    });

    test('an evidence shared by two strategies is listed once', () => {
        const shared = flat(rows).filter(r => r.label === 'The test suite passes' && r.id.split('/').length === 2);
        expect(shared).toHaveLength(1);
        expect(shared[0].children.filter(c => c.description === 'supports').map(c => c.label))
            .toEqual(['All release gates pass', 'Coverage is sufficient']);
    });

    test('a failed element says why, and is open', () => {
        expect(row(rows, 'element/release:e1')).toMatchObject({
            description: 'evidence · mock/junit.xml: 2 tests failed', icon: 'fail', expanded: true
        });
    });

    test('a skipped element names what stopped it by its label, and leads to it', () => {
        const skipped = row(rows, 'element/release:c');
        expect(skipped.description).toBe('conclusion · stopped by The test suite passes');
        expect(skipped.children[0]).toMatchObject({ label: 'The test suite passes', description: 'stopped it', goTo: 'element/release:e1' });
    });

    test('a file a step observed opens, with its size', () => {
        expect(row(rows, 'element/release:e1/artifact0'))
            .toMatchObject({ label: 'mock/junit.xml', description: 'observed · 187 B', open: { path: 'mock/junit.xml' } });
    });

    test('a step that was not called lists what it would observe and consume', () => {
        const children = row(rows, 'element/release:s').children.map(c => [c.label, c.description]);
        expect(children).toContainEqual(['gates/*.txt', 'observes']);
        expect(children).toContainEqual(['tests_pass', 'consumes']);
    });

    test('a produced value reads as JSON, or as its repr when it is not JSON', () => {
        expect(row(rows, 'element/release:e2').children.filter(c => c.description === 'produced').map(c => c.label))
            .toEqual(['changelog_ok = true', "where = PosixPath('CHANGELOG.md')"]);
    });

    test('a step is a row that opens its function', () => {
        expect(row(rows, 'element/release:e1/step')).toMatchObject({ label: 'steps.the_test_suite_passes', step: 'steps.the_test_suite_passes' });
    });

    test('a report that repeats a variable or an element still gives every row its own id', () => {
        const repeated = resultRows(read({ elements: [element({ id: 'e', consumes: ['v', 'v'], supports: ['s', 's'], blocked_by: ['b', 'b'] })] }), 'release');
        const ids = flat(repeated).map(r => r.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('row ids are unique', () => {
        const ids = flat(rows).map(r => r.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('problems', () => {

    test('a step that raised has its diagnostic under its element: the fix, then the frames to open', () => {
        const rows = resultRows(read({
            justification: 'error_prone', verdict: 'fail',
            elements: [element({ id: 'S1', label: 'Divide by number', kind: 'strategy', status: 'fail', reason: 'the step raised' })],
            diagnostics: [{
                code: 'JP022', severity: 'error', element: 'S1', message: 'the step raised ZeroDivisionError', fix: 'Return Fail(reason).',
                traceback: {
                    exception: 'ZeroDivisionError', message: 'division by zero', cause: null,
                    frames: [{ file: 'steps.py', line: 17, function: 'divide_by_number', code: 'return Pass(result=N / D)' }]
                }
            }]
        }), 'error_prone');
        const diagnostic = row(rows, 'element/S1/diagnostic0');
        expect(diagnostic).toMatchObject({ label: 'the step raised ZeroDivisionError', description: 'JP022', icon: 'error' });
        expect(diagnostic.children.map(c => [c.icon, c.label])).toEqual([['fix', 'Return Fail(reason).'], ['frame', 'steps.py:17']]);
        expect(diagnostic.children[1].open).toEqual({ path: 'steps.py', line: 17 });
        expect(rows.map(r => r.label)).not.toContain('Problems');
    });

    test('a refused model has no element, so its problem stands on its own', () => {
        const report = read({
            justification: null, verdict: 'invalid',
            diagnostics: [{ code: 'JP004', severity: 'error', element: 'S1', message: 'the relations form a cycle', fix: 'Remove one.', traceback: null }]
        });
        const rows = resultRows(report, 'loop');
        expect(rows.map(r => r.label)).toEqual(['loop could not be run', 'Problems']);
        expect(rows[1].children[0]).toMatchObject({ label: 'the relations form a cycle', description: 'JP004' });
        expect(verdictSentence(report, 'loop')).toBe('loop could not be run: 1 error.');
    });

});

describe('when no step was called', () => {
    const unrun = (id: string) => element({ id, label: id.toUpperCase(), status: null, ran: false });
    const problem = (severity: string, on: string | null) =>
        ({ code: 'JP010', severity, element: on, message: `a ${severity}`, fix: null, traceback: null });

    test('a check that finds nothing wrong says the model is valid, and lists its elements', () => {
        const rows = resultRows(read({ verdict: 'valid', elements: [unrun('e'), unrun('s')] }), 'release', true);
        expect(rows.map(r => [r.label, r.description])).toEqual([['release is valid', undefined], ['No problem', '2']]);
        expect(rows[1].children.map(r => r.icon)).toEqual(['not-run', 'not-run']);
    });

    test('elements are grouped by whether a problem is about them, and show their worst one', () => {
        const rows = resultRows(read({
            verdict: 'valid', elements: [unrun('e'), unrun('s'), unrun('c')],
            diagnostics: [problem('warning', 's'), problem('warning', 'c'), problem('error', 'c')]
        }), 'release', true);
        expect(rows[0].description).toBe('1 error · 2 warnings');
        expect(rows.slice(1).map(r => [r.label, r.children.map(c => c.label)]))
            .toEqual([['With problems', ['S', 'C']], ['No problem', ['E']]]);
        expect(rows[1].children.map(r => [r.icon, r.expanded])).toEqual([['warning', true], ['error', true]]);
    });

    test('a check with errors is not valid; a run stopped the same way could not be run', () => {
        const report = read({ verdict: 'invalid', elements: [unrun('e')], diagnostics: [problem('error', 'e')] });
        expect(resultRows(report, 'release', true)[0].label).toBe('release is not valid');
        expect(resultRows(report, 'release')[0].label).toBe('release could not be run');
        expect(verdictSentence(report, 'release', true)).toBe('release is not valid: 1 error.');
    });
});

describe('the verdict\'s counts, as links to Results', () => {
    const unrun = (id: string) => element({ id, status: null, ran: false });
    const problem = (severity: string, on: string | null) =>
        ({ code: 'JP010', severity, element: on, message: `a ${severity}`, fix: null, traceback: null });

    test('after a run, each outcome opens its group', () => {
        expect(verdictLinks(read(RELEASE))).toEqual([
            { text: '1 passed', row: 'group/Passed' },
            { text: '1 failed', row: 'group/Failed' },
            { text: '3 skipped', row: 'group/Skipped' }
        ]);
    });

    test('after a run, problems about no element are counted too, since no node shows them', () => {
        const report = read({ ...RELEASE, diagnostics: [problem('warning', null), problem('warning', 'release:e1')] });
        expect(verdictLinks(report).at(-1)).toEqual({ text: '1 problem', row: 'problems' });
    });

    test('when no step was called, the problems are counted, and open where they are listed', () => {
        expect(verdictLinks(read({ verdict: 'valid', elements: [unrun('e')], diagnostics: [problem('warning', 'e')] })))
            .toEqual([{ text: '1 warning', row: 'group/With problems' }]);
        expect(verdictLinks(read({ verdict: 'invalid', diagnostics: [problem('error', null), problem('error', null)] })))
            .toEqual([{ text: '2 problems', row: 'problems' }]);
        expect(verdictLinks(read({ verdict: 'valid', elements: [unrun('e')] }))).toEqual([]);
    });

    test('problems about elements and about none are counted apart, each opening the group that lists it', () => {
        const report = read({
            verdict: 'invalid', elements: [unrun('e')],
            diagnostics: [problem('error', null), problem('warning', 'e'), problem('error', 'e')]
        });
        expect(verdictLinks(report)).toEqual([
            { text: '1 error', row: 'group/With problems' },
            { text: '1 warning', row: 'group/With problems' },
            { text: '1 problem', row: 'problems' }
        ]);
        const rows = flat(resultRows(report, 'release', true));
        expect(rows.find(r => r.id === 'problems')?.children).toHaveLength(1);
        expect(rows.find(r => r.id === 'group/With problems')?.children.map(c => c.id)).toEqual(['element/e']);
    });

    test('every link names a row the Results view has', () => {
        const report = read({ ...RELEASE, diagnostics: [problem('warning', null)] });
        const ids = new Set(flat(resultRows(report, 'release')).map(r => r.id));
        for (const link of verdictLinks(report)) expect(ids).toContain(link.row);
    });
});

describe('around the report', () => {

    test('a run is summed up in a sentence', () => {
        expect(verdictSentence(read(RELEASE), 'release')).toBe('release failed: 1 passed, 1 failed, 3 skipped.');
    });

    test('a step is found in the library its module is named after', () => {
        const steps = [
            { kind: 'evidence' as const, ids: ['e'], functionName: 'check', libraryUri: 'file:///w/other.py', line: 3 },
            { kind: 'evidence' as const, ids: ['e'], functionName: 'check', libraryUri: 'file:///w/my%20lib/steps.py', line: 9 }
        ];
        expect(stepLocation('steps.check', steps)).toEqual({ libraryUri: 'file:///w/my%20lib/steps.py', line: 9 });
        expect(stepLocation('pkg.steps.check', steps)?.line).toBe(9);
        expect(stepLocation('steps.missing', steps)).toBeUndefined();
        expect(stepLocation('check', steps)).toBeUndefined();
    });

    test('a check is a dry run, with the same report', () => {
        expect(withReport(['-l', '/w/a.py', '/tmp/m.json'], '/tmp/r.json', true))
            .toEqual(['--dry-run', '--report', '/tmp/r.json', '-l', '/w/a.py', '/tmp/m.json']);
    });

    test('the runner is asked to write its report to a file', () => {
        expect(withReport(['-l', '/w/a.py', '/tmp/release.json'], '/tmp/release.report.json'))
            .toEqual(['--report', '/tmp/release.report.json', '-l', '/w/a.py', '/tmp/release.json']);
    });

    test('a run is asked to draw its dataflow only, after its report and before its libraries', () => {
        expect(withReport(['-l', '/w/a.py', '/tmp/m.json'], '/tmp/r.json', false, { path: '/tmp/m-dataflow.svg', flag: '--diagram' }))
            .toEqual(['--report', '/tmp/r.json', '--diagram', '/tmp/m-dataflow.svg', '-l', '/w/a.py', '/tmp/m.json']);
        expect(withReport(['/tmp/m.json'], '/tmp/r.json', true, { path: 'd.svg', flag: '--dataflow' }))
            .toEqual(['--dry-run', '--report', '/tmp/r.json', '--dataflow', 'd.svg', '/tmp/m.json']);
    });

    test('in a version 1 report, the dataflow is `dataflow`; `diagram` is the argument alone, never asked for', () => {
        expect(read({ dataflow: '/tmp/m-dataflow.svg' })).toMatchObject({ dataflow: '/tmp/m-dataflow.svg' });
        expect(read({ diagram: '/tmp/m.svg', dataflow: null })).toMatchObject({ dataflow: null });
        expect(read({})).toMatchObject({ dataflow: null });
        expect(parseReport(JSON.stringify({ schema_version: '1.0', verdict: 'pass' }))).toMatchObject({ report: { dataflow: null } });
    });

    test('in a version 2 report, the one diagram is the dataflow', () => {
        // jpipe-runner after 4.0 draws one diagram, the dataflow, and names it `diagram`.
        const v2 = (over: Record<string, unknown>) => parseReport(document({ schema_version: '2.0', dataflow: undefined, ...over }));
        expect(v2({ diagram: '/tmp/m-dataflow.svg' })).toMatchObject({ report: { dataflow: '/tmp/m-dataflow.svg' } });
        expect(v2({ diagram: null })).toMatchObject({ report: { dataflow: null } });
        expect(v2({ diagram: null, dataflow: '/tmp/stale.svg' })).toMatchObject({ report: { dataflow: null } });
    });

    test.each([[187, '187 B'], [1234, '1.2 kB'], [3_400_000, '3.4 MB']])('%i bytes reads %s', (bytes, shown) => {
        expect(fileSize(bytes)).toBe(shown);
    });
});
