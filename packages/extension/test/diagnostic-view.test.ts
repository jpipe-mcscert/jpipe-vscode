/**
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import {
    DiagnosticView,
    type DiagnosticViewElements,
    type DiagnosticViewHost
} from '../src/webview/diagnostic-view.js';
import {
    cleanTemplate,
    loadCrossFile,
    unifyAliases,
    unknownSymbol,
    unsupportedElements
} from './fixtures/diagnostic/index.js';

/**
 * The diagnostic view, exercised against a real document.
 *
 * There is no VS Code host here and never will be, but the view does not need one — it needs a
 * DOM and a report. Both are available, so the tables, the macro folding, the cross-links and
 * the fallback are checked here rather than left to be discovered by hand in the panel.
 *
 * What is still manual: how any of it looks.
 */

/** The markup `preview-shell.ts` builds, reduced to the parts the view writes into. */
function mountShell(): DiagnosticViewElements {
    document.body.className = '';
    document.body.replaceChildren();
    const make = (tag: string, id: string): HTMLElement => {
        const node = document.createElement(tag);
        node.id = id;
        document.body.append(node);
        return node;
    };
    const tabs = make('div', 'diag-tabs');
    for (const name of ['diagnostics', 'models', 'symbols', 'actions']) {
        const button = document.createElement('button');
        button.dataset.tab = name;
        button.id = `diag-tab-${name}`;
        tabs.append(button);
    }
    return {
        overlay: make('div', 'diagnostic-overlay'),
        tabs,
        filter: make('input', 'diag-filter') as HTMLInputElement,
        controlsExtra: make('div', 'diag-controls-extra'),
        panel: make('div', 'diag-panel'),
        output: make('pre', 'diag-output'),
        faces: make('div', 'diag-faces'),
        copyButton: make('button', 'diag-copy')
    };
}

/** The host, with each call recorded. Typed so a changed signature fails here too. */
interface MockHost extends DiagnosticViewHost {
    revealLocation: Mock<DiagnosticViewHost['revealLocation']>;
    copy: Mock<DiagnosticViewHost['copy']>;
    requestTextReport: Mock<DiagnosticViewHost['requestTextReport']>;
    persist: Mock<DiagnosticViewHost['persist']>;
}

let elements: DiagnosticViewElements;
let host: MockHost;
let view: DiagnosticView;

beforeEach(() => {
    elements = mountShell();
    host = {
        revealLocation: vi.fn<DiagnosticViewHost['revealLocation']>(),
        copy: vi.fn<DiagnosticViewHost['copy']>(),
        requestTextReport: vi.fn<DiagnosticViewHost['requestTextReport']>(),
        persist: vi.fn<DiagnosticViewHost['persist']>()
    };
    view = new DiagnosticView(elements, host);
});

const text = (): string => elements.panel.textContent ?? '';
const tab = (name: string): HTMLElement =>
    elements.tabs.querySelector<HTMLElement>(`[data-tab="${name}"]`)!;
/** Data rows only: group headings are full-width rows inside the same table. */
const rows = (): HTMLElement[] =>
    Array.from(elements.panel.querySelectorAll('tr:not(.diag-group-row)'));
const face = (name: string): HTMLElement =>
    elements.faces.querySelector<HTMLElement>(`[data-face="${name}"]`)!;

/**
 * A click that bubbles, as a real one does.
 *
 * The tab strip listens on the container and finds the button with `closest`, so a non-bubbling
 * event would never reach it — and the test would be measuring the event, not the view.
 */
function click(target: Element | null | undefined): void {
    expect(target, 'expected the element being clicked to exist').toBeTruthy();
    target!.dispatchEvent(new Event('click', { bubbles: true }));
}

function type(value: string): void {
    elements.filter.value = value;
    elements.filter.dispatchEvent(new Event('input'));
}

/* --------------------------------------------------------------------- the fallback */

describe('with no structured report', () => {
    test('shows the raw text and offers nothing to toggle to', () => {
        // What every compiler without `diagnostic -f json` gets. It has to look exactly like the
        // panel always has, with no error and no empty tables.
        view.show(null, '=== Diagnostics ===\n(none)\n');
        expect(elements.output.textContent).toContain('=== Diagnostics ===');
        expect(document.body.classList.contains('diag-raw')).toBe(true);
        expect(document.body.classList.contains('diag-no-report')).toBe(true);
    });

    test('going back to a real report restores the structured view', () => {
        view.show(null, 'raw text');
        view.show(cleanTemplate, 'raw text');
        expect(document.body.classList.contains('diag-raw')).toBe(false);
        expect(document.body.classList.contains('diag-no-report')).toBe(false);
    });
});

describe('the three faces of a report', () => {
    test('a structured report offers all three', () => {
        view.show(cleanTemplate, '{"schemaVersion":1}');
        expect(Array.from(elements.faces.querySelectorAll('[data-face]')).map(b => b.textContent))
            .toEqual(['Report', 'Text', 'JSON']);
        expect(face('report').getAttribute('aria-pressed')).toBe('true');
    });

    test('JSON shows exactly what the compiler emitted', () => {
        view.show(cleanTemplate, '{"schemaVersion":1}');
        click(face('json'));
        expect(elements.output.textContent).toBe('{"schemaVersion":1}');
        expect(document.body.classList.contains('diag-raw')).toBe(true);
    });

    test('the text report is fetched, because the JSON run did not produce one', () => {
        // The point of having a Text face at all: once the compiler answers `-f json`, its own
        // output *is* the JSON, so the classical report is a second invocation or nothing.
        view.show(cleanTemplate, '{"schemaVersion":1}');
        click(face('text'));
        expect(host.requestTextReport).toHaveBeenCalledTimes(1);
        expect(elements.output.textContent).toContain('Fetching');

        view.showTextReport('=== Diagnostics ===\n(none)\n');
        expect(elements.output.textContent).toContain('=== Diagnostics ===');
    });

    test('it is not fetched again on the way back to it', () => {
        view.show(cleanTemplate, '{}');
        click(face('text'));
        view.showTextReport('the text report');
        click(face('report'));
        click(face('text'));
        expect(host.requestTextReport).toHaveBeenCalledTimes(1);
        expect(elements.output.textContent).toBe('the text report');
    });

    test('a new run invalidates the text report it was fetched for', () => {
        view.show(cleanTemplate, '{}');
        click(face('text'));
        view.showTextReport('report for the first save');
        view.show(cleanTemplate, '{}');
        click(face('text'));
        expect(host.requestTextReport).toHaveBeenCalledTimes(2);
    });

    test('with no structured report there is nothing to choose between', () => {
        // The run's own output already is the text report, so all three would show the same file.
        view.show(null, 'the text report');
        expect(elements.faces.querySelectorAll('[data-face]')).toHaveLength(0);
        expect(elements.output.textContent).toBe('the text report');
        expect(host.requestTextReport).not.toHaveBeenCalled();
    });

    test('copy hands over what is on screen', () => {
        view.show(cleanTemplate, '{"schemaVersion":1}');
        click(face('json'));
        click(elements.copyButton);
        expect(host.copy).toHaveBeenCalledWith('{"schemaVersion":1}');

        click(face('text'));
        view.showTextReport('the text report');
        click(elements.copyButton);
        expect(host.copy).toHaveBeenLastCalledWith('the text report');
    });
});

/* ------------------------------------------------------------------------- summary */

describe('the tab strip', () => {
    test('carries the counts, so nothing above it has to repeat them', () => {
        view.show(unsupportedElements, '');
        expect(tab('diagnostics').textContent).toContain('3');
        expect(tab('models').textContent).toContain('3');
        expect(tab('symbols').textContent).toContain('6');
        expect(tab('actions').textContent).toContain('12');
    });

    test('a section with nothing in it is greyed out and cannot be opened', () => {
        view.show(cleanTemplate, '');
        const problems = tab('diagnostics') as HTMLButtonElement;
        expect(problems.disabled).toBe(true);
        expect(problems.getAttribute('aria-disabled')).toBe('true');
        expect(problems.textContent).toContain('0');
    });

    test('a clean report opens somewhere with something in it', () => {
        // Landing on a greyed-out Problems tab showing "No problems." would waste the one screen
        // the reader gets; the count on the tab already says it.
        view.show(cleanTemplate, '');
        expect(tab('diagnostics').getAttribute('aria-selected')).toBe('false');
        expect(tab('models').getAttribute('aria-selected')).toBe('true');
    });

    test('fixing the last problem moves the reader off the tab it was on', () => {
        view.show(unsupportedElements, '');
        expect(tab('diagnostics').getAttribute('aria-selected')).toBe('true');
        view.show(cleanTemplate, '');
        expect(tab('diagnostics').getAttribute('aria-selected')).toBe('false');
        expect(text()).not.toContain('No problems.');
    });

    test('a problem count is emphasised; a zero is not', () => {
        view.show(unsupportedElements, '');
        expect(tab('diagnostics').querySelector('.diag-tab-count')?.classList.contains('has-problems')).toBe(true);
        view.show(cleanTemplate, '');
        expect(tab('diagnostics').querySelector('.diag-tab-count')?.classList.contains('has-problems')).toBe(false);
    });
});

describe('the action statistics', () => {
    test('sit with the trace they describe, having no tab of their own', () => {
        view.show(loadCrossFile, '');
        click(tab('actions'));
        const note = elements.panel.querySelector('.diag-stats-note')?.textContent ?? '';
        expect(note).toContain('9 commands');
        expect(note).toContain('1 macro');
    });

    test('command count and step count are both shown, since they differ', () => {
        // A macro's expansion is listed in the trace but not counted as a command; deriving one
        // from the other would misreport whichever was derived.
        view.show(loadCrossFile, '');
        click(tab('actions'));
        const note = elements.panel.querySelector('.diag-stats-note')?.textContent ?? '';
        expect(note).toContain('9 commands');
        expect(note).toContain('12 steps');
    });

    test('macros are mentioned only when there are some', () => {
        view.show(cleanTemplate, '');
        click(tab('actions'));
        expect(elements.panel.querySelector('.diag-stats-note')?.textContent).not.toContain('macro');
    });

    test('deferrals are mentioned only when there were some', () => {
        // Non-zero deferrals mean forward references had to be retried — a hint, and noise at 0.
        view.show(cleanTemplate, '');
        click(tab('actions'));
        expect(elements.panel.querySelector('.diag-stats-note')?.textContent).not.toContain('deferrals');
        view.show(unknownSymbol, '');
        click(tab('actions'));
        expect(elements.panel.querySelector('.diag-stats-note')?.textContent).toContain('3 deferrals');
    });
});

/* --------------------------------------------------------------------- diagnostics */

describe('the problems tab', () => {
    test('lists each diagnostic with its code and message', () => {
        view.show(unsupportedElements, '');
        expect(rows()).toHaveLength(3);
        expect(text()).toContain('conclusion-supported');
        expect(text()).toContain("Conclusion 'c' in model 'missing_support_for_conclusion' has no supporting strategy");
    });

    test('a clean report says so on the tab, not with a screen of its own', () => {
        // The view moves off an empty section, so the "No problems." panel is only reached by
        // filtering everything out — the greyed "Problems 0" tab is the standing answer.
        view.show(cleanTemplate, '');
        expect((tab('diagnostics') as HTMLButtonElement).disabled).toBe(true);
        expect(tab('diagnostics').textContent).toContain('0');
    });

    test('clicking a row asks the host to open that position', () => {
        view.show(unsupportedElements, '');
        click(rows()[0]);
        expect(host.revealLocation).toHaveBeenCalledWith(
            '/work/examples/invalid/002_unsupported_elements.jd', 9, 15);
    });

    test('a diagnostic with no position is shown but not clickable', () => {
        view.show(unknownSymbol, '');
        const positionless = rows().find(r => r.textContent?.includes('unresolved symbol'));
        expect(positionless).toBeDefined();
        click(positionless!);
        expect(host.revealLocation).not.toHaveBeenCalled();
    });

    test('groups what could not be tied to a model, without dropping it', () => {
        // All three of this fixture's diagnostics resist attribution; every one still appears.
        view.show(unknownSymbol, '');
        expect(text()).toContain('Not tied to a model');
        expect(rows()).toHaveLength(3);
    });

    test('a code chip narrows the list, and clicking it again restores it', () => {
        view.show(unsupportedElements, '');
        const chip = elements.controlsExtra.querySelector('.diag-code');
        expect(chip?.textContent).toBe('conclusion-supported');
        click(chip);
        expect(rows()).toHaveLength(1);
        click(elements.controlsExtra.querySelector('.diag-code'));
        expect(rows()).toHaveLength(3);
    });

    test('the filter matches message text and code alike', () => {
        view.show(unsupportedElements, '');
        type('sub-conclusion');
        expect(rows()).toHaveLength(1);
        type('no supporting strategy');
        expect(rows()).toHaveLength(2);
        type('nothing here');
        expect(text()).toContain('No problems match');
    });
});

/* -------------------------------------------------------------------------- models */

describe('the models tab', () => {
    beforeEach(() => view.show(loadCrossFile, ''));

    test('shows a row per model with its kind and census', () => {
        // A table, like every other tab: a panel that changes shape between tabs is harder to
        // read than one that does not.
        click(tab('models'));
        expect(rows()).toHaveLength(2);
        expect(rows()[0].textContent).toContain('template');
        expect(rows()[0].textContent).toContain('base:t');
        expect(rows()[0].textContent).toContain('conclusion 1');
        expect(rows()[0].textContent).toContain('abstract-support 1');
    });

    test('names the template a justification implements', () => {
        click(tab('models'));
        expect(rows()[1].textContent).toContain('implements');
        expect(rows()[1].textContent).toContain('base:t');
    });

    test('lists implementors on the template, and only there', () => {
        // `usedBy` is guaranteed empty for a justification, so nothing is rendered rather than
        // an empty label.
        click(tab('models'));
        expect(rows()[0].textContent).toContain('used by');
        expect(rows()[1].textContent).not.toContain('used by');
    });

    test('the model’s own location opens the file it is actually in', () => {
        // The template is declared in a loaded file, not the one being diagnosed.
        click(tab('models'));
        click(rows()[0].querySelector('.diag-loc'));
        expect(host.revealLocation).toHaveBeenCalledWith('/work/examples/004_template.jd', 8, 9);
    });

    test('a button in the row does not also fire the row', () => {
        // A model row is clickable *and* carries buttons. Without a guard, one click on a census
        // chip would both jump to the symbols and open the source.
        click(tab('models'));
        click(elements.panel.querySelector('.diag-count-chip'));
        expect(host.revealLocation).not.toHaveBeenCalled();
    });

    test('a count chip jumps to that model’s symbols', () => {
        click(tab('models'));
        click(elements.panel.querySelector('.diag-count-chip'));
        expect(tab('symbols').getAttribute('aria-selected')).toBe('true');
        expect(elements.filter.value).toBe('base:t');
    });

    test('an error badge appears only where attribution found something', () => {
        view.show(unsupportedElements, '');
        click(tab('models'));
        expect(elements.panel.querySelectorAll('.diag-error-badge')).toHaveLength(3);

        // This fixture's diagnostics all resist attribution, so no row claims them.
        view.show(unknownSymbol, '');
        click(tab('models'));
        expect(elements.panel.querySelectorAll('.diag-error-badge')).toHaveLength(0);
    });

    test('the badge crosses to the problems tab, narrowed to that model', () => {
        view.show(unsupportedElements, '');
        click(tab('models'));
        click(elements.panel.querySelector('.diag-error-badge'));
        expect(tab('diagnostics').getAttribute('aria-selected')).toBe('true');
        expect(rows()).toHaveLength(1);
        expect(text()).toContain('missing_support_for_conclusion');
    });
});

/* ------------------------------------------------------------------------- symbols */

describe('the symbols tab', () => {
    beforeEach(() => click(tab('symbols')));

    test('groups by model, in the compiler’s display order', () => {
        view.show(cleanTemplate, '');
        expect(elements.panel.querySelectorAll('.diag-group-row')).toHaveLength(1);
        expect(rows().map(r => r.querySelector('.diag-id')?.textContent)).toEqual(['c', 's', 'abs']);
    });

    test('every model shares one table, so the columns line up', () => {
        // Each model used to get its own <table>, and separate tables size their columns
        // independently — so the same column sat at a different width under every heading.
        view.show(unsupportedElements, '');
        expect(elements.panel.querySelectorAll('table')).toHaveLength(1);
        expect(elements.panel.querySelectorAll('.diag-group-row')).toHaveLength(3);
        expect(rows()).toHaveLength(6);
    });

    test('the model name is a full-width row spanning every column', () => {
        view.show(unsupportedElements, '');
        const heading = elements.panel.querySelector('.diag-group-cell') as HTMLTableCellElement;
        expect(heading.colSpan).toBe(4);
        expect(heading.textContent).toContain('missing_support_for_conclusion');
    });

    test('marks synthesized elements, which have no location to show', () => {
        view.show(unifyAliases, '');
        const synthesized = rows().find(r => r.textContent?.includes('assembleConclusion'))!;
        expect(synthesized.textContent).toContain('synthesized');
        expect(synthesized.querySelector('.diag-loc')?.textContent).toBe('');
    });

    test('renders alias rewrites as their own rows', () => {
        view.show(unifyAliases, '');
        const alias = rows().find(r => r.textContent?.includes('a_claim:s1'))!;
        expect(alias.textContent).toContain('→ unified_0');
    });

    test('names the file for a symbol declared somewhere else', () => {
        view.show(loadCrossFile, '');
        const imported = rows().find(r => r.querySelector('.diag-id')?.textContent === 'base:t:c')!;
        expect(imported.querySelector('.diag-loc')?.textContent).toBe('004_template.jd:9:15');
    });

    test('clicking a cross-file symbol opens the other file', () => {
        view.show(loadCrossFile, '');
        click(rows().find(r => r.querySelector('.diag-id')?.textContent === 'base:t:c'));
        expect(host.revealLocation).toHaveBeenCalledWith('/work/examples/004_template.jd', 9, 15);
    });

    test('the filter matches a symbol id or a whole model', () => {
        view.show(unsupportedElements, '');
        type('sc');
        expect(rows()).toHaveLength(1);
        type('missing_support_for_strategy');
        expect(rows()).toHaveLength(2);
    });

    test('follows the editor cursor', () => {
        view.show(cleanTemplate, '');
        view.setCursorSymbol('s', 't');
        const current = elements.panel.querySelectorAll('tr.current');
        expect(current).toHaveLength(1);
        expect(current[0].textContent).toContain('s');
        view.setCursorSymbol(null, null);
        expect(elements.panel.querySelectorAll('tr.current')).toHaveLength(0);
    });

    test('marks the one row the cursor is in, not the same id in every model', () => {
        // Element ids are unique only within a model, and all three of this fixture's models
        // declare a `c`. Matching on the id alone lit up all of them.
        view.show(unsupportedElements, '');
        view.setCursorSymbol('c', 'missing_support_for_strategy');
        const current = elements.panel.querySelectorAll('tr.current');
        expect(current).toHaveLength(1);
        expect(current[0].querySelector('.diag-loc')?.textContent).toBe('14:15');
    });

    test('a symbol with no model to place it in is not guessed at', () => {
        view.show(unsupportedElements, '');
        view.setCursorSymbol('c', null);
        expect(elements.panel.querySelectorAll('tr.current')).toHaveLength(0);
    });

    test('a cursor in a model that declares no such element marks nothing', () => {
        view.show(unsupportedElements, '');
        view.setCursorSymbol('sc', 'missing_support_for_conclusion');
        expect(elements.panel.querySelectorAll('tr.current')).toHaveLength(0);
    });
});

/* ------------------------------------------------------------------------- actions */

describe('the actions tab', () => {
    beforeEach(() => click(tab('actions')));

    const actionRows = (): HTMLElement[] =>
        Array.from(elements.panel.querySelectorAll('.diag-action'));

    test('a flat trace shows every step', () => {
        view.show(cleanTemplate, '');
        expect(actionRows()).toHaveLength(6);
        expect(text()).toContain("create_template('t').");
    });

    test('macro expansions are folded away by default', () => {
        // The whole point of the tab: 57 steps become the 36 the user actually wrote.
        view.show(unifyAliases, '');
        expect(actionRows()).toHaveLength(36);
        expect(text()).toContain('(21 hidden)');
    });

    test('opening a macro reveals exactly what it expanded to', () => {
        view.show(loadCrossFile, '');
        expect(actionRows()).toHaveLength(9);
        click(elements.panel.querySelector('.diag-twisty:not(.leaf)'));
        expect(actionRows()).toHaveLength(12);
        expect(text()).toContain('rewire');
    });

    test('expand all and collapse all', () => {
        view.show(unifyAliases, '');
        const [expandAll, collapseAll] = Array.from(
            elements.controlsExtra.querySelectorAll<HTMLElement>('.diag-chip-btn'));
        click(expandAll);
        expect(actionRows()).toHaveLength(57);
        click(collapseAll);
        expect(actionRows()).toHaveLength(36);
    });

    test('shows the compiler’s own numbering', () => {
        // Not the array position: only one of the two is a promise, and it is what makes the
        // tree reconcilable with the raw text.
        view.show(loadCrossFile, '');
        const indices = actionRows().map(r => r.querySelector('.diag-action-index')?.textContent);
        expect(indices[0]).toBe('1.');
        expect(indices[8]).toBe('9.');
    });

    test('a filter reaches inside a collapsed macro and opens the way to the match', () => {
        view.show(loadCrossFile, '');
        type('rewire');
        expect(text()).toContain('rewire');
        expect(text()).not.toContain('hidden');
    });

    test('a filter matching nothing says so', () => {
        view.show(cleanTemplate, '');
        type('zzz');
        expect(text()).toContain('No commands match');
    });
});

/* --------------------------------------------------------------------- persistence */

describe('what survives a re-run', () => {
    test('the tab, filter and opened macros come back after a save', () => {
        view.show(unifyAliases, '');
        click(tab('actions'));
        click(elements.panel.querySelector('.diag-twisty:not(.leaf)'));
        type('support');

        const state = view.getState();
        expect(state.tab).toBe('actions');
        expect(state.filters.actions).toBe('support');
        expect(state.expandedMacros).toEqual([17]);

        // A save re-runs the compiler and re-renders the same document.
        view.show(unifyAliases, '');
        expect(tab('actions').getAttribute('aria-selected')).toBe('true');
        expect(elements.filter.value).toBe('support');
    });

    test('a different document starts clean', () => {
        // Carrying a filter or an opened macro to another file would point at things that are
        // not there.
        view.show(unifyAliases, '');
        click(tab('actions'));
        type('support');
        view.show(cleanTemplate, '');
        expect(elements.filter.value).toBe('');
        expect(view.getState().expandedMacros).toEqual([]);
    });

    /** State written by a previous session, as `vscode.getState()` would return it. */
    const savedState = (source: string | null) => ({
        tab: 'symbols' as const,
        filters: { symbols: 'abs' },
        scroll: {},
        expandedMacros: [],
        modelFocus: null,
        codeFocus: null,
        face: 'report' as const,
        source
    });

    test('a reload lands back where the reader was', () => {
        // The whole point of persisting: `Developer: Reload Webviews` replays the same report
        // into a fresh view, and the reader should not have to find their place again.
        const fresh = new DiagnosticView(elements, host);
        fresh.restoreState(savedState(cleanTemplate.source));
        fresh.show(cleanTemplate, '');
        expect(tab('symbols').getAttribute('aria-selected')).toBe('true');
        expect(elements.filter.value).toBe('abs');
        expect(rows()).toHaveLength(1);
    });

    test('a reload onto a different file does not keep the old filter', () => {
        const fresh = new DiagnosticView(elements, host);
        fresh.restoreState(savedState('/somewhere/else.jd'));
        fresh.show(cleanTemplate, '');
        expect(elements.filter.value).toBe('');
        expect(rows()).toHaveLength(3);
    });

    test('state from before the source was recorded is not trusted onto a report', () => {
        // Forward compatibility with a state object written by an older build.
        const fresh = new DiagnosticView(elements, host);
        fresh.restoreState(savedState(null));
        fresh.show(cleanTemplate, '');
        expect(tab('symbols').getAttribute('aria-selected')).toBe('true');
    });

    test('changing anything worth remembering asks the page to persist', () => {
        view.show(cleanTemplate, '');
        host.persist.mockClear();
        // Not `models`: a clean report already opens there, and selecting the current tab is a
        // no-op with nothing to remember.
        click(tab('symbols'));
        expect(host.persist).toHaveBeenCalled();
    });
});
