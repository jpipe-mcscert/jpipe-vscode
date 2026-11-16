/**
 * What the run panel shows, decided without VS Code, so it is tested (jpipe-vscode ADR-VSC-0004).
 *
 * The panel and the Results view are two views of one run, the last one (jpipe-vscode
 * ADR-VSC-0031). `run-session.ts` holds that run; this decides what the panel's page is told about
 * it, what Results says while it has no report, when it stops saying what a run would, and where an
 * element of the report is written.
 */
import type { Notice, RunKind, RunPanelState, RunPhase } from '../../shared/run-protocol.js';
import { verdictLabel, verdictLinks, type ResultRow, type RunReport } from './run-report.js';

/** The run the panel and the Results view show. */
export interface ShownRun {
    /** The justification, and the document it is declared in. */
    name: string;
    uri: string;
    check: boolean;
    phase: RunPhase;
    report: RunReport | null;
    /** The runner's SVG of the run's dataflow. */
    dataflow: string | null;
    drawingMissing: string | null;
    /** The libraries it loaded: their paths, to tell when they change, and how the workspace names them. */
    libraries: { path: string; display: string }[];
    /** When it ended. */
    endedAt: Date | null;
    notice: Notice | null;
    outOfDate: string | null;
}

/** What a run is called wherever it is shown: an execution calls the steps, a check does not. */
export const kindOf = (check: boolean): RunKind => check ? 'check' : 'execution';

/** `Executing release…`, `Checking release…`. */
export const underWay = (name: string, check: boolean): string => `${check ? 'Checking' : 'Executing'} ${name}…`;

/** A run of `name` just started: what is shown until it ends. */
export function startedRun(
    name: string,
    uri: string,
    check: boolean,
    libraries: ShownRun['libraries'],
    previous: ShownRun | undefined
): ShownRun {
    // The last drawing of the same justification stays under the busy overlay: a run that is about
    // to redraw it is no reason to blank it. Another justification's drawing would be misleading.
    const same = previous?.name === name && previous.uri === uri;
    return {
        name, uri, check, phase: 'running', report: null,
        dataflow: same ? previous.dataflow : null,
        drawingMissing: null,
        libraries, endedAt: null, notice: null, outOfDate: null
    };
}

/** `14:02`, in the hours and minutes of the run's own clock. */
export function clockTime(date: Date): string {
    const two = (n: number) => String(n).padStart(2, '0');
    return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The page's state for `run`. */
export function panelState(run: ShownRun, revision: number): RunPanelState {
    const report = run.report;
    return {
        revision,
        name: run.name,
        check: run.check,
        phase: run.phase,
        verdict: report && {
            kind: kindOf(run.check),
            label: verdictLabel(report, run.name, run.check),
            tone: report.verdict,
            counts: verdictLinks(report),
            at: run.endedAt ? clockTime(run.endedAt) : null,
            libraries: run.libraries.map(library => library.display)
        },
        notice: run.notice,
        dataflow: run.dataflow,
        drawingMissing: run.drawingMissing,
        elements: report?.elements.map(e => e.id) ?? [],
        outOfDate: run.outOfDate
    };
}

/**
 * What the Results view lists for a run that has no report: one row saying it is under way, or
 * why it ended without one. A run with a report is listed from the report (`resultRows`).
 */
export function statusRow(run: ShownRun): ResultRow | undefined {
    if (run.phase === 'running') {
        return { id: 'status', label: underWay(run.name, run.check), icon: 'running', children: [] };
    }
    if (run.phase === 'done' || !run.notice) return undefined;
    return {
        id: 'status',
        label: run.notice.text,
        tooltip: run.notice.text,
        icon: run.phase === 'stopped' ? 'stopped' : 'error',
        children: []
    };
}

/** Something that may make the run on show say something other than a run would now. */
export type Change =
    /** A file was saved: `isModel` for a jPipe file, `display` how the workspace names it. */
    | { kind: 'saved'; path: string; display: string; isModel: boolean }
    /** The libraries checked in the Libraries view are now these. */
    | { kind: 'checked'; paths: string[] };

/**
 * Why `change` makes the run on show out of date, or `undefined` when it does not. A run under way
 * counts as well as one that ended: what changes while it runs is not what it read, and the page
 * shows the banner once it ends. A run that ended without a report has nothing to be out of date.
 *
 * Any jPipe file counts, not only the model's own: the model may load it, and telling which files
 * it loads would need the language server for a banner. A library counts when the run loaded it;
 * the libraries checked count when they are no longer the ones the run loaded.
 */
export function outOfDateReason(run: ShownRun, change: Change): string | undefined {
    if (run.phase !== 'done' && run.phase !== 'running') return undefined;
    if (change.kind === 'saved') {
        const loaded = run.libraries.some(library => library.path === change.path);
        return change.isModel || loaded ? `${change.display} changed since this ${kindOf(run.check)}.` : undefined;
    }
    const before = new Set(run.libraries.map(library => library.path));
    const same = before.size === new Set(change.paths).size && change.paths.every(path => before.has(path));
    return same ? undefined : `The libraries checked are not the ones this ${kindOf(run.check)} loaded.`;
}

/**
 * Where an element of the report is declared: the element's own name, and the model it is
 * declared in. The report names an element after the models it was reached through, innermost
 * last — `readiness:draft:changelog` is `changelog`, declared in `draft` — so the model is the
 * name before the element's. An id with no model in it names the element alone.
 */
export function elementLocation(id: string): { model: string | null; element: string } {
    const parts = id.split(':');
    const element = parts.at(-1) ?? id;
    return { model: parts.length > 1 ? parts.at(-2)! : null, element };
}
