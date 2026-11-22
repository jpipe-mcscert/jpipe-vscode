import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RunEventReader, followEvents, nextProgress, type RunProgress } from '../src/extension/runner/run-events.js';

/**
 * Reading a run's events as jpipe-runner writes them (`--events PATH`, jpipe-runner ADR-0030;
 * jpipe-vscode ADR-VSC-0033). The fixture is the release example's stream, quoted from the
 * runner's own `docs/events.md`: two evidence, one failing, and the strategy and conclusion
 * skipped because of it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const RELEASE = readFileSync(join(here, 'fixtures', 'runner', 'release.events.jsonl'), 'utf8');
const LINES = RELEASE.split('\n').filter(Boolean);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The progress after reading `lines`, one at a time. */
function after(lines: readonly string[]): RunProgress | null {
    const reader = new RunEventReader();
    for (const line of lines) reader.read(bytes(`${line}\n`));
    return reader.progress;
}

const started = (elements: string[], over: Record<string, unknown> = {}) => JSON.stringify({
    event: 'run.started', seq: 0, elapsed_ms: 0, schema_version: '1.0', report_schema_version: '2.0',
    justification: 'j', elements, strict: false, dry_run: false, ...over
});

describe('the release example, as it went', () => {

    test('knows every element as soon as the run starts', () => {
        const progress = after(LINES.slice(0, 1))!;
        expect(progress.elements).toEqual(['release:e1', 'release:e2', 'release:s', 'release:c']);
        expect(progress.decided.size).toBe(0);
        expect(progress.validation).toBeNull();
    });

    test('says what validation reported', () => {
        expect(after(LINES.slice(0, 2))!.validation).toEqual({ passed: true, diagnostics: [] });
    });

    test('says where the drawing made before the first step is', () => {
        expect(after(LINES.slice(0, 2))!.preview).toBeNull();
        expect(after(LINES.slice(0, 3))!.preview).toBe('/tmp/jpipe-runner-i7ba5753/diagram.svg');
    });

    test('a source is observed, and reached, while its element still runs', () => {
        const observing = after(LINES.slice(0, 5))!;
        expect([...observing.observed]).toEqual([['mock/junit.xml', true]]);
        expect([...observing.running.keys()]).toEqual(['release:e1']);
        expect(after(LINES)!.observed).toEqual(new Map([['mock/junit.xml', true], ['mock/CHANGELOG.md', true]]));
    });

    test('an element started is running until it is decided', () => {
        expect([...after(LINES.slice(0, 4))!.running.keys()]).toEqual(['release:e1']);
        const decided = after(LINES.slice(0, 6))!;
        expect(decided.running.size).toBe(0);
        expect(decided.decided.get('release:e1')!.element).toMatchObject({
            id: 'release:e1', label: 'The test suite passes', status: 'fail', reason: 'mock/junit.xml: 2 tests failed', ran: true
        });
    });

    test('ends with every element decided, as the report has them', () => {
        const progress = after(LINES)!;
        expect(progress.ended).toBe(true);
        expect([...progress.decided.values()].map(d => [d.element.id, d.element.status])).toEqual([
            ['release:e1', 'fail'], ['release:e2', 'pass'], ['release:s', 'skip'], ['release:c', 'skip']
        ]);
        expect(progress.decided.get('release:s')!.element.blockedBy).toEqual(['release:e1']);
    });

    test('a step that ran has a duration; an element decided without starting has none', () => {
        const progress = after(LINES)!;
        expect(progress.decided.get('release:e1')!.durationMs).toBe(0);
        expect(progress.decided.get('release:s')!.durationMs).toBeNull();
    });
});

describe('one event at a time', () => {

    test('a duration is the time from start to decision', () => {
        let progress = nextProgress(null, started(['j:e'])) as RunProgress;
        progress = nextProgress(progress, '{"event":"element.started","seq":1,"elapsed_ms":120,"id":"j:e"}') as RunProgress;
        progress = nextProgress(progress, '{"event":"element.decided","seq":2,"elapsed_ms":2520,"element":{"id":"j:e","status":"pass"},"diagnostics":[]}') as RunProgress;
        expect(progress.decided.get('j:e')!.durationMs).toBe(2400);
    });

    test('several steps may run at once, and be decided in any order', () => {
        let progress = nextProgress(null, started(['j:a', 'j:b'])) as RunProgress;
        for (const id of ['j:a', 'j:b']) {
            progress = nextProgress(progress, JSON.stringify({ event: 'element.started', seq: 1, elapsed_ms: 0, id })) as RunProgress;
        }
        expect([...progress.running.keys()]).toEqual(['j:a', 'j:b']);
        progress = nextProgress(progress, JSON.stringify({
            event: 'element.decided', seq: 3, elapsed_ms: 5, element: { id: 'j:b', status: 'pass' }, diagnostics: []
        })) as RunProgress;
        expect([...progress.running.keys()]).toEqual(['j:a']);
        expect([...progress.decided.keys()]).toEqual(['j:b']);
    });

    test('an element\'s diagnostics come with it', () => {
        let progress = nextProgress(null, started(['j:e'])) as RunProgress;
        progress = nextProgress(progress, JSON.stringify({
            event: 'element.decided', seq: 1, elapsed_ms: 0, element: { id: 'j:e', status: 'fail' },
            diagnostics: [{ code: 'JP019', severity: 'error', element: 'j:e', message: 'cannot read x' }]
        })) as RunProgress;
        expect(progress.decided.get('j:e')!.diagnostics).toMatchObject([{ code: 'JP019', element: 'j:e' }]);
    });

    test('an event or a field it does not know changes nothing', () => {
        const progress = nextProgress(null, started(['j:e'], { colour: 'blue' })) as RunProgress;
        expect(nextProgress(progress, '{"event":"step.printed","seq":1,"elapsed_ms":0}')).toBe(progress);
        expect(nextProgress(progress, 'not JSON')).toBe(progress);
        expect(nextProgress(progress, '"a string"')).toBe(progress);
    });

    test('a source two elements observe is reached only if both reached it', () => {
        const observed = (source: string, reachable: boolean) => JSON.stringify({ event: 'source.observed', seq: 1, elapsed_ms: 0, id: 'j:e', source, reachable });
        let progress = nextProgress(null, started(['j:e'])) as RunProgress;
        progress = nextProgress(progress, observed('build/*.xml', true)) as RunProgress;
        progress = nextProgress(progress, observed('build/*.xml', false)) as RunProgress;
        progress = nextProgress(progress, observed('build/*.xml', true)) as RunProgress;
        expect(progress.observed.get('build/*.xml')).toBe(false);
        expect(nextProgress(progress, '{"event":"source.observed","seq":4,"elapsed_ms":0,"id":"j:e","source":"x"}')).toBe(progress);
    });

    test('a drawing announced without a path is none', () => {
        const progress = nextProgress(null, started(['j:e'])) as RunProgress;
        expect(nextProgress(progress, '{"event":"diagram.drawn","seq":1,"elapsed_ms":0,"path":""}')).toBe(progress);
        expect(nextProgress(progress, '{"event":"diagram.drawn","seq":1,"elapsed_ms":0}')).toBe(progress);
    });

    test('nothing counts before the run starts', () => {
        expect(nextProgress(null, '{"event":"element.started","seq":0,"elapsed_ms":0,"id":"j:e"}')).toBeNull();
    });

    test('a later minor version is read', () => {
        expect(nextProgress(null, started(['j:e'], { schema_version: '1.4' }))).toMatchObject({ elements: ['j:e'] });
    });

    test('another major version is not', () => {
        expect(nextProgress(null, started(['j:e'], { schema_version: '2.0' }))).toEqual({
            problem: 'jpipe-runner wrote its events in version 2.0, and this extension reads version 1'
        });
    });
});

describe('reading the bytes as they arrive', () => {

    test('a line not ended yet waits for the rest of it', () => {
        const reader = new RunEventReader();
        const line = started(['j:e']);
        expect(reader.read(bytes(line.slice(0, 20)))).toBe(false);
        expect(reader.progress).toBeNull();
        expect(reader.read(bytes(`${line.slice(20)}\n`))).toBe(true);
        expect(reader.progress!.elements).toEqual(['j:e']);
    });

    test('a character split between two reads is read whole', () => {
        const reader = new RunEventReader();
        const encoded = bytes(`${started(['j:é'])}\n`);
        const cut = encoded.indexOf(0xc3) + 1; // between the two bytes of é
        reader.read(encoded.subarray(0, cut));
        reader.read(encoded.subarray(cut));
        expect(reader.progress!.elements).toEqual(['j:é']);
    });

    test('a stream in another major version is not read any further', () => {
        const reader = new RunEventReader();
        reader.read(bytes(`${started(['j:e'], { schema_version: '2.0' })}\n`));
        expect(reader.problem).toContain('version 2.0');
        expect(reader.read(bytes(`${started(['j:e'])}\n`))).toBe(false);
        expect(reader.progress).toBeNull();
    });
});

describe('following the file', () => {
    let folder: string;
    let file: string;

    beforeEach(() => {
        folder = mkdtempSync(join(tmpdir(), 'jpipe-events-'));
        file = join(folder, 'release.events.jsonl');
    });

    afterEach(() => rmSync(folder, { recursive: true, force: true }));

    test('reads what is written while it follows, and what is left when it stops', async () => {
        const seen: RunProgress[] = [];
        const follower = followEvents(file, progress => seen.push(progress), () => undefined, 5);
        writeFileSync(file, `${LINES[0]}\n`);
        await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
        appendFileSync(file, LINES.slice(1).join('\n') + '\n');
        await follower.stop();
        const last = seen.at(-1)!;
        expect(last.ended).toBe(true);
        expect(last.decided.size).toBe(4);
    });

    test('waits for a file not written yet, and says nothing about it', async () => {
        const onProgress = vi.fn();
        const onProblem = vi.fn();
        const follower = followEvents(file, onProgress, onProblem, 5);
        await new Promise(resolve => setTimeout(resolve, 20));
        await follower.stop();
        expect(onProgress).not.toHaveBeenCalled();
        expect(onProblem).not.toHaveBeenCalled();
    });

    test('a file emptied and written again is read from its start', async () => {
        const seen: RunProgress[] = [];
        writeFileSync(file, LINES.join('\n') + '\n');
        const follower = followEvents(file, progress => seen.push(progress), () => undefined, 5);
        await vi.waitFor(() => expect(seen.at(-1)?.ended).toBe(true));
        writeFileSync(file, `${started(['j:e'])}\n`);
        await follower.stop();
        expect(seen.at(-1)!.elements).toEqual(['j:e']);
    });

    test('says once that a stream is in a version it does not read', async () => {
        const onProblem = vi.fn();
        writeFileSync(file, `${started(['j:e'], { schema_version: '2.0' })}\n`);
        const follower = followEvents(file, () => undefined, onProblem, 5);
        await vi.waitFor(() => expect(onProblem).toHaveBeenCalled());
        await follower.stop();
        expect(onProblem).toHaveBeenCalledTimes(1);
    });
});
