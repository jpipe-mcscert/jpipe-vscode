/**
 * A run as it goes: the events jpipe-runner writes with `--events PATH` (jpipe-runner ADR-0030,
 * its `docs/events.md`), read from the file while the runner appends to it. No VS Code, so it is
 * tested (jpipe-vscode ADR-VSC-0004, ADR-VSC-0033).
 *
 * The events preview the report, which stays the authority: what is read here is shown while the
 * run goes, and the report replaces it when the run ends. An element in an event is the report's
 * element, so `run-report.ts` parses both.
 *
 * The file is JSON Lines. The runner writes each line whole and flushes it, but a reader may see
 * the last one half-written, so only lines that end with `\n` are read. Events and fields this does
 * not know are ignored, as the events' versioning asks; a stream of another major version is not
 * read at all.
 */
import { open } from 'node:fs/promises';
import { parseDiagnostics, parseElement, type ReportDiagnostic, type ReportElement } from './run-report.js';

/** The events' major version this reads. Within it, events and fields are only ever added. */
const MAJOR = '1';

/** An element the run has decided. */
export interface DecidedElement {
    element: ReportElement;
    diagnostics: ReportDiagnostic[];
    /** How long its step took, from `element.started` to `element.decided`; null when it did not start. */
    durationMs: number | null;
}

/** What the events have said so far. */
export interface RunProgress {
    /** Every element's id, each after those that support it, as the report lists them. */
    elements: readonly string[];
    /**
     * The elements whose step is under way, each with when it started, in milliseconds since the
     * stream opened. Several may be, once the runner calls independent steps together
     * (jpipe-runner#174).
     */
    running: ReadonlyMap<string, number>;
    /** The elements decided, by id. */
    decided: ReadonlyMap<string, DecidedElement>;
    /**
     * The sources observed so far, as the elements' `sources` name them (`source.observed`), each
     * with whether it was reached: false as soon as one element could not reach it. They are
     * observed before the step that observes them is called, so before its element is decided.
     */
    observed: ReadonlyMap<string, boolean>;
    /** What validation reported, once it is over. */
    validation: { passed: boolean; diagnostics: ReportDiagnostic[] } | null;
    /**
     * Where the runner drew the run's dataflow before its first step, every element without a
     * status (`diagram.drawn`, jpipe-runner ADR-0032): a temporary file, deleted once the run has
     * ended, so read as soon as it is announced. Null until then, and for a run that drew none.
     */
    preview: string | null;
    /** Whether the run has ended: its report is then written. */
    ended: boolean;
}

/** Why a stream is not read. */
export interface StreamProblem {
    problem: string;
}

const texts = (value: unknown): string[] => Array.isArray(value) ? value.filter(v => typeof v === 'string') : [];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** A stream that starts: every element, and nothing decided; or why it is not read. */
function startedRun(event: Record<string, unknown>): RunProgress | StreamProblem {
    const version = typeof event.schema_version === 'string' ? event.schema_version : '';
    if (version.split('.')[0] !== MAJOR) {
        return { problem: `jpipe-runner wrote its events in version ${version || '(none)'}, and this extension reads version ${MAJOR}` };
    }
    return {
        elements: texts(event.elements), running: new Map(), decided: new Map(), observed: new Map(),
        validation: null, preview: null, ended: false
    };
}

/** `progress` once an element is decided, `at` milliseconds into the stream. */
function decidedElement(progress: RunProgress, event: Record<string, unknown>, at: number): RunProgress {
    if (!isObject(event.element)) return progress;
    const element = parseElement(event.element);
    const started = progress.running.get(element.id);
    const running = new Map(progress.running);
    running.delete(element.id);
    const decided = new Map(progress.decided).set(element.id, {
        element,
        diagnostics: parseDiagnostics(event.diagnostics),
        durationMs: started === undefined ? null : Math.max(0, at - started)
    });
    return { ...progress, running, decided };
}

/** `progress` once a source is observed. */
function observedSource(progress: RunProgress, event: Record<string, unknown>): RunProgress {
    if (typeof event.source !== 'string' || !event.source || typeof event.reachable !== 'boolean') return progress;
    const reached = (progress.observed.get(event.source) ?? true) && event.reachable;
    return { ...progress, observed: new Map(progress.observed).set(event.source, reached) };
}

/** The event on `line`, if it is a JSON object. */
function eventOn(line: string): Record<string, unknown> | undefined {
    try {
        const event: unknown = JSON.parse(line);
        return isObject(event) ? event : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The progress once the event on `line` is read: `progress` itself when the line changes nothing
 * (an event or a line this does not read, or any event before `run.started`), and a problem when
 * the stream is in a version this does not read.
 */
export function nextProgress(progress: RunProgress | null, line: string): RunProgress | null | StreamProblem {
    const event = eventOn(line);
    if (!event) return progress;
    if (event.event === 'run.started') return startedRun(event);
    if (!progress) return progress;
    const at = typeof event.elapsed_ms === 'number' ? event.elapsed_ms : 0;
    switch (event.event) {
        case 'validation.ended':
            return { ...progress, validation: { passed: event.passed === true, diagnostics: parseDiagnostics(event.diagnostics) } };
        case 'diagram.drawn':
            return typeof event.path === 'string' && event.path ? { ...progress, preview: event.path } : progress;
        case 'element.started':
            return typeof event.id === 'string' ? { ...progress, running: new Map(progress.running).set(event.id, at) } : progress;
        case 'source.observed':
            return observedSource(progress, event);
        case 'element.decided':
            return decidedElement(progress, event, at);
        case 'run.ended':
            return { ...progress, ended: true };
        default:
            return progress;
    }
}

/** Reads a stream of events as its bytes arrive, a few at a time. */
export class RunEventReader {
    private readonly decoder = new TextDecoder('utf-8');
    private pending = '';
    private current: RunProgress | null = null;
    private refused: string | null = null;

    /** What the events have said so far; null before `run.started`. */
    get progress(): RunProgress | null {
        return this.current;
    }

    /** Why the stream is not read, if it is not. */
    get problem(): string | null {
        return this.refused;
    }

    /** Read the next bytes of the stream. Whether the progress changed. */
    read(bytes: Uint8Array): boolean {
        if (this.refused !== null) return false;
        // A character split across two reads is held by the decoder until its last byte arrives.
        this.pending += this.decoder.decode(bytes, { stream: true });
        const lines = this.pending.split('\n');
        this.pending = lines.pop() ?? '';
        let changed = false;
        for (const line of lines) {
            const next = nextProgress(this.current, line);
            if (next !== null && 'problem' in next) {
                this.refused = next.problem;
                return changed;
            }
            if (next !== this.current) {
                this.current = next;
                changed = true;
            }
        }
        return changed;
    }
}

/** Follows a stream of events as it is written; `stop` reads what is left. */
export interface EventFollower {
    /** Stop following, once what the file holds now is read. */
    stop(): Promise<void>;
}

/** How much of the file one read takes at most. */
const CHUNK = 1 << 20;

/**
 * Follow the events written to the file at `path`, telling `onProgress` each time they say
 * something new, and `onProblem` once if the stream is in a version this does not read.
 *
 * The file is polled every `intervalMs`: it is in the extension's storage, outside the workspace,
 * where VS Code's file watcher does not look. A file not written yet is waited for; one that
 * shrinks was emptied by a runner starting over, and is read again from its start. Polling is also
 * what limits how often a fast run changes what is shown.
 */
export function followEvents(
    path: string,
    onProgress: (progress: RunProgress) => void,
    onProblem: (problem: string) => void,
    intervalMs = 150
): EventFollower {
    let reader = new RunEventReader();
    let offset = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling: Promise<void> = Promise.resolve();

    const poll = async (): Promise<void> => {
        if (reader.problem !== null) return;
        let handle;
        try {
            handle = await open(path, 'r');
        } catch {
            return; // Not written yet, or not at all.
        }
        try {
            const { size } = await handle.stat();
            if (size < offset) {
                reader = new RunEventReader();
                offset = 0;
            }
            let changed = false;
            while (offset < size) {
                const buffer = Buffer.alloc(Math.min(CHUNK, size - offset));
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
                if (bytesRead === 0) break;
                offset += bytesRead;
                if (reader.read(buffer.subarray(0, bytesRead))) changed = true;
            }
            const progress = reader.progress;
            if (changed && progress) onProgress(progress);
            if (reader.problem !== null) onProblem(reader.problem);
        } catch {
            // A read that failed is tried again at the next poll.
        } finally {
            // Never fails a poll: following a run must not stop it being shown when it ends.
            await handle.close().catch(() => undefined);
        }
    };

    const schedule = (): void => {
        timer = setTimeout(() => {
            polling = poll().then(() => {
                if (!stopped) schedule();
            });
        }, intervalMs);
    };
    schedule();

    return {
        async stop(): Promise<void> {
            stopped = true;
            clearTimeout(timer);
            await polling;
            await poll();
        }
    };
}
