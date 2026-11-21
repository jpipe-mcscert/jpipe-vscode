/**
 * The message contract between the run panel's extension side and its webview.
 *
 * Types only — this module is imported by both the extension-host bundle and the browser bundle,
 * so it must pull in neither `vscode` nor the DOM (jpipe-vscode ADR-VSC-0005).
 *
 * The page is built once, like the preview's, and everything it shows arrives as one `state`
 * message: the panel shows the last run only, so there is never more than one thing to say.
 */

/** What the panel is showing a run in: under way, ended with a report, stopped short of one, or not started. */
export type RunPhase = 'running' | 'done' | 'stopped' | 'blocked';

/** What the verdict says, for its glyph and hue. */
export type Tone = 'pass' | 'fail' | 'skip' | 'invalid' | 'valid';

/** A count in the verdict bar, and the Results row it opens: `2 failed` opens `group/Failed`. */
export interface VerdictCount {
    text: string;
    row: string;
}

/** The commands a notice may offer. The host decides what each does. */
export type NoticeAction = 'showLibraries' | 'fixEnvironment' | 'showProblems' | 'checkInstallation' | 'showOutput';

/** Why the panel has no run to show, or what went wrong with it, and the one thing to do about it. */
export interface Notice {
    text: string;
    action: { label: string; id: NoticeAction } | null;
}

/** What was done: an execution calls the steps, a check only validates the libraries against the model. */
export type RunKind = 'execution' | 'check';

export interface Verdict {
    /** Said before the verdict, so a valid check is never read as an execution that passed. */
    kind: RunKind;
    /** `release failed`, `release is valid`. */
    label: string;
    tone: Tone;
    counts: VerdictCount[];
    /** When it ended, `14:02`, or null when that is not known. */
    at: string | null;
    /** The libraries the run loaded, as the workspace names them. */
    libraries: string[];
}

/** How far a run under way is, from the events jpipe-runner writes as it goes (ADR-VSC-0033). */
export interface Progress {
    /** `3 of 12 decided`. */
    decided: string;
    /** The outcomes so far, each opening its group in Results. */
    counts: VerdictCount[];
    /** The step under way, by its element's label, or `2 steps` when several are; null between steps. */
    running: string | null;
}

/** Everything the page shows. */
export interface RunPanelState {
    /** Newer states have higher numbers, and the page drops anything older than what it shows. */
    revision: number;
    /** The justification the panel is about. */
    name: string;
    check: boolean;
    phase: RunPhase;
    /** Set once a run has a report. */
    verdict: Verdict | null;
    /** How far the run is, while it is under way and its events are read; null otherwise. */
    progress: Progress | null;
    notice: Notice | null;
    /**
     * The runner's SVG of the run's dataflow, its argument with the files and values its steps
     * declare and, once steps ran, each element's status. Null when it drew none.
     */
    dataflow: string | null;
    /** Why there is no drawing although the run ended, when that is known. */
    drawingMissing: string | null;
    /** The ids of the report's elements: the nodes a click selects. */
    elements: string[];
    /** Why the run on show no longer says what a run would, or null while it does. */
    outOfDate: string | null;
}

export type HostToRunPanel =
    | { type: 'state'; state: RunPanelState }
    /** An element selected in the Results view, or null when the selection is no element. */
    | { type: 'select'; element: string | null }
    /** Settings the page needs. Sent on `ready` and again whenever they change. */
    | { type: 'config'; zoomSensitivity: number };

export type RunPanelToHost =
    /** The page is listening: the host replays the state. */
    | { type: 'ready' }
    | { type: 'run' }
    | { type: 'check' }
    | { type: 'stop' }
    /** Open the Results view, on a row when one is named. */
    | { type: 'results'; row: string | null }
    | { type: 'output' }
    /** An element's node was selected: select its row in Results. Null when the selection was cleared. */
    | { type: 'select'; element: string | null }
    /** A node was double-clicked: open the element in its `.jd` file. */
    | { type: 'open'; element: string }
    /** Save the drawing. */
    | { type: 'download' }
    | { type: 'action'; id: NoticeAction };
