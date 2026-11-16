/**
 * What a run concluded, as the Results view lists it. No VS Code, so it is tested.
 *
 * The input is jpipe-runner's JSON report (its `docs/report-schema.md`, jpipe-runner ADR-0011),
 * a versioned contract: within major version 1, fields are only added, so unknown fields are
 * ignored and missing ones read as empty. The runner's text report is never parsed.
 *
 * The output is a list, not the argument's shape: an evidence may support several strategies, so
 * a tree of supports would repeat it. Each element appears once, grouped by how it ended, and
 * says in words what it supports and what stopped it (jpipe-vscode ADR-VSC-0029).
 */
import type { LibraryStep } from './step-binding.js';

export type Status = 'pass' | 'fail' | 'skip' | null;
export type Verdict = 'pass' | 'fail' | 'skip' | 'invalid' | 'valid';

export interface Artifact {
    path: string;
    reachable: boolean;
    size: number | null;
}

export interface Frame {
    file: string;
    line: number;
    function: string;
    code: string;
}

export interface Traceback {
    exception: string;
    message: string;
    frames: Frame[];
    cause: Traceback | null;
}

export interface ReportDiagnostic {
    code: string;
    severity: 'error' | 'warning' | 'info';
    element: string | null;
    message: string;
    fix: string | null;
    traceback: Traceback | null;
}

export interface ReportElement {
    id: string;
    label: string;
    kind: string;
    supports: string[];
    status: Status;
    reason: string | null;
    blockedBy: string[];
    ran: boolean;
    boundTo: string | null;
    observes: string[];
    consumes: string[];
    /** Each produced variable, as text. */
    produced: [name: string, value: string][];
    artifacts: Artifact[];
}

export interface RunReport {
    justification: string | null;
    verdict: Verdict;
    elements: ReportElement[];
    diagnostics: ReportDiagnostic[];
    /** Where the runner drew the dataflow (`--dataflow`), or null when it drew nothing. */
    dataflow: string | null;
}

/** The report's major version this reads. */
const MAJOR = '1';
/** How much of a produced value a row shows. */
const VALUE_WIDTH = 80;

const text = (value: unknown, otherwise = ''): string => typeof value === 'string' ? value : otherwise;
const textOrNull = (value: unknown): string | null => typeof value === 'string' ? value : null;
const texts = (value: unknown): string[] => Array.isArray(value) ? value.filter(v => typeof v === 'string') : [];
const objects = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter(v => typeof v === 'object' && v !== null) : [];
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
    allowed.find(a => a === value);

function producedValue(raw: unknown): string {
    const value = raw as { value?: unknown; repr?: unknown } | null;
    const shown = typeof value?.repr === 'string' ? value.repr : JSON.stringify(value?.value ?? null);
    return shown.length > VALUE_WIDTH ? `${shown.slice(0, VALUE_WIDTH - 1)}…` : shown;
}

function traceback(raw: unknown): Traceback | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const t = raw as Record<string, unknown>;
    return {
        exception: text(t.exception),
        message: text(t.message),
        frames: objects(t.frames).map(f => ({
            file: text(f.file),
            line: typeof f.line === 'number' ? f.line : 1,
            function: text(f.function),
            code: text(f.code)
        })),
        cause: traceback(t.cause)
    };
}

function element(e: Record<string, unknown>): ReportElement {
    return {
        id: text(e.id),
        label: text(e.label),
        kind: text(e.kind),
        supports: texts(e.supports),
        status: oneOf(e.status, ['pass', 'fail', 'skip'] as const) ?? null,
        reason: textOrNull(e.reason),
        blockedBy: texts(e.blocked_by),
        ran: e.ran === true,
        boundTo: textOrNull(e.bound_to),
        observes: texts(e.observes),
        consumes: texts(e.consumes),
        produced: Object.entries((e.produced ?? {}) as Record<string, unknown>)
            .map(([name, value]) => [name, producedValue(value)]),
        artifacts: objects(e.artifacts).map(a => ({
            path: text(a.path),
            reachable: a.reachable === true,
            size: typeof a.size === 'number' ? a.size : null
        }))
    };
}

/** The report in `content`, or why it cannot be shown. */
export function parseReport(content: string): { report: RunReport } | { problem: string } {
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(content);
    } catch {
        return { problem: 'the runner\'s report is not JSON' };
    }
    if (typeof raw !== 'object' || raw === null) return { problem: 'the runner\'s report is not a JSON object' };
    const version = text(raw.schema_version);
    if (version.split('.')[0] !== MAJOR) {
        return { problem: `the runner's report is in version ${version || '(none)'}, and this extension reads version ${MAJOR}` };
    }
    const verdict = oneOf(raw.verdict, ['pass', 'fail', 'skip', 'invalid', 'valid'] as const);
    if (!verdict) return { problem: 'the runner\'s report has no verdict' };
    return {
        report: {
            justification: textOrNull(raw.justification),
            verdict,
            elements: objects(raw.elements).map(element),
            diagnostics: objects(raw.diagnostics).map(d => ({
                code: text(d.code),
                severity: oneOf(d.severity, ['error', 'warning', 'info'] as const) ?? 'error',
                element: textOrNull(d.element),
                message: text(d.message),
                fix: textOrNull(d.fix),
                traceback: traceback(d.traceback)
            })),
            dataflow: textOrNull(raw.dataflow)
        }
    };
}

/** What a row is, which decides its icon. */
export type RowIcon =
    | 'pass' | 'fail' | 'skip' | 'not-run'
    | 'error' | 'warning' | 'info' | 'fix' | 'frame'
    | 'step' | 'file' | 'missing-file' | 'value' | 'consumes' | 'supports' | 'blocked'
    | 'running' | 'stopped';

/** A row of the Results view. */
export interface ResultRow {
    /** Unique in the tree, and the same from one run to the next, so expansion is kept. */
    id: string;
    label: string;
    description?: string;
    tooltip?: string;
    icon?: RowIcon;
    /** Whether its children show without a click. */
    expanded?: boolean;
    children: ResultRow[];
    /** A file to open on click, relative to where the run ran unless absolute; `line` counts from 1. */
    open?: { path: string; line?: number };
    /** The step to open on click, as the runner names it: `module.function`. */
    step?: string;
    /** The id of the element row to go to on click. */
    goTo?: string;
}

/** How a problem's severity ranks: an element with an error and a warning shows the error. */
const SEVERITIES = ['error', 'warning', 'info'] as const;

const VERDICTS: Readonly<Record<Verdict, { says: string; icon: RowIcon }>> = {
    pass: { says: 'passed', icon: 'pass' },
    fail: { says: 'failed', icon: 'fail' },
    skip: { says: 'was skipped', icon: 'skip' },
    invalid: { says: 'could not be run', icon: 'error' },
    valid: { says: 'is valid', icon: 'pass' }
};

const GROUPS: readonly { status: Status; title: string; icon: RowIcon }[] = [
    { status: 'fail', title: 'Failed', icon: 'fail' },
    { status: 'skip', title: 'Skipped', icon: 'skip' },
    { status: 'pass', title: 'Passed', icon: 'pass' },
    { status: null, title: 'Not run', icon: 'not-run' }
];

/** The outcomes the verdict counts, in the order it says them. */
const OUTCOMES: readonly [status: Status, says: string][] = [
    ['pass', 'passed'], ['fail', 'failed'], ['skip', 'skipped'], [null, 'not run']
];

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `187 B`, `1.2 kB`, `3.4 MB`. */
export function fileSize(bytes: number): string {
    if (bytes < 1000) return `${bytes} B`;
    if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Whether no step was called: a check, or a run that validation, an import or the model stopped. */
const nothingRan = (report: RunReport): boolean => report.elements.every(e => e.status === null);

/**
 * `release failed`, and beside it `1 passed · 1 failed · 2 skipped`. When no step was called there
 * is no outcome to count, and the problems are counted instead: `release is valid`, `2 warnings`.
 * A `check` that found errors says `is not valid`, where a run says `could not be run`.
 */
export function verdictRow(report: RunReport, name: string, check = false): ResultRow {
    return {
        id: 'verdict',
        label: verdictLabel(report, name, check),
        description: verdictCounts(report).join(' · ') || undefined,
        icon: VERDICTS[report.verdict].icon,
        children: []
    };
}

export function verdictLabel(report: RunReport, name: string, check = false): string {
    const says = check && report.verdict === 'invalid' ? 'is not valid' : VERDICTS[report.verdict].says;
    return `${report.justification ?? name} ${says}`;
}

/** The counts beside the verdict, leaving out those that are zero. */
function verdictCounts(report: RunReport): string[] {
    const counts: string[] = [];
    if (nothingRan(report)) {
        for (const severity of ['error', 'warning'] as const) {
            const n = report.diagnostics.filter(d => d.severity === severity).length;
            if (n > 0) counts.push(plural(n, severity));
        }
    } else {
        for (const [status, says] of OUTCOMES) {
            const n = report.elements.filter(e => e.status === status).length;
            if (n > 0) counts.push(`${n} ${says}`);
        }
    }
    return counts;
}

/** The problems about no listed element: why nothing ran, most often. */
function generalProblems(report: RunReport): ReportDiagnostic[] {
    const listed = new Set(report.elements.map(e => e.id));
    return report.diagnostics.filter(d => d.element === null || !listed.has(d.element));
}

/**
 * The verdict's counts, each with the row of the Results view it opens: `2 failed` opens the
 * Failed group. When no step was called, the problems are counted, and open the Problems group
 * when some are about no element, With problems otherwise. Problems about no element are counted
 * after a run too, since no node of a diagram can show them.
 */
export function verdictLinks(report: RunReport): { text: string; row: string }[] {
    const general = generalProblems(report);
    if (nothingRan(report)) {
        const row = general.length > 0 ? 'problems' : 'group/With problems';
        return verdictCounts(report).map(text => ({ text, row }));
    }
    const links = OUTCOMES.flatMap(([status, says]) => {
        const n = report.elements.filter(e => e.status === status).length;
        const group = GROUPS.find(g => g.status === status)!;
        return n > 0 ? [{ text: `${n} ${says}`, row: `group/${group.title}` }] : [];
    });
    if (general.length > 0) links.push({ text: plural(general.length, 'problem'), row: 'problems' });
    return links;
}

function tracebackRows(id: string, trace: Traceback): ResultRow[] {
    const frames = trace.frames.map((frame, i): ResultRow => ({
        id: `${id}/frame${i}`,
        label: `${frame.file}:${frame.line}`,
        description: frame.code || frame.function,
        tooltip: `in ${frame.function}\n${frame.code}`,
        icon: 'frame',
        children: [],
        open: { path: frame.file, line: frame.line }
    }));
    return trace.cause ? [...tracebackRows(`${id}/cause`, trace.cause), ...frames] : frames;
}

function diagnosticRow(id: string, diagnostic: ReportDiagnostic): ResultRow {
    const children: ResultRow[] = [];
    if (diagnostic.fix) {
        children.push({ id: `${id}/fix`, label: diagnostic.fix, tooltip: diagnostic.fix, icon: 'fix', children: [] });
    }
    if (diagnostic.traceback) children.push(...tracebackRows(id, diagnostic.traceback));
    return {
        id,
        label: diagnostic.message,
        description: diagnostic.code,
        tooltip: `${diagnostic.code}: ${diagnostic.message}`,
        icon: diagnostic.severity,
        expanded: true,
        children
    };
}

/** A file a step observed: one that could be read opens with a click. */
function artifactRow(id: string, a: Artifact): ResultRow {
    if (!a.reachable) {
        return { id, label: a.path, description: 'could not be read', icon: 'missing-file', children: [] };
    }
    const description = a.size === null ? 'observed' : `observed · ${fileSize(a.size)}`;
    return { id, label: a.path, description, icon: 'file', children: [], open: { path: a.path } };
}

function elementRow(e: ReportElement, report: RunReport): ResultRow {
    const id = `element/${e.id}`;
    const labelOf = (other: string): string => report.elements.find(x => x.id === other)?.label || other;
    const link = (role: 'supports' | 'blocked', says: string) => (other: string, i: number): ResultRow => ({
        // By position: a report that names an element twice must not give two rows one id.
        id: `${id}/${role}${i}`,
        label: labelOf(other),
        description: says,
        tooltip: other,
        icon: role,
        children: [],
        goTo: `element/${other}`
    });

    const problems = report.diagnostics.filter(d => d.element === e.id);
    const children: ResultRow[] = problems.map((d, i) => diagnosticRow(`${id}/diagnostic${i}`, d));
    children.push(...e.blockedBy.map(link('blocked', 'stopped it')));
    if (e.boundTo) {
        children.push({ id: `${id}/step`, label: e.boundTo, description: 'step', icon: 'step', children: [], step: e.boundTo });
    }
    // What was observed when its step ran; what would be, when it did not.
    if (e.ran) {
        children.push(...e.artifacts.map((a, i) => artifactRow(`${id}/artifact${i}`, a)));
    } else {
        children.push(...e.observes.map((path, i): ResultRow =>
            ({ id: `${id}/observes${i}`, label: path, description: 'observes', icon: 'file', children: [] })));
    }
    children.push(
        ...e.consumes.map((name, i): ResultRow =>
            ({ id: `${id}/consumes${i}`, label: name, description: 'consumes', icon: 'consumes', children: [] })),
        ...e.produced.map(([name, value]): ResultRow =>
            ({ id: `${id}/produced/${name}`, label: `${name} = ${value}`, description: 'produced', icon: 'value', children: [] })),
        ...e.supports.map(link('supports', 'supports'))
    );

    const note = e.blockedBy.length > 0 ? `stopped by ${e.blockedBy.map(labelOf).join(', ')}` : e.reason;
    return {
        id,
        label: e.label || e.id,
        description: note ? `${e.kind} · ${note}` : e.kind,
        tooltip: [`${e.kind} ${e.id}`, e.label, e.reason].filter(Boolean).join('\n'),
        icon: elementIcon(e, problems),
        expanded: e.status === 'fail' || (e.status === null && problems.length > 0),
        children
    };
}

function elementIcon(e: ReportElement, problems: readonly ReportDiagnostic[]): RowIcon {
    // With no outcome, what there is to say about an element is its worst problem.
    const worst = e.status === null ? SEVERITIES.find(s => problems.some(p => p.severity === s)) : undefined;
    return worst ?? GROUPS.find(g => g.status === e.status)!.icon;
}

function groupRow(title: string, elements: readonly ReportElement[], report: RunReport, expanded: boolean): ResultRow {
    return {
        id: `group/${title}`,
        label: title,
        description: String(elements.length),
        expanded,
        children: elements.map(e => elementRow(e, report))
    };
}

/**
 * The rows of a report: the verdict, the problems that are about no listed element (why nothing
 * ran, most often), then the elements by outcome, failures first. Within a group the order is the
 * report's own, each element after those that support it.
 *
 * When no step was called — a check (`--dry-run`), or a run stopped before it began — no element
 * has an outcome, and they are grouped by whether a problem is about them instead.
 */
export function resultRows(report: RunReport, name: string, check = false): ResultRow[] {
    const general = generalProblems(report);
    const rows: ResultRow[] = [verdictRow(report, name, check)];
    if (general.length > 0) {
        rows.push({
            id: 'problems',
            label: 'Problems',
            description: String(general.length),
            expanded: true,
            children: general.map((d, i) => diagnosticRow(`problems/${i}`, d))
        });
    }
    if (nothingRan(report)) {
        const flagged = new Set(report.diagnostics.map(d => d.element));
        for (const [title, wanted] of [['With problems', true], ['No problem', false]] as const) {
            const elements = report.elements.filter(e => flagged.has(e.id) === wanted);
            if (elements.length > 0) rows.push(groupRow(title, elements, report, true));
        }
        return rows;
    }
    const failed = report.elements.some(e => e.status === 'fail');
    for (const group of GROUPS) {
        const elements = report.elements.filter(e => e.status === group.status);
        // What passed is not what a failed run is opened for.
        if (elements.length > 0) rows.push(groupRow(group.title, elements, report, group.status !== 'pass' || !failed));
    }
    return rows;
}

/** A sentence for the run as a whole, for a notification: `release failed: 1 failed, 2 skipped.` */
export function verdictSentence(report: RunReport, name: string, check = false): string {
    const label = verdictLabel(report, name, check);
    const counts = verdictCounts(report);
    return counts.length > 0 ? `${label}: ${counts.join(', ')}.` : `${label}.`;
}

/**
 * Where the step the runner calls `module.function` is written, among the libraries of the run.
 * The runner names a library's module after its file; two libraries with the same file name and
 * function are told apart by nothing in the report, and the first is given.
 */
export function stepLocation(boundTo: string, steps: readonly LibraryStep[]): { libraryUri: string; line: number } | undefined {
    const cut = boundTo.lastIndexOf('.');
    if (cut < 0) return undefined;
    const module = boundTo.slice(0, cut).split('.').pop();
    const functionName = boundTo.slice(cut + 1);
    const step = steps.find(s => s.functionName === functionName
        && decodeURIComponent(s.libraryUri).endsWith(`/${module}.py`));
    return step && { libraryUri: step.libraryUri, line: step.line };
}

/**
 * `--report PATH`, before the runner's other arguments; `--dry-run` for a check, which validates
 * the libraries against the justification and calls no step; and `--dataflow PATH` when the run is
 * to be drawn (jpipe-runner ADR-0022), which a check draws too, from what the steps declare. The
 * file's suffix is its format.
 *
 * Only the dataflow view is asked for. It is the argument as the compiler draws it, with each
 * element's status over it once steps ran, plus the files and values the steps declare; the
 * runner's other view, the argument alone, is what the preview already shows (ADR-VSC-0031).
 */
export function withReport(runnerArgs: readonly string[], report: string, check = false, dataflow?: string): string[] {
    return [
        ...(check ? ['--dry-run'] : []),
        '--report', report,
        ...(dataflow ? ['--dataflow', dataflow] : []),
        ...runnerArgs
    ];
}
