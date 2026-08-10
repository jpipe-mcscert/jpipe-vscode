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
    totalElements,
    type ActionNode,
    type Attribution
} from '../shared/diagnostic-model.js';

export type DiagnosticTab = 'diagnostics' | 'models' | 'symbols' | 'actions';

const TABS: DiagnosticTab[] = ['diagnostics', 'models', 'symbols', 'actions'];

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
    raw: boolean;
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
    stats: HTMLElement;
    tabs: HTMLElement;
    filter: HTMLInputElement;
    controlsExtra: HTMLElement;
    panel: HTMLElement;
    output: HTMLElement;
    rawToggle: HTMLElement;
    copyButton: HTMLElement;
}

/** What the view needs from outside the page. */
export interface DiagnosticViewHost {
    revealLocation(source: string, line: number, column: number): void;
    copy(text: string): void;
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
    private rawMode = false;
    /** The report the current view state belongs to. See `DiagnosticViewState.source`. */
    private lastSource: string | null = null;
    /** The element id under the editor cursor, for the Symbols tab to follow. */
    private cursorSymbol: string | null = null;

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

        this.elements.rawToggle.addEventListener('click', () => this.setRaw(!this.rawMode));
        this.elements.copyButton.addEventListener('click', () => this.host.copy(this.raw));

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
        this.elements.output.textContent = raw;

        document.body.classList.toggle('diag-no-report', report === null);
        if (report === null) {
            this.setRaw(true, { silent: true });
        } else {
            if (this.rawMode) this.setRaw(false, { silent: true });
            // A different file is a different report: carrying a filter or an expanded macro
            // across would be pointing at things that no longer exist.
            if (changedDocument) this.resetViewState();
            this.attribution = attributeDiagnostics(report);
            this.actionTree = buildActionTree(report.actions);
        }

        this.renderSummary();
        this.renderTabs();
        this.renderPanel();
    }

    /** The element under the editor cursor, or null. Drives the Symbols tab's follow behaviour. */
    setCursorSymbol(name: string | null): void {
        if (name === this.cursorSymbol) return;
        this.cursorSymbol = name;
        if (this.tab === 'symbols' && !this.rawMode) this.renderPanel();
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
            raw: this.rawMode,
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
        this.rawMode = state.raw ?? false;
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

    private setRaw(raw: boolean, options: { silent?: boolean } = {}): void {
        this.rawMode = raw;
        document.body.classList.toggle('diag-raw', raw);
        this.elements.rawToggle.setAttribute('aria-pressed', String(raw));
        if (!options.silent) this.host.persist();
    }

    private selectTab(tab: DiagnosticTab): void {
        if (!TABS.includes(tab) || tab === this.tab) return;
        this.scroll.set(this.tab, this.elements.panel.scrollTop);
        this.tab = tab;
        this.renderTabs();
        this.renderPanel();
        this.host.persist();
    }

    private renderSummary(): void {
        const stats = this.elements.stats;
        stats.replaceChildren();
        const report = this.report;
        if (!report) return;

        const stat = (className: string, value: string, label: string): void => {
            const wrap = el('span', `diag-stat ${className}`);
            wrap.append(el('strong', undefined, value), document.createTextNode(` ${label}`));
            stats.append(wrap);
        };

        const errors = report.diagnostics.length;
        if (errors === 0) stat('clean', 'No', 'problems');
        else stat('errors', String(errors), errors === 1 ? 'problem' : 'problems');

        stat('', String(report.models.length), report.models.length === 1 ? 'model' : 'models');
        stat('', String(totalElements(report)), 'elements');

        const { total, macros } = report.stats.commands;
        stat('', String(total), macros > 0 ? `commands (${macros} macro)` : 'commands');
        // Deferrals are only interesting when there were any — they mean forward references had
        // to be retried, which is a hint when something did not resolve.
        if (report.stats.deferrals > 0) stat('', String(report.stats.deferrals), 'deferrals');
    }

    private renderTabs(): void {
        const counts: Record<DiagnosticTab, number> = {
            diagnostics: this.report?.diagnostics.length ?? 0,
            models: this.report?.models.length ?? 0,
            symbols: this.report?.models.reduce((n, m) => n + m.symbols.length, 0) ?? 0,
            actions: this.report?.actions.length ?? 0
        };
        for (const button of Array.from(this.elements.tabs.querySelectorAll<HTMLElement>('[data-tab]'))) {
            const tab = button.dataset.tab as DiagnosticTab;
            button.setAttribute('aria-selected', String(tab === this.tab));
            let count = button.querySelector<HTMLElement>('.diag-tab-count');
            if (!count) {
                count = el('span', 'diag-tab-count');
                button.append(count);
            }
            count.textContent = String(counts[tab]);
        }
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

    /** A row that jumps to a source position when clicked, or a plain one when there is none. */
    private locationCell(location: SourceLocation | undefined, row: HTMLElement, report: DiagnosticReport): HTMLElement {
        const cell = el('td', 'diag-loc', formatLocation(location, report.source));
        if (location) {
            row.classList.add('diag-row-link');
            row.addEventListener('click', () => {
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

        if (attributed.length > 0) {
            this.elements.panel.append(this.diagnosticsTable(attributed, report));
        }
        if (unattributed.length > 0) {
            // Kept visible rather than dropped: attribution is inferred from an exact position
            // match, so a diagnostic that resolves to no model is a limit of the inference, not
            // a reason for the user to stop seeing it. The two groups always sum to the count in
            // the tab.
            const heading = el('div', 'diag-group-heading', 'Not tied to a model');
            heading.append(el('span', 'diag-kind', `${unattributed.length}`));
            this.elements.panel.append(heading, this.diagnosticsTable(unattributed, report));
        }
    }

    private diagnosticsTable(diagnostics: readonly Diagnostic[], report: DiagnosticReport): HTMLElement {
        const table = el('table', 'diag-table');
        const body = el('tbody');
        for (const diagnostic of diagnostics) {
            const row = el('tr', 'diag-row');

            const severity = el('td');
            severity.append(el('span', `diag-badge severity-${diagnostic.severity}`, diagnostic.severity));
            row.append(severity);

            const code = el('td');
            if (diagnostic.code !== undefined) {
                code.append(el('span', 'diag-kind', diagnostic.code));
            }
            row.append(code, el('td', undefined, diagnostic.message));

            // A diagnostic always names a file, even when it has no position in it.
            const location = diagnostic.line === undefined
                ? undefined
                : { source: diagnostic.source, line: diagnostic.line, column: diagnostic.column };
            row.append(this.locationCell(location, row, report));
            body.append(row);
        }
        table.append(body);
        return table;
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
        for (const model of shown) this.elements.panel.append(this.modelCard(model, report));
    }

    private modelCard(model: ModelSummary, report: DiagnosticReport): HTMLElement {
        const card = el('div', 'diag-card');

        const head = el('div', 'diag-card-head');
        head.append(el('span', 'diag-badge', model.kind), el('span', 'diag-card-name', model.name));
        if (model.implements !== undefined) {
            const target = model.implements;
            head.append(el('span', 'diag-kind', 'implements'), this.modelLink(target));
        }
        if (model.location) {
            const location = model.location;
            const link = el('button', 'diag-link', formatLocation(location, report.source));
            link.addEventListener('click', () => {
                this.host.revealLocation(sourceOf(location, report.source), location.line, location.column);
            });
            head.append(link);
        }
        card.append(head);

        // Each count is a way in to the symbols it counts, which is the question a census
        // invites: "which three strategies?"
        const counts = el('div', 'diag-card-row');
        for (const { key, count } of censusEntries(model.elements)) {
            const chip = el('button', 'diag-count-chip', `${symbolKindOfCensusKey(key)} ${count}`);
            chip.addEventListener('click', () => this.focusSymbols(model.name));
            counts.append(chip);
        }
        card.append(counts);

        // Guaranteed empty for a justification, so the row is absent rather than shown blank.
        if (model.usedBy.length > 0) {
            const row = el('div', 'diag-card-row');
            row.append(el('span', 'diag-label', 'used by'));
            for (const user of model.usedBy) row.append(this.modelLink(user.name));
            card.append(row);
        }

        if (model.aliases.length > 0) {
            const row = el('div', 'diag-card-row');
            row.append(el('span', 'diag-label', 'aliases'), document.createTextNode(String(model.aliases.length)));
            card.append(row);
        }

        const errors = errorCountFor(this.attribution, model);
        if (errors > 0) {
            const row = el('div', 'diag-card-row');
            const badge = el('button', 'diag-error-badge', `${errors} ${errors === 1 ? 'problem' : 'problems'}`);
            badge.addEventListener('click', () => {
                this.modelFocus = model.name;
                this.codeFocus = null;
                this.filters.delete('diagnostics');
                this.selectTabDirect('diagnostics');
            });
            row.append(badge);
            card.append(row);
        }

        return card;
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

        for (const model of report.models) {
            const modelMatches = matches(model.name, needle);
            const symbols = model.symbols.filter(s => modelMatches || matches(s.id, needle));
            const aliases = model.aliases.filter(a => modelMatches || matches(a.from, needle) || matches(a.to, needle));
            if (symbols.length === 0 && aliases.length === 0) continue;
            rendered += symbols.length + aliases.length;

            const heading = el('div', 'diag-group-heading', model.name);
            heading.append(el('span', 'diag-kind', model.kind));
            this.elements.panel.append(heading);

            const table = el('table', 'diag-table');
            const body = el('tbody');
            for (const symbol of symbols) {
                const row = this.symbolRow(symbol, report);
                if (this.cursorSymbol !== null && symbol.id === this.cursorSymbol) {
                    row.classList.add('current');
                    cursorRow ??= row;
                }
                body.append(row);
            }
            for (const alias of aliases) {
                const row = el('tr', 'diag-row');
                row.append(
                    el('td', 'diag-id', alias.from),
                    el('td', 'diag-kind', `→ ${alias.to}`),
                    el('td'),
                    el('td', 'diag-loc', 'alias')
                );
                body.append(row);
            }
            table.append(body);
            this.elements.panel.append(table);
        }

        if (rendered === 0) {
            this.elements.panel.append(el('div', 'diag-empty', 'No symbols match the current filter.'));
            return;
        }

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
