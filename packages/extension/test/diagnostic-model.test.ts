import { describe, expect, test } from 'vitest';
import type { DiagnosticReport, ExecutedAction } from '../src/shared/diagnostic-report.js';
import {
    attributeDiagnostics,
    basename,
    buildActionTree,
    censusEntries,
    countDescendants,
    distinctCodes,
    filterActionTree,
    flattenActionTree,
    formatLocation,
    isRenderableReport,
    symbolKindOfCensusKey
} from '../src/shared/diagnostic-model.js';
import {
    cleanTemplate,
    loadCrossFile,
    unifyAliases,
    unknownSymbol,
    unsupportedElements
} from './fixtures/diagnostic/index.js';

/**
 * The reasoning behind the diagnostic view, tested away from the DOM.
 *
 * The fixtures are transcriptions of real compiler output, so a case that looks contrived here is
 * usually one the compiler actually produces.
 */

/* ------------------------------------------------------------------------------- tier-1 gate */

describe('isRenderableReport', () => {
    test('accepts every fixture', () => {
        for (const report of [cleanTemplate, unsupportedElements, unknownSymbol, unifyAliases, loadCrossFile]) {
            expect(isRenderableReport(report)).toBe(true);
        }
    });

    test('rejects a schema version it does not know', () => {
        // A future major means the shape may have changed underneath us; the raw text is the
        // honest thing to show rather than a half-read report.
        expect(isRenderableReport({ ...cleanTemplate, schemaVersion: 2 })).toBe(false);
        expect(isRenderableReport({ ...cleanTemplate, schemaVersion: '1' })).toBe(false);
    });

    test('rejects things that are not reports at all', () => {
        expect(isRenderableReport(null)).toBe(false);
        expect(isRenderableReport('=== Diagnostics ===')).toBe(false);
        expect(isRenderableReport([])).toBe(false);
        expect(isRenderableReport(undefined)).toBe(false);
    });

    test('rejects a collection that is not a collection', () => {
        expect(isRenderableReport({ ...cleanTemplate, models: {} })).toBe(false);
        expect(isRenderableReport({ ...cleanTemplate, actions: null })).toBe(false);
        expect(isRenderableReport({ ...cleanTemplate, stats: 6 })).toBe(false);
    });

    test('accepts a report carrying members it has never heard of', () => {
        // The whole point of the gate being separate from schema validation: a compiler that
        // adds a field must keep rendering. The schema test is where that discrepancy is
        // reported, to a developer rather than a user.
        expect(isRenderableReport({ ...cleanTemplate, futureField: { anything: true } })).toBe(true);
    });
});

/* -------------------------------------------------------------------------------- attribution */

describe('attributeDiagnostics', () => {
    test('ties each completeness error to the model whose declaration it names', () => {
        const { byModel, unattributed } = attributeDiagnostics(unsupportedElements);
        expect(unattributed).toEqual([]);
        expect([...byModel.keys()].sort()).toEqual([
            'missing_support_for_conclusion',
            'missing_support_for_strategy',
            'missing_support_for_sub_conclusion'
        ]);
        expect(byModel.get('missing_support_for_sub_conclusion')?.[0].code)
            .toBe('sub-conclusion-supported');
    });

    test('leaves diagnostics pointing anywhere but a declaration unattributed', () => {
        // These two name `support` statements, not declarations — the case exact matching is
        // deliberately built to decline rather than guess at.
        const { byModel, unattributed } = attributeDiagnostics(unknownSymbol);
        expect(byModel.size).toBe(0);
        expect(unattributed).toHaveLength(3);
    });

    test('leaves a diagnostic with no position unattributed', () => {
        const positionless = unknownSymbol.diagnostics.filter(d => d.line === undefined);
        expect(positionless).toHaveLength(1);
        const { unattributed } = attributeDiagnostics(unknownSymbol);
        expect(unattributed).toContain(positionless[0]);
    });

    test('a position one column off does not match', () => {
        const [first, ...rest] = unsupportedElements.diagnostics;
        // Narrowing rather than asserting: `line` and `column` are one optional pair, so the
        // type will not let a column be rewritten without carrying the line along with it.
        if (first.line === undefined) throw new Error('fixture is expected to carry a position');
        const nudged: DiagnosticReport = {
            ...unsupportedElements,
            diagnostics: [{ ...first, line: first.line, column: first.column + 1 }, ...rest]
        };
        const { unattributed } = attributeDiagnostics(nudged);
        expect(unattributed).toHaveLength(1);
        expect(unattributed[0].code).toBe('conclusion-supported');
    });

    test('a matching position in another file does not match', () => {
        // Same line and column, different file: `load` makes this reachable, and treating it as
        // a hit would attribute an error to a model in a file it never mentions.
        const [first, ...rest] = unsupportedElements.diagnostics;
        const elsewhere: DiagnosticReport = {
            ...unsupportedElements,
            diagnostics: [{ ...first, source: '/somewhere/else.jd' }, ...rest]
        };
        expect(attributeDiagnostics(elsewhere).unattributed).toHaveLength(1);
    });

    test('resolves a location that omits its source against the report', () => {
        // `location.source` is omitted when it equals the report's own, so the index has to fill
        // it in — otherwise nothing in a single-file model would ever match.
        const { byModel } = attributeDiagnostics(unsupportedElements);
        expect(byModel.get('missing_support_for_conclusion')).toHaveLength(1);
    });

    test('nothing is lost: attributed plus unattributed is the whole list', () => {
        for (const report of [cleanTemplate, unsupportedElements, unknownSymbol, unifyAliases, loadCrossFile]) {
            const { byModel, unattributed } = attributeDiagnostics(report);
            const attributed = [...byModel.values()].reduce((n, list) => n + list.length, 0);
            expect(attributed + unattributed.length).toBe(report.diagnostics.length);
        }
    });
});

/* -------------------------------------------------------------------------------- action tree */

/** A trace built by hand, so the awkward shapes can be stated rather than hunted for. */
function trace(...rows: Array<[depth: number, macro: boolean, description: string]>): ExecutedAction[] {
    return rows.map(([depth, macro, description], i) => ({ index: i + 1, depth, macro, description }));
}

describe('buildActionTree', () => {
    test('a flat trace stays flat', () => {
        const tree = buildActionTree(cleanTemplate.actions);
        expect(tree).toHaveLength(6);
        expect(tree.every(node => node.children.length === 0)).toBe(true);
    });

    test('a macro owns the run indented under it', () => {
        // The real shape from `007_load_user.jd`: eight plain steps, then an override macro with
        // three expansion steps beneath it.
        const tree = buildActionTree(loadCrossFile.actions);
        expect(tree).toHaveLength(9);
        const macro = tree[8];
        expect(macro.action.macro).toBe(true);
        expect(macro.children).toHaveLength(3);
        expect(countDescendants(macro)).toBe(3);
    });

    test('a macro stops owning at the next action of its own depth', () => {
        const tree = buildActionTree(trace(
            [0, true, 'macro a'],
            [1, false, 'inside a'],
            [0, false, 'after a']
        ));
        expect(tree.map(n => n.action.description)).toEqual(['macro a', 'after a']);
        expect(tree[0].children).toHaveLength(1);
    });

    test('handles nesting more than one level deep', () => {
        const tree = buildActionTree(trace(
            [0, true, 'outer'],
            [1, true, 'inner'],
            [2, false, 'deep'],
            [1, false, 'back to inner level'],
            [0, false, 'root again']
        ));
        expect(tree).toHaveLength(2);
        expect(countDescendants(tree[0])).toBe(3);
        expect(tree[0].children[0].children[0].action.description).toBe('deep');
    });

    test('a trailing macro with nothing under it is still a node', () => {
        const tree = buildActionTree(trace([0, false, 'plain'], [0, true, 'macro with no expansion']));
        expect(tree).toHaveLength(2);
        expect(tree[1].children).toEqual([]);
    });

    test('a depth jump wider than one is clamped rather than dropped', () => {
        // Not something the compiler emits today, but the alternative to clamping is losing a
        // step, and a trace that silently omits a command is worse than one nested oddly.
        const actions = trace([0, false, 'root'], [3, false, 'suddenly deep']);
        const tree = buildActionTree(actions);
        expect(flattenActionTree(tree)).toEqual(actions);
        expect(tree[0].children[0].action.description).toBe('suddenly deep');
    });

    test('a trace starting already indented still yields roots', () => {
        const actions = trace([2, false, 'orphan'], [0, false, 'root']);
        expect(flattenActionTree(buildActionTree(actions))).toEqual(actions);
    });

    test('flattening reproduces the input, for every fixture', () => {
        for (const report of [cleanTemplate, unsupportedElements, unknownSymbol, unifyAliases, loadCrossFile]) {
            expect(flattenActionTree(buildActionTree(report.actions))).toEqual(report.actions);
        }
    });

    test('the composition trace nests its whole expansion under one macro', () => {
        // `011_unifying_while_compising.jd`: 57 steps, of which 21 are one macro's expansion.
        const tree = buildActionTree(unifyAliases.actions);
        const macros = tree.filter(node => node.action.macro);
        expect(macros).toHaveLength(1);
        expect(countDescendants(macros[0])).toBe(21);
        expect(tree).toHaveLength(unifyAliases.actions.length - 21);
    });

    test('an empty trace is an empty tree', () => {
        expect(buildActionTree([])).toEqual([]);
    });
});

describe('filterActionTree', () => {
    test('an empty needle is the identity', () => {
        const tree = buildActionTree(unifyAliases.actions);
        expect(filterActionTree(tree, '')).toBe(tree);
    });

    test('keeps the ancestors of a match so the path to it survives', () => {
        const tree = buildActionTree(loadCrossFile.actions);
        const filtered = filterActionTree(tree, 'rewire');
        expect(filtered).toHaveLength(1);
        expect(filtered[0].action.macro).toBe(true);
        expect(filtered[0].children).toHaveLength(1);
        expect(filtered[0].children[0].action.description).toContain('rewire');
    });

    test('keeps a matching parent without dragging in its children', () => {
        const filtered = filterActionTree(
            buildActionTree(trace([0, true, 'override(x)'], [1, false, 'remove(x)'])),
            'override'
        );
        expect(filtered[0].children).toEqual([]);
    });

    test('is case-insensitive', () => {
        const tree = buildActionTree(cleanTemplate.actions);
        expect(filterActionTree(tree, 'CREATE_TEMPLATE')).toHaveLength(1);
    });

    test('a needle matching nothing yields nothing', () => {
        expect(filterActionTree(buildActionTree(cleanTemplate.actions), 'zzz')).toEqual([]);
    });
});

/* --------------------------------------------------------------------------- census and codes */

describe('the element census', () => {
    test('maps camelCase census keys onto hyphenated symbol kinds', () => {
        expect(symbolKindOfCensusKey('subConclusion')).toBe('sub-conclusion');
        expect(symbolKindOfCensusKey('abstractSupport')).toBe('abstract-support');
    });

    test('lists only categories the model actually has, in display order', () => {
        expect(censusEntries(cleanTemplate.models[0].elements).map(e => e.key))
            .toEqual(['conclusion', 'strategy', 'abstractSupport']);
    });

    test('the census agrees with the symbols the same model lists', () => {
        // The two come from different sections of the report; if a transcription drifted, this
        // is where it shows.
        for (const report of [cleanTemplate, unsupportedElements, unknownSymbol, unifyAliases, loadCrossFile]) {
            for (const model of report.models) {
                const counted = censusEntries(model.elements).reduce((n, e) => n + e.count, 0);
                expect(model.symbols.length, `${report.source} / ${model.name}`).toBe(counted);
            }
        }
    });
});

describe('distinctCodes', () => {
    test('lists each code once, in first-seen order', () => {
        expect(distinctCodes(unsupportedElements.diagnostics))
            .toEqual(['conclusion-supported', 'strategy-supported', 'sub-conclusion-supported']);
    });

    test('skips diagnostics that carry no code', () => {
        expect(distinctCodes(unknownSymbol.diagnostics)).toEqual(['unknown-element']);
    });
});

/* ------------------------------------------------------------------------------- presentation */

describe('formatLocation', () => {
    test('shows a bare position for the report’s own file', () => {
        expect(formatLocation({ line: 9, column: 15 }, '/work/m.jd')).toBe('9:15');
        expect(formatLocation({ source: '/work/m.jd', line: 9, column: 15 }, '/work/m.jd')).toBe('9:15');
    });

    test('names the file when the location is somewhere else', () => {
        // Otherwise two rows pointing at different files would read identically.
        expect(formatLocation({ source: '/work/base.jd', line: 9, column: 15 }, '/work/m.jd'))
            .toBe('base.jd:9:15');
    });

    test('a synthesized element has nothing to show', () => {
        expect(formatLocation(undefined, '/work/m.jd')).toBe('');
    });

    test('the load fixture shows its cross-file symbols by name', () => {
        const template = loadCrossFile.models[0];
        expect(formatLocation(template.symbols[0].location, loadCrossFile.source))
            .toBe('004_template.jd:9:15');
    });
});

describe('basename', () => {
    test('handles both separators, since locations may be Windows paths', () => {
        expect(basename('/a/b/c.jd')).toBe('c.jd');
        expect(basename('C:\\a\\b\\c.jd')).toBe('c.jd');
        expect(basename('c.jd')).toBe('c.jd');
    });
});
