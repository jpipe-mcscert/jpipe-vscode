import * as vscode from 'vscode';
import * as path from 'node:path';
import type { LibraryStep } from './step-binding.js';
import { resultRows, stepLocation, type Durations, type ResultRow, type RowIcon, type RunReport } from './run-report.js';
import type { RunSession } from './run-session.js';
import { kindOf } from '../../shared/run-kind.js';
import { rowsWithoutReport } from './run-state.js';

export const RESULTS_VIEW_ID = 'jpipe.results';
/** Set once a run has a report, which is when the panel has something to show. */
const HAS_RESULTS = 'jpipe.hasResults';
/** A row's click, when it goes to another row or to a step. Not contributed: only rows call it. */
const ACTIVATE_ROW = 'jpipe.results.activateRow';

const ICONS: Readonly<Record<RowIcon, [codicon: string, colour?: string]>> = {
    'pass': ['pass', 'testing.iconPassed'],
    'fail': ['error', 'testing.iconFailed'],
    'skip': ['circle-slash', 'testing.iconSkipped'],
    'not-run': ['circle-outline', 'testing.iconUnset'],
    'error': ['error', 'list.errorForeground'],
    'warning': ['warning', 'list.warningForeground'],
    'info': ['info'],
    'fix': ['lightbulb'],
    'frame': ['debug-stackframe'],
    'step': ['symbol-method'],
    'file': ['file'],
    'missing-file': ['warning', 'list.warningForeground'],
    'value': ['symbol-variable'],
    'consumes': ['arrow-right'],
    'supports': ['arrow-up'],
    'blocked': ['circle-slash'],
    'running': ['loading~spin'],
    // Not `not-run`'s circle: waiting for its turn is not having been left out of a run.
    'waiting': ['clock'],
    'stopped': ['debug-stop']
};

/** A run as its rows need it, to open what they name: known as soon as it is launched. */
export interface RunContext {
    /** Where the run ran: the report's paths are relative to it. */
    cwd: string;
    /** The steps of the libraries the run loaded. */
    steps: LibraryStep[];
}

/** A run, as the view needs it. */
export interface RunResult extends RunContext {
    report: RunReport;
    /** The model run, for a report that does not name it. */
    name: string;
    /** Whether it was a check: the libraries validated against the model, and no step called. */
    check: boolean;
    /** The terminal the runner printed in. */
    showOutput: () => void;
    /** How long each element's step took, when the run's events said. */
    durations?: Durations;
}

/**
 * The Results view, in the bottom panel: what the last run concluded, from jpipe-runner's JSON
 * report (jpipe-vscode ADR-VSC-0029). `run-report.ts` decides the rows; this shows them and makes
 * them clickable: a file opens, a traceback frame opens at its line, a step opens at its function,
 * and "supports" or "stopped it" goes to that element's row.
 *
 * It lists the run the run panel draws, and comes forward with it (jpipe-vscode ADR-VSC-0031):
 * while the run has no report, it says in one row that it is under way, or why it ended without
 * one. A run under way whose events are read lists its elements as they are decided, below that
 * row (jpipe-vscode ADR-VSC-0033). Selecting an element here selects its node there, and a node clicked there selects its row
 * here.
 */
export class ResultsView implements vscode.TreeDataProvider<ResultRow>, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<undefined>();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    private readonly selectEmitter = new vscode.EventEmitter<string | null>();
    /** The element whose row is selected, or null when the selection is no element's row. */
    readonly onDidSelectElement = this.selectEmitter.event;

    private readonly view: vscode.TreeView<ResultRow>;
    private readonly disposables: vscode.Disposable[] = [];
    private result: RunResult | undefined;
    /** The run under way, for its rows to open what they name before there is a report. */
    private live: RunContext | undefined;
    private rows: ResultRow[] = [];
    private readonly parents = new Map<ResultRow, ResultRow | undefined>();
    private readonly byId = new Map<string, ResultRow>();

    constructor(private readonly session: RunSession) {
        this.view = vscode.window.createTreeView(RESULTS_VIEW_ID, { treeDataProvider: this });
        this.disposables.push(
            session.onDidChange(() => this.followSession()),
            this.view,
            this.changeEmitter,
            this.selectEmitter,
            vscode.commands.registerCommand(ACTIVATE_ROW, (id: string) => this.activate(id)),
            this.view.onDidChangeSelection(e => this.selectEmitter.fire(elementOf(e.selection[0])))
        );
    }

    /** Show a run's report, and bring the view forward without taking the focus. */
    async show(result: RunResult): Promise<void> {
        this.result = result;
        this.live = undefined;
        this.setRows(resultRows(result.report, result.name, result.check, result.durations),
            result.report.justification ?? result.name, result.check);
        await this.bringForward();
    }

    /**
     * Bring the view forward without taking the focus, as the run panel comes forward: the two show
     * one run. Revealing the first row is what shows a view without focusing it.
     */
    async bringForward(): Promise<void> {
        await vscode.commands.executeCommand('setContext', HAS_RESULTS, true);
        const first = this.rows[0];
        if (first) await this.view.reveal(first, { select: false, focus: false });
    }

    /** The run just launched: what its rows open before it has a report. */
    attach(context: RunContext): void {
        this.live = context;
    }

    /** A run with no report yet, or none at all, is listed from its events, or as one row saying so. */
    private followSession(): void {
        const run = this.session.run;
        const rows = run ? rowsWithoutReport(run) : [];
        if (!run || rows.length === 0) return;
        this.result = undefined;
        this.setRows(rows, run.name, run.check);
    }

    private setRows(rows: ResultRow[], name: string, check: boolean): void {
        this.rows = rows;
        this.parents.clear();
        this.byId.clear();
        const index = (row: ResultRow, parent: ResultRow | undefined): void => {
            this.parents.set(row, parent);
            this.byId.set(row.id, row);
            for (const child of row.children) index(child, row);
        };
        for (const row of this.rows) index(row, undefined);
        // A valid check is not an execution that passed: say which this is.
        this.view.description = `${name} · ${kindOf(check)}`;
        this.changeEmitter.fire(undefined);
    }

    /**
     * Bring the view forward, on the row `id` when there is one: a count of the run panel's verdict
     * opens its group, and a node clicked there selects its element's row. A node's click leaves the
     * focus in the panel (`focus` false), where the second click of a double click lands.
     */
    async reveal(id: string | null, focus = true): Promise<void> {
        const row = id === null ? undefined : this.byId.get(id);
        if (!row) {
            await vscode.commands.executeCommand(`${RESULTS_VIEW_ID}.focus`);
            return;
        }
        await this.view.reveal(row, { select: true, focus, expand: true });
    }

    /** The terminal of the run on show, where its steps printed, whether it has a report or not. */
    showOutput(): void {
        if (this.result) this.result.showOutput();
        else this.session.showOutput();
    }

    getChildren(row?: ResultRow): ResultRow[] {
        return row ? row.children : this.rows;
    }

    getParent(row: ResultRow): ResultRow | undefined {
        return this.parents.get(row);
    }

    getTreeItem(row: ResultRow): vscode.TreeItem {
        const item = new vscode.TreeItem(row.label, collapsibleState(row));
        item.id = row.id;
        item.description = row.description;
        item.tooltip = row.tooltip;
        if (row.icon) {
            const [codicon, colour] = ICONS[row.icon];
            item.iconPath = new vscode.ThemeIcon(codicon, colour ? new vscode.ThemeColor(colour) : undefined);
        }
        const context = this.result ?? this.live;
        if (row.open && context) {
            const file = vscode.Uri.file(path.resolve(context.cwd, row.open.path));
            const line = (row.open.line ?? 1) - 1;
            item.command = {
                command: 'vscode.open',
                title: 'Open',
                arguments: [file, row.open.line === undefined ? {} : { selection: new vscode.Range(line, 0, line, 0) }]
            };
            // The file's own icon, from the user's icon theme, unless the row says something is wrong.
            if (row.icon === 'file') {
                item.resourceUri = file;
                item.iconPath = vscode.ThemeIcon.File;
            }
        } else if (row.step || row.goTo) {
            item.command = { command: ACTIVATE_ROW, title: 'Go to', arguments: [row.id] };
        }
        return item;
    }

    private async activate(id: string): Promise<void> {
        const row = this.byId.get(id);
        const context = this.result ?? this.live;
        if (!row || !context) return;
        if (row.goTo) {
            const target = this.byId.get(row.goTo);
            if (target) await this.view.reveal(target, { select: true, focus: true, expand: true });
            return;
        }
        const location = row.step && stepLocation(row.step, context.steps);
        if (!location) {
            void vscode.window.showInformationMessage(`${row.step} is not in a library of the Libraries view.`);
            return;
        }
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(location.libraryUri),
            { selection: new vscode.Range(location.line, 0, location.line, 0) });
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
    }
}

/** The element a row is about, when the row is an element's own: `element/‹id›`. */
function elementOf(row: ResultRow | undefined): string | null {
    const prefix = 'element/';
    return row?.id.startsWith(prefix) && !row.id.includes('/', prefix.length) ? row.id.slice(prefix.length) : null;
}

function collapsibleState(row: ResultRow): vscode.TreeItemCollapsibleState {
    if (row.children.length === 0) return vscode.TreeItemCollapsibleState.None;
    return row.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
}
