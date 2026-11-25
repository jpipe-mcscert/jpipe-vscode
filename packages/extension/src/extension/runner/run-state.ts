/**
 * What the run panel shows, decided without VS Code, so it is tested (jpipe-vscode ADR-VSC-0004).
 *
 * The panel and the Results view are two views of one run, the last one (jpipe-vscode
 * ADR-VSC-0031). `run-session.ts` holds that run; this decides what the panel's page is told about
 * it, what Results says while it has no report, when it stops saying what a run would, and where an
 * element of the report is written.
 */
import type { Colouring, LiveStatus, Notice, Progress, RunPanelState, RunPhase } from '../../shared/run-protocol.js';
import { kindOf, underWay } from '../../shared/run-kind.js';
import type { RunProgress } from './run-events.js';
import type { LibraryStep } from './step-binding.js';
import {
    durationsOf, outcomeLinks, progressRows, resultRows, verdictLabel, verdictLinks, type Labels, type ResultRow, type RunReport
} from './run-report.js';

/**
 * The drawing of a run: the one the runner made before its first step, which the page colours as
 * elements are decided (`live`, ADR-VSC-0033), or the one it ends with (`final`); or why a run that
 * ended has none.
 */
export type Drawing =
    | { kind: 'live' | 'final'; svg: string }
    | { kind: 'missing'; reason: string };

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
    /** The runner's drawing of the run's dataflow, or why there is none; null while there is none yet. */
    drawing: Drawing | null;
    /** Where it runs, once it is launched: the paths its report and events name are relative to it. */
    cwd: string | null;
    /** The steps of the libraries it loads, as they were when it was launched: where a step's row leads. */
    steps: LibraryStep[];
    /** The libraries it loaded: their paths, to tell when they change, and how the workspace names them. */
    libraries: { path: string; display: string }[];
    /** When it ended. */
    endedAt: Date | null;
    notice: Notice | null;
    outOfDate: string | null;
    /** The development jpipe-runner the run uses, as the panel names it, or null for a release. */
    development: string | null;
}

/**
 * A run of `name` just started: what is shown until it ends. Nothing of the previous run stays, its
 * drawing included, even of the same justification: its colours and marks are another run's, and
 * a reader watching this one would take them for its own. The page keeps the framing.
 */
export function startedRun(name: string, uri: string, check: boolean, libraries: ShownRun['libraries']): ShownRun {
    return {
        name, uri, check, phase: 'running', report: null, progress: null, labels: new Map(), drawing: null,
        cwd: null, steps: [], libraries, endedAt: null, notice: null, outOfDate: null, development: null
    };
}

/**
 * A run that ended without a report, stopped or unable to go on, saying why. Its own drawing, if
 * the runner made one before the first step, stays, coloured with what it decided before it ended:
 * those are this run's results, the only ones it has.
 */
export function endedWithout(run: ShownRun, phase: 'blocked' | 'stopped', notice: Notice, at: Date): ShownRun {
    return { ...run, phase, notice, endedAt: at };
}

/** Why a run has no drawing: the runner could not draw, which is most often Graphviz missing. */
export const NO_DRAWING = 'jpipe-runner could not draw this run. Drawing needs Graphviz\'s dot command, as the preview does: run Check jPipe Installation to see whether it is installed.';

/**
 * A run that ended with its report, and the drawing the runner ended it with (`svg`), or none. This
 * is the only way a run becomes `done`, and it always replaces the drawing the run was coloured on
 * as it went: the runner's own drawing of the end puts every node where that one had it.
 */
export function endedWithReport(run: ShownRun, report: RunReport, svg: string | null, at: Date): ShownRun {
    return {
        ...run, phase: 'done', report, notice: null, endedAt: at,
        drawing: svg ? { kind: 'final', svg } : { kind: 'missing', reason: NO_DRAWING }
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
        uri: run.uri,
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
        progress: run.progress && run.phase === 'running' ? progressOf(run.progress, run.labels) : null,
        colouring: run.progress && run.drawing?.kind === 'live' ? colouringOf(run.progress) : null,
        notice: run.notice,
        dataflow: drawingOf(run),
        drawingMissing: run.drawing?.kind === 'missing' ? run.drawing.reason : null,
        // The report's, once there is one; before it, the events', so that the drawing of a run
        // under way, or stopped short of its report, selects and opens its elements too.
        elements: report?.elements.map(e => e.id) ?? [...(run.progress?.elements ?? [])],
        outOfDate: run.outOfDate,
        development: run.development
    };
}

/** `3 of 12 decided`. */
const decidedOf = (progress: RunProgress): string => `${progress.decided.size} of ${progress.elements.length} decided`;

/** The SVG of the run's drawing, whichever it is, or null when it has none. */
export function drawingOf(run: ShownRun): string | null {
    return run.drawing && run.drawing.kind !== 'missing' ? run.drawing.svg : null;
}

/**
 * How far a run under way is, for the panel: its verdict bar names the steps running by their
 * labels. The elements not decided yet are always listed, running or waiting; the page marks them
 * only on the run's own drawing, when it is sent a `colouring` too.
 */
export function progressOf(progress: RunProgress, labels: Labels = new Map()): Progress {
    const running = [...progress.running.keys()];
    return {
        decided: decidedOf(progress),
        counts: outcomeLinks([...progress.decided.values()].map(d => d.element)),
        running: running.map(id => labels.get(id) ?? id),
        underway: running,
        pending: progress.elements.filter(id => !progress.decided.has(id) && !progress.running.has(id))
    };
}

/**
 * What a run decided, to colour the drawing it made of itself as the runner will colour it when it
 * ends. A run that ended without its report keeps these colours: they are its only results.
 */
export function colouringOf(progress: RunProgress): Colouring {
    return {
        statuses: [...progress.decided.values()].flatMap(({ element: e }): LiveStatus[] => e.status === null ? [] : [{
            id: e.id, status: e.status, reason: e.reason, rootCause: e.status === 'skip' && e.blockedBy.length === 0,
            produced: e.produced.map(([name]) => name),
            unreachable: e.artifacts.filter(a => !a.reachable).map(a => a.declared)
        }]),
        observed: [...progress.observed].map(([source, reachable]) => ({ source, reachable }))
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
 * What the Results view lists for `run`, and under what title: the report's rows once it has one,
 * with how long each step took when its events said, which only they say; before it,
 * `rowsWithoutReport`. Undefined when the run has nothing to list, and the rows on show stay.
 */
export function resultsOf(run: ShownRun): { rows: ResultRow[]; title: string } | undefined {
    if (run.report) {
        const durations = run.progress ? durationsOf(run.progress) : undefined;
        return { rows: resultRows(run.report, run.name, run.check, durations), title: run.report.justification ?? run.name };
    }
    const rows = rowsWithoutReport(run);
    return rows.length > 0 ? { rows, title: run.name } : undefined;
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
