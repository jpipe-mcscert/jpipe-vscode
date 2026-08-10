/**
 * The diagnostic report, as something to explore rather than scroll.
 *
 * The report is five things, not one — problems, models, symbols, a command trace, and the
 * statistics tying them together — so this builds a tab per section over a shared summary strip,
 * and lets each keep its own filter and its own scroll position.
 *
 * Like `preview.ts`, this is meant to be a thin adapter: the reasoning (which model a diagnostic
 * belongs to, what the flat action list nests into, what a location reads as) lives in the pure
 * `diagnostic-model.ts`, where it can be tested without a browser. What is left here is building
 * DOM and handling clicks.
 *
 * Two rules the page's CSP enforces, and which are worth stating anyway because compiler output
 * carries user-authored model names, labels and messages: build nodes and set `textContent`,
 * never `innerHTML`; and put appearance in `preview.css`, never in an inline `style`.
 */

import type {
    Diagnostic,
    DiagnosticReport,
    ModelSummary,
    SourceLocation,
    SymbolEntry
} from '../shared/diagnostic-report.js';
import {
    attributeDiagnostics,
    buildActionTree,
    censusEntries,
    countDescendants,
    distinctCodes,
    errorCountFor,
    filterActionTree,
    formatLocation,
    matches,
    symbolKindOfCensusKey,
    type ActionNode,
    type Attribution
} from '../shared/diagnostic-model.js';

export type DiagnosticTab = 'diagnostics' | 'models' | 'symbols' | 'actions';

const TABS: DiagnosticTab[] = ['diagnostics', 'models', 'symbols', 'actions'];

/**
 * Which of the report's three presentations is showing.
 *
 * `report` is the structured view. `text` is the compiler's own human-readable report — the one
 * the panel used to show, and still the thing to copy into a bug report or diff against a
 * previous run. `json` is exactly what the compiler emitted.
 *
 * The last two are not the same document once the compiler speaks JSON: asking for `-f json`
 * means the run's own output *is* the JSON, and the text report has to be fetched separately.
 * That is why `text` is requested from the host rather than sliced out of what we already have.
 */
export type DiagnosticFace = 'report' | 'text' | 'json';

const FACE_LABELS: ReadonlyArray<{ face: DiagnosticFace; label: string; title: string }> = [
    { face: 'report', label: 'Report', title: 'The structured report' },
    { face: 'text', label: 'Text', title: "The compiler's own text report" },
    { face: 'json', label: 'JSON', title: 'Exactly what the compiler emitted' }
];

/** What survives a save, a tab switch, and a webview reload. */
export interface DiagnosticViewState {
    tab: DiagnosticTab;
    filters: Partial<Record<DiagnosticTab, string>>;
    scroll: Partial<Record<DiagnosticTab, number>>;
    /**
     * Macro nodes the user opened, by action index.
     *
     * Expanded rather than collapsed, because collapsed is the default: a trace is mostly macro
     * expansion, and showing all of it by default is the wall of text this view exists to undo.
     */
    expandedMacros: number[];
    /** Restrict the problems list to one model, as the Models tab's error badge does. */
    modelFocus: string | null;
    codeFocus: string | null;
    face: DiagnosticFace;
    /**
     * The report this state belongs to.
     *
     * Kept so a reload can tell "the same document, replayed" — where the reader's place should
     * come back — from "a different file", where every filter and open macro names something
     * that may not exist.
     */
    source: string | null;
}

/** The elements the view writes into. Passed in so this module never queries the document. */
export interface DiagnosticViewElements {
    overlay: HTMLElement;
    tabs: HTMLElement;
    filter: HTMLInputElement;
    controlsExtra: HTMLElement;
    panel: HTMLElement;
    output: HTMLElement;
    faces: HTMLElement;
    copyButton: HTMLElement;
}

/** What the view needs from outside the page. */
export interface DiagnosticViewHost {
    revealLocation(source: string, line: number, column: number): void;
    copy(text: string): void;
    /**
     * Fetch the compiler's text report.
     *
     * Only ever called when the structured report came from a JSON run, where the text version
     * is a second invocation. Requested when the user first asks for it rather than alongside
     * every save, since most readers never open it.
     */
    requestTextReport(): void;
    /** Called whenever something worth remembering changes. */
    persist(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** A location's file, filling in the report's own when the location does not name one. */
function sourceOf(location: SourceLocation, reportSource: string): string {
    return location.source ?? reportSource;
}

export class DiagnosticView {
    private report: DiagnosticReport | null = null;
    private raw = '';
    private attribution: Attribution = { byModel: new Map(), unattributed: [] };
    private actionTree: ActionNode[] = [];

    private tab: DiagnosticTab = 'diagnostics';
    private readonly filters = new Map<DiagnosticTab, string>();
    private readonly scroll = new Map<DiagnosticTab, number>();
    private expandedMacros = new Set<number>();
    private modelFocus: string | null = null;
    private codeFocus: string | null = null;
    private face: DiagnosticFace = 'report';
    /**
     * The compiler's text report, once fetched.
     *
     * Null means "not asked for yet" when a structured report is showing; when there is no
     * structured report the run's own output is already the text, and this is unused.
     */
    private textReport: string | null = null;
    /** The report the current view state belongs to. See `DiagnosticViewState.source`. */
    private lastSource: string | null = null;
    /**
     * The element under the editor cursor, for the Symbols tab to follow.
     *
     * Both halves are needed. An element id is unique only inside its own model, and nearly every
     * justification declares a `c` and an `s`, so matching on the id alone marks one row per
     * model instead of the one the cursor is actually in.
     */
    private cursorSymbol: { id: string; model: string } | null = null;

    constructor(
        private readonly elements: DiagnosticViewElements,
        private readonly host: DiagnosticViewHost
    ) {
        this.elements.tabs.addEventListener('click', event => {
            const button = (event.target as HTMLElement).closest<HTMLElement>('[data-tab]');
            if (!button) return;
            this.selectTab(button.dataset.tab as DiagnosticTab);
        });

        this.elements.filter.addEventListener('input', () => {
            this.filters.set(this.tab, this.elements.filter.value);
            this.renderPanel();
            this.host.persist();
        });

        this.elements.faces.addEventListener('click', event => {
            const button = (event.target as HTMLElement).closest<HTMLElement>('[data-face]');
            if (button) this.setFace(button.dataset.face as DiagnosticFace);
        });

        // Copies what the reader is looking at, so the button means the same thing wherever it
        // is pressed. In the structured view there is no single text to copy, so it hands over
        // the compiler's own report — which is what a bug report wants anyway.
        this.elements.copyButton.addEventListener('click', () => this.host.copy(this.copyable()));

        // Remembering where the user was reading is the whole point of keeping state across a
        // save; the panel is re-rendered on every run and would otherwise snap back to the top.
        this.elements.panel.addEventListener('scroll', () => {
            this.scroll.set(this.tab, this.elements.panel.scrollTop);
        });
    }

    /* ------------------------------------------------------------------ incoming */

    /**
     * Show a run.
     *
     * A null report is a supported outcome — an older compiler, or output this build cannot
     * read — and means the raw text is all there is. The toggle disappears in that case rather
     * than offering a view that does not exist.
     */
    show(report: DiagnosticReport | null, raw: string): void {
        // Compared against the *remembered* source rather than the previous report, so that a
        // state restored after a webview reload survives the report being replayed into it.
        // Keying off `this.report` would treat every reload as a document change and throw the
        // reader's place away — which is the thing persistence exists to prevent.
        const changedDocument = report !== null
            && this.lastSource !== null
            && this.lastSource !== report.source;
        if (report !== null) this.lastSource = report.source;
        this.report = report;
        this.raw = raw;
        // A new run means a new text report; the old one describes the previous save.
        this.textReport = report === null ? raw : null;

        document.body.classList.toggle('diag-no-report', report === null);
        if (report !== null) {
            if (changedDocument) this.resetViewState();
            this.attribution = attributeDiagnostics(report);
            this.actionTree = buildActionTree(report.actions);
        }

        this.leaveEmptyTab();
        this.renderTabs();
        this.renderFaces();
        this.applyFace();
        this.renderPanel();
    }

    /** The compiler's text report, which the host fetched on request. */
    showTextReport(text: string): void {
        this.textReport = text;
        if (this.effectiveFace() === 'text') this.applyFace();
    }

    /**
     * The element under the editor cursor, or null. Drives the Symbols tab's follow behaviour.
     *
     * A name without a model is not enough to identify a row, so it is treated as no highlight
     * rather than guessed at.
     */
    setCursorSymbol(name: string | null, model: string | null): void {
        const next = name !== null && model !== null ? { id: name, model } : null;
        if (next?.id === this.cursorSymbol?.id && next?.model === this.cursorSymbol?.model) return;
        this.cursorSymbol = next;
        if (this.tab === 'symbols' && this.effectiveFace() === 'report') this.renderPanel();
    }

    /* --------------------------------------------------------------- persistence */

    getState(): DiagnosticViewState {
        return {
            tab: this.tab,
            filters: Object.fromEntries(this.filters) as Partial<Record<DiagnosticTab, string>>,
            scroll: Object.fromEntries(this.scroll) as Partial<Record<DiagnosticTab, number>>,
            expandedMacros: [...this.expandedMacros],
            modelFocus: this.modelFocus,
            codeFocus: this.codeFocus,
            face: this.face,
            source: this.lastSource
        };
    }

    /**
     * Seed the view from a previous session.
     *
     * Called before any report arrives, so it only records intent; `show` is what acts on it.
     */
    restoreState(state: DiagnosticViewState | undefined): void {
        if (!state) return;
        if (TABS.includes(state.tab)) this.tab = state.tab;
        for (const [tab, value] of Object.entries(state.filters ?? {})) {
            this.filters.set(tab as DiagnosticTab, value);
        }
        for (const [tab, value] of Object.entries(state.scroll ?? {})) {
            this.scroll.set(tab as DiagnosticTab, value);
        }
        this.expandedMacros = new Set(state.expandedMacros ?? []);
        this.modelFocus = state.modelFocus ?? null;
        this.codeFocus = state.codeFocus ?? null;
        this.face = state.face ?? 'report';
        this.lastSource = state.source ?? null;
    }

    private resetViewState(): void {
        this.filters.clear();
        this.scroll.clear();
        this.expandedMacros.clear();
        this.modelFocus = null;
        this.codeFocus = null;
    }

    /* -------------------------------------------------------------------- chrome */

    /**
     * What is actually on screen.
     *
     * `face` is the reader's choice; this is that choice once reality is taken into account.
     * Without a structured report the only thing to show is the text — but the choice is not
     * overwritten, so a reader who was on the structured view before switching to a file the
     * compiler cannot report on lands back on it when one arrives, rather than being left in a
     * text view they never asked for.
     */
    private effectiveFace(): DiagnosticFace {
        return this.report === null ? 'text' : this.face;
    }

    private setFace(face: DiagnosticFace): void {
        if (face === this.face) return;
        this.face = face;
        this.applyFace();
        this.host.persist();
    }

    /** What the copy button hands over: whatever is on screen, in text form. */
    private copyable(): string {
        if (this.effectiveFace() === 'json') return this.raw;
        return this.textReport ?? this.raw;
    }

    private applyFace(): void {
        const face = this.effectiveFace();
        document.body.classList.toggle('diag-raw', face !== 'report');
        for (const button of Array.from(this.elements.faces.querySelectorAll<HTMLElement>('[data-face]'))) {
            button.setAttribute('aria-pressed', String(button.dataset.face === face));
        }
        if (face === 'report') return;

        if (face === 'json') {
            this.elements.output.textContent = this.raw;
            return;
        }
        if (this.textReport !== null) {
            this.elements.output.textContent = this.textReport;
            return;
        }
        // A JSON run's output is the JSON, so the text report is a second invocation. Asked for
        // only when someone actually wants it.
        this.elements.output.textContent = 'Fetching the compiler’s text report…';
        this.host.requestTextReport();
    }

    /**
     * The face selector.
     *
     * Absent when there is no structured report: the run's own output is the text report, so all
     * three buttons would show the same thing.
     */
    private renderFaces(): void {
        this.elements.faces.replaceChildren();
        if (this.report === null) return;
        for (const { face, label, title } of FACE_LABELS) {
            const button = el('button', 'diag-chip-btn', label);
            button.dataset.face = face;
            button.title = title;
            button.setAttribute('aria-pressed', String(face === this.face));
            this.elements.faces.append(button);
        }
    }

    private selectTab(tab: DiagnosticTab): void {
        if (!TABS.includes(tab) || tab === this.tab) return;
        this.scroll.set(this.tab, this.elements.panel.scrollTop);
        this.tab = tab;
        this.renderTabs();
        this.renderPanel();
        this.host.persist();
    }

    /** How many rows each tab holds. What the tab strip shows, and what greys an empty one out. */
    private counts(): Record<DiagnosticTab, number> {
        return {
            diagnostics: this.report?.diagnostics.length ?? 0,
            models: this.report?.models.length ?? 0,
            symbols: this.report?.models.reduce((n, m) => n + m.symbols.length, 0) ?? 0,
            actions: this.report?.actions.length ?? 0
        };
    }

    private renderTabs(): void {
        const counts = this.counts();
        for (const button of Array.from(this.elements.tabs.querySelectorAll<HTMLButtonElement>('[data-tab]'))) {
            const tab = button.dataset.tab as DiagnosticTab;
            const count = counts[tab];
            button.setAttribute('aria-selected', String(tab === this.tab));
            // A tab with nothing in it is greyed rather than hidden: "Problems 0" is an answer,
            // and a strip that changes width as you edit is harder to aim at than one that does
            // not. Disabled so it cannot be selected into an empty panel.
            button.disabled = count === 0;
            button.setAttribute('aria-disabled', String(count === 0));

            let badge = button.querySelector<HTMLElement>('.diag-tab-count');
            if (!badge) {
                badge = el('span', 'diag-tab-count');
                button.append(badge);
            }
            badge.textContent = String(count);
            // The one count worth emphasising, now that the summary line that used to shout
            // about it is gone.
            badge.classList.toggle('has-problems', tab === 'diagnostics' && count > 0);
        }
    }

    /**
     * Move off a tab that has nothing in it.
     *
     * Otherwise fixing the last problem while reading the problems tab would leave the reader
     * staring at an empty panel whose tab has just been greyed out.
     */
    private leaveEmptyTab(): void {
        const counts = this.counts();
        if (counts[this.tab] > 0) return;
        const somewhere = TABS.find(tab => counts[tab] > 0);
        if (somewhere) this.tab = somewhere;
    }

    /* -------------------------------------------------------------------- panels */

    private renderPanel(): void {
        const panel = this.elements.panel;
        panel.replaceChildren();
        this.elements.controlsExtra.replaceChildren();
        this.elements.filter.value = this.filters.get(this.tab) ?? '';
        if (!this.report) return;

        switch (this.tab) {
            case 'diagnostics': this.renderDiagnostics(this.report); break;
            case 'models': this.renderModels(this.report); break;
            case 'symbols': this.renderSymbols(this.report); break;
            case 'actions': this.renderActions(this.report); break;
        }

        // Restoring after the content exists, since scrollTop on an empty element is always 0.
        panel.scrollTop = this.scroll.get(this.tab) ?? 0;
    }

    private needle(): string {
        return this.filters.get(this.tab) ?? '';
    }

    /**
     * A full-width heading inside a table.
     *
     * Deliberately a row rather than a heading element between separate tables. Each group used
     * to get its own `<table>`, and separate tables size their columns independently — so the
     * same column landed at a different width under every model, which reads as broken. One
     * table for the whole tab means one set of column widths.
     */
    private groupRow(columns: number, label: string, note?: string): HTMLElement {
        const row = el('tr', 'diag-group-row');
        const cell = el('td', 'diag-group-cell', label);
        cell.colSpan = columns;
        if (note !== undefined) cell.append(el('span', 'diag-kind', note));
        row.append(cell);
        return row;
    }

    /** A row that jumps to a source position when clicked, or a plain one when there is none. */
    private locationCell(location: SourceLocation | undefined, row: HTMLElement, report: DiagnosticReport): HTMLElement {
        const cell = el('td', 'diag-loc', formatLocation(location, report.source));
        if (location) {
            row.classList.add('diag-row-link');
            row.addEventListener('click', event => {
                // A model row carries buttons of its own — census chips, links to other models,
                // the problem badge. Those have already acted by the time the click reaches the
                // row, and revealing the source on top of that would be a second, unasked-for
                // action from one click.
                if ((event.target as HTMLElement).closest('button')) return;
                this.host.revealLocation(sourceOf(location, report.source), location.line, location.column);
            });
        }
        return cell;
    }

    /* --------------------------------------------------------------- diagnostics */

    private renderDiagnostics(report: DiagnosticReport): void {
        this.renderCodeChips(report);
        if (this.modelFocus !== null) this.renderFocusChip(`in ${this.modelFocus}`, () => {
            this.modelFocus = null;
            this.renderPanel();
            this.host.persist();
        });

        const needle = this.needle();
        const inFocus = (diagnostic: Diagnostic): boolean => {
            if (this.codeFocus !== null && diagnostic.code !== this.codeFocus) return false;
            if (this.modelFocus !== null) {
                const bucket = this.attribution.byModel.get(this.modelFocus) ?? [];
                if (!bucket.includes(diagnostic)) return false;
            }
            return matches(diagnostic.message, needle) || matches(diagnostic.code ?? '', needle);
        };

        const shown = report.diagnostics.filter(inFocus);
        if (shown.length === 0) {
            const empty = report.diagnostics.length === 0
                ? 'No problems.'
                : 'No problems match the current filter.';
            this.elements.panel.append(el('div', 'diag-empty', empty));
            return;
        }

        const attributed = shown.filter(d => !this.attribution.unattributed.includes(d));
        const unattributed = shown.filter(d => this.attribution.unattributed.includes(d));

        const table = el('table', 'diag-table');
        const body = el('tbody');
        for (const diagnostic of attributed) body.append(this.diagnosticRow(diagnostic, report));
        if (unattributed.length > 0) {
            // Kept visible rather than dropped: attribution is inferred from an exact position
            // match, so a diagnostic that resolves to no model is a limit of the inference, not
            // a reason for the user to stop seeing it. The two groups always sum to the count in
            // the tab.
            // Shown even when everything is unattributed: it is the answer to "why does no
            // model show a problem count". Suppressed only when there were no models to tie
            // anything to in the first place, where it would be stating the obvious.
            if (report.models.length > 0) {
                body.append(this.groupRow(4, 'Not tied to a model', String(unattributed.length)));
            }
            for (const diagnostic of unattributed) body.append(this.diagnosticRow(diagnostic, report));
        }
        table.append(body);
        this.elements.panel.append(table);
    }

    private diagnosticRow(diagnostic: Diagnostic, report: DiagnosticReport): HTMLElement {
        const row = el('tr', 'diag-row');

        const severity = el('td');
        severity.append(el('span', `diag-badge severity-${diagnostic.severity}`, diagnostic.severity));
        row.append(severity);

        const code = el('td');
        if (diagnostic.code !== undefined) {
            code.append(el('span', 'diag-kind', diagnostic.code));
        }
        row.append(code, el('td', 'diag-message', diagnostic.message));

        // A diagnostic always names a file, even when it has no position in it.
        const location = diagnostic.line === undefined
            ? undefined
            : { source: diagnostic.source, line: diagnostic.line, column: diagnostic.column };
        row.append(this.locationCell(location, row, report));
        return row;
    }

    private renderCodeChips(report: DiagnosticReport): void {
        const codes = distinctCodes(report.diagnostics);
        for (const code of codes) {
            const chip = el('button', 'diag-code', code);
            chip.setAttribute('aria-pressed', String(this.codeFocus === code));
            chip.addEventListener('click', () => {
                this.codeFocus = this.codeFocus === code ? null : code;
                this.renderPanel();
                this.host.persist();
            });
            this.elements.controlsExtra.append(chip);
        }
    }

    private renderFocusChip(label: string, clear: () => void): void {
        const chip = el('button', 'diag-chip-btn', `${label} ✕`);
        chip.setAttribute('aria-pressed', 'true');
        chip.addEventListener('click', clear);
        this.elements.controlsExtra.append(chip);
    }

    /* --------------------------------------------------------------------- models */

    private renderModels(report: DiagnosticReport): void {
        const needle = this.needle();
        const shown = report.models.filter(m => matches(m.name, needle));
        if (shown.length === 0) {
            this.elements.panel.append(el('div', 'diag-empty', 'No models match the current filter.'));
            return;
        }
        const table = el('table', 'diag-table');
        const body = el('tbody');
        for (const model of shown) body.append(this.modelRow(model, report));
        table.append(body);
        this.elements.panel.append(table);
    }

    /**
     * One model, as a row.
     *
     * A card would give each model more room, but every other tab is a table, and a panel that
     * changes shape between tabs is harder to read than one that does not. The columns are the
     * questions the model summary answers: what kind, what it is called, what is in it, what it
     * relates to, whether anything is wrong with it, and where it is.
     */
    private modelRow(model: ModelSummary, report: DiagnosticReport): HTMLElement {
        const row = el('tr', 'diag-row');

        const kind = el('td');
        kind.append(el('span', 'diag-badge', model.kind));
        row.append(kind, el('td', 'diag-id', model.name));

        // Each count is a way in to the symbols it counts, which is the question a census
        // invites: "which three strategies?"
        const counts = el('td', 'diag-census');
        for (const { key, count } of censusEntries(model.elements)) {
            const chip = el('button', 'diag-count-chip', `${symbolKindOfCensusKey(key)} ${count}`);
            chip.addEventListener('click', () => this.focusSymbols(model.name));
            counts.append(chip);
        }
        row.append(counts);

        const relations = el('td', 'diag-relations');
        if (model.implements !== undefined) {
            relations.append(el('span', 'diag-kind', 'implements '), this.modelLink(model.implements));
        }
        // `usedBy` is guaranteed empty for a justification, so nothing is rendered rather than an
        // empty label.
        if (model.usedBy.length > 0) {
            relations.append(el('span', 'diag-kind', 'used by '));
            for (const user of model.usedBy) relations.append(this.modelLink(user.name));
        }
        if (model.aliases.length > 0) {
            relations.append(el('span', 'diag-kind', ` ${model.aliases.length} aliases`));
        }
        row.append(relations);

        const problems = el('td', 'diag-problems');
        const errors = errorCountFor(this.attribution, model);
        if (errors > 0) {
            const badge = el('button', 'diag-error-badge', `${errors} ${errors === 1 ? 'problem' : 'problems'}`);
            badge.addEventListener('click', () => {
                this.modelFocus = model.name;
                this.codeFocus = null;
                this.filters.delete('diagnostics');
                this.selectTabDirect('diagnostics');
            });
            problems.append(badge);
        }
        row.append(problems, this.locationCell(model.location, row, report));
        return row;
    }

    private modelLink(name: string): HTMLElement {
        const link = el('button', 'diag-link', name);
        link.addEventListener('click', () => {
            this.filters.set('models', name);
            this.selectTabDirect('models');
        });
        return link;
    }

    private focusSymbols(modelName: string): void {
        this.filters.set('symbols', modelName);
        this.selectTabDirect('symbols');
    }

    /** Switch tabs from a cross-link, where the destination's scroll should start at the top. */
    private selectTabDirect(tab: DiagnosticTab): void {
        this.scroll.set(this.tab, this.elements.panel.scrollTop);
        this.scroll.set(tab, 0);
        this.tab = tab;
        this.renderTabs();
        this.renderPanel();
        this.host.persist();
    }

    /* -------------------------------------------------------------------- symbols */

    private renderSymbols(report: DiagnosticReport): void {
        const needle = this.needle();
        let rendered = 0;
        let cursorRow: HTMLElement | null = null;

        // One table for every model, with the model names as full-width rows inside it. Giving
        // each model its own table let each size its columns independently, so the same column
        // sat at a different width under every heading — which reads as a broken layout rather
        // than as grouping. `diag-grouped` is what indents the rows under their model, so the
        // model name reads as a heading rather than as another row.
        const table = el('table', 'diag-table diag-grouped');
        const body = el('tbody');

        for (const model of report.models) {
            const modelMatches = matches(model.name, needle);
            const symbols = model.symbols.filter(s => modelMatches || matches(s.id, needle));
            const aliases = model.aliases.filter(a => modelMatches || matches(a.from, needle) || matches(a.to, needle));
            if (symbols.length === 0 && aliases.length === 0) continue;
            rendered += symbols.length + aliases.length;

            body.append(this.groupRow(4, model.name, model.kind));

            for (const symbol of symbols) {
                const row = this.symbolRow(symbol, report);
                if (this.cursorSymbol !== null
                    && symbol.id === this.cursorSymbol.id
                    && model.name === this.cursorSymbol.model) {
                    row.classList.add('current');
                    cursorRow ??= row;
                }
                body.append(row);
            }
            for (const alias of aliases) {
                // Italic, because an alias is not a declaration: it is an id the composition
                // rewrote. Worth telling apart from the elements around it at a glance.
                const row = el('tr', 'diag-row diag-alias');
                row.append(
                    el('td', 'diag-id', alias.from),
                    el('td', 'diag-kind', `→ ${alias.to}`),
                    el('td'),
                    el('td', 'diag-loc', 'alias')
                );
                body.append(row);
            }
        }

        if (rendered === 0) {
            this.elements.panel.append(el('div', 'diag-empty', 'No symbols match the current filter.'));
            return;
        }

        table.append(body);
        this.elements.panel.append(table);

        // Following the cursor is only useful if the row it lands on is actually on screen.
        cursorRow?.scrollIntoView({ block: 'nearest' });
    }

    private symbolRow(symbol: SymbolEntry, report: DiagnosticReport): HTMLElement {
        const row = el('tr', 'diag-row');
        row.append(el('td', 'diag-id', symbol.id), el('td', 'diag-kind', symbol.kind));

        const marker = el('td');
        // `synthesized` guarantees the absence of a location, so one field decides both cells.
        if (symbol.synthesized) marker.append(el('span', 'diag-badge synthesized', 'synthesized'));
        row.append(marker, this.locationCell(symbol.location, row, report));
        return row;
    }

    /* -------------------------------------------------------------------- actions */

    private renderActions(report: DiagnosticReport): void {
        this.renderActionControls();
        this.elements.panel.append(this.actionStats(report));
        const tree = filterActionTree(this.actionTree, this.needle());
        if (tree.length === 0) {
            const empty = report.actions.length === 0
                ? 'No commands were executed.'
                : 'No commands match the current filter.';
            this.elements.panel.append(el('div', 'diag-empty', empty));
            return;
        }
        const container = el('div', 'diag-tree');
        // A filter that matched inside a macro has already pruned away everything else under it,
        // so opening the survivors is the only way the match is visible at all.
        this.appendActionNodes(container, tree, this.needle() !== '');
        this.elements.panel.append(container);
    }

    /**
     * The report's Action Statistics, which have no tab of their own.
     *
     * Note `commands.total` is not the number of rows below it: the trace lists the steps a macro
     * expanded into, and the command count does not. Both are shown, neither is derived from the
     * other.
     */
    private actionStats(report: DiagnosticReport): HTMLElement {
        const { total, macros } = report.stats.commands;
        const line = el('div', 'diag-stats-note');
        line.append(el('span', undefined, `${total} commands`));
        if (macros > 0) line.append(el('span', undefined, `${macros} macro`));
        line.append(el('span', undefined, `${report.actions.length} steps`));
        // Deferrals mean forward references had to be retried — a hint when something did not
        // resolve, and noise at zero.
        if (report.stats.deferrals > 0) {
            line.append(el('span', 'deferrals', `${report.stats.deferrals} deferrals`));
        }
        return line;
    }

    private renderActionControls(): void {
        const expandAll = el('button', 'diag-chip-btn', 'Expand all');
        expandAll.addEventListener('click', () => {
            const collect = (nodes: readonly ActionNode[]): void => {
                for (const node of nodes) {
                    if (node.children.length > 0) this.expandedMacros.add(node.action.index);
                    collect(node.children);
                }
            };
            collect(this.actionTree);
            this.renderPanel();
            this.host.persist();
        });

        const collapseAll = el('button', 'diag-chip-btn', 'Collapse all');
        collapseAll.addEventListener('click', () => {
            this.expandedMacros.clear();
            this.renderPanel();
            this.host.persist();
        });

        this.elements.controlsExtra.append(expandAll, collapseAll);
    }

    private appendActionNodes(parent: HTMLElement, nodes: readonly ActionNode[], forceOpen: boolean): void {
        for (const node of nodes) {
            const hasChildren = node.children.length > 0;
            const open = forceOpen || this.expandedMacros.has(node.action.index);

            const row = el('div', 'diag-action');
            // The compiler's own numbering, not the array position: only one of the two is a
            // promise, and it is what makes the tree and the raw text reconcilable.
            row.append(el('span', 'diag-action-index', `${node.action.index}.`));

            const twisty = el('button', hasChildren ? 'diag-twisty' : 'diag-twisty leaf', hasChildren ? (open ? '▾' : '▸') : '·');
            if (hasChildren) {
                twisty.setAttribute('aria-expanded', String(open));
                twisty.addEventListener('click', () => {
                    if (this.expandedMacros.has(node.action.index)) this.expandedMacros.delete(node.action.index);
                    else this.expandedMacros.add(node.action.index);
                    this.renderPanel();
                    this.host.persist();
                });
            } else {
                twisty.setAttribute('aria-hidden', 'true');
            }
            row.append(twisty);

            if (node.action.macro) row.append(el('span', 'diag-action-macro', 'macro'));
            row.append(el('span', undefined, node.action.description));

            if (hasChildren && !open) {
                row.append(el('span', 'diag-hidden-count', `(${countDescendants(node)} hidden)`));
            }
            parent.append(row);

            if (hasChildren && open) {
                const children = el('div', 'diag-children');
                this.appendActionNodes(children, node.children, forceOpen);
                parent.append(children);
            }
        }
    }
}
