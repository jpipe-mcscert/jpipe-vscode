/**
 * What the run panel shows, decided without VS Code, so it is tested (jpipe-vscode ADR-VSC-0004).
 *
 * The panel and the Results view are two views of one run, the last one (jpipe-vscode
 * ADR-VSC-0031). `run-session.ts` holds that run; this decides what the panel's page is told about
 * it, what Results says while it has no report, when it stops saying what a run would, and where an
 * element of the report is written.
 */
import type { LiveStatus, Notice, Progress, RunKind, RunPanelState, RunPhase } from '../../shared/run-protocol.js';
import type { RunProgress } from './run-events.js';
import { outcomeLinks, progressRows, verdictLabel, verdictLinks, type Labels, type ResultRow, type RunReport } from './run-report.js';

/** The run the panel and the Results view show. */
export interface ShownRun {
    /** The justification, and the document it is declared in. */
    name: string;
    uri: string;
    check: boolean;
    phase: RunPhase;
    report: RunReport | null;
    /**
     * What the runner's events said, when it wrote them (ADR-VSC-0033): how far the run is while it
     * goes, and, once the report replaces it, how long each step took, which only the events say.
     */
    progress: RunProgress | null;
    /** Each element's label in the compiled model, by id: what names it before it is decided. */
    labels: Labels;
    /** The runner's SVG of the run's dataflow. */
    dataflow: string | null;
    /**
     * Whether `dataflow` is the drawing the runner made of this run before its first step, which
     * the page colours as elements are decided (ADR-VSC-0033), rather than one it drew at the end,
     * or another run's.
     */
    live: boolean;
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
        name, uri, check, phase: 'running', report: null, progress: null, labels: new Map(), live: false,
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
        progress: run.phase === 'running' && run.progress ? progressOf(run.progress, run.labels, run.live) : null,
        notice: run.notice,
        dataflow: run.dataflow,
        drawingMissing: run.drawingMissing,
        elements: report?.elements.map(e => e.id) ?? [],
        outOfDate: run.outOfDate
    };
}

/** `3 of 12 decided`. */
const decidedOf = (progress: RunProgress): string => `${progress.decided.size} of ${progress.elements.length} decided`;

/**
 * How far a run under way is, for the panel: its verdict bar names the step running by its label,
 * and, when the drawing on show is the run's own (`live`), its elements are coloured as decided.
 */
export function progressOf(progress: RunProgress, labels: Labels = new Map(), live = false): Progress {
    const running = [...progress.running.keys()];
    const one = running.length === 1 ? labels.get(running[0]) ?? running[0] : null;
    const decided = [...progress.decided.values()].map(d => d.element);
    return {
        decided: decidedOf(progress),
        counts: outcomeLinks(decided),
        running: running.length > 1 ? `${running.length} steps` : one,
        statuses: live ? decided.flatMap((e): LiveStatus[] => e.status === null ? [] : [{
            id: e.id, status: e.status, reason: e.reason, rootCause: e.status === 'skip' && e.blockedBy.length === 0,
            produced: e.produced.map(([name]) => name),
            unreachable: e.artifacts.filter(a => !a.reachable).map(a => a.declared)
        }]) : null,
        underway: running,
        pending: progress.elements.filter(id => !progress.decided.has(id) && !progress.running.has(id))
    };
}

/**
 * What the Results view lists for a run that has no report: one row saying it is under way, or
 * why it ended without one. A run with a report is listed from the report (`resultRows`).
 */
export function statusRow(run: ShownRun): ResultRow | undefined {
    if (run.phase === 'running') {
        const description = run.progress ? decidedOf(run.progress) : undefined;
        return { id: 'status', label: underWay(run.name, run.check), description, icon: 'running', children: [] };
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

/**
 * What the Results view lists for a run without a report: a run under way whose events are read
 * lists the elements as they are decided, below its status row (`progressRows`); otherwise the
 * status row alone.
 */
export function rowsWithoutReport(run: ShownRun): ResultRow[] {
    const status = statusRow(run);
    if (!status) return [];
    return run.phase === 'running' && run.progress ? [status, ...progressRows(run.progress, run.name, run.labels)] : [status];
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
 * Where to look for an element of the report, in order: a model, and the id the element has among
 * that model's own and inherited elements as the Outline lists them (`elements-tree.ts`).
 *
 * The report qualifies an element by the models it was reached through. First, the justification
 * shown, under the rest of the id: `release:e1` is its `e1`, and `release:T:slot` the `T:slot` it
 * inherits. Then the model named just before the element, which is where an operand of a
 * composition declares it: `readiness:draft:changelog` is `changelog` of `draft`.
 */
export function elementCandidates(id: string, shown: string): { model: string; element: string }[] {
    const candidates: { model: string; element: string }[] = [];
    const prefix = `${shown}:`;
    if (id.startsWith(prefix)) candidates.push({ model: shown, element: id.slice(prefix.length) });
    const parts = id.split(':');
    if (parts.length > 1) {
        const last = { model: parts.at(-2)!, element: parts.at(-1)! };
        if (!candidates.some(c => c.model === last.model && c.element === last.element)) candidates.push(last);
    }
    return candidates;
}
