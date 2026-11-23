/**
 * @vitest-environment happy-dom
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import type { RunPanelState, RunPanelToHost } from '../src/shared/run-protocol.js';
import { RunPage, isRunPanelMessage, type PersistedRunState } from '../src/webview/run-view.js';

/**
 * The run panel's page, mounted in the markup `run-shell.ts` builds — read from its source, since
 * that file imports `vscode` — so an id renamed in one and not the other fails here rather than
 * leaving a dead control (the reason `preview-shell.test.ts` exists, for the preview).
 *
 * What is still manual: how it looks, and the round trip through the extension host.
 */

const here = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(join(here, '..', 'src', 'extension', 'runner', 'run-shell.ts'), 'utf8');

/** The shell's `<body>`: its attributes, and what it holds up to the script. */
function mountShell(): void {
    const open = /<body([^>]*)>/.exec(shell)!;
    const inner = shell.slice(open.index + open[0].length, shell.indexOf('<script'));
    document.body.innerHTML = inner;
    for (const [, name, value] of open[1].matchAll(/([\w-]+)="([^"]*)"/g)) document.body.setAttribute(name, value);
}

const svg = (caption: string, ...nodes: string[]) => `<svg xmlns="http://www.w3.org/2000/svg" width="200pt" height="100pt" viewBox="0 0 200 100">
<g id="graph0" class="graph"><title>${caption}</title>
${nodes.map(id => `<g id="${id}" class="node"><title>${id}</title><polygon fill="none" stroke="black" points="0,0 1,1"/><text>${id}</text></g>`).join('\n')}
<g id="node9" class="node"><title>artifact build/tests.log</title><text>build/tests.log</text></g>
</g></svg>`;

const DATAFLOW = svg('release (dataflow)', 'release:e', 'release:c');

const state = (over: Partial<RunPanelState> = {}): RunPanelState => ({
    revision: 1,
    name: 'release',
    check: false,
    phase: 'done',
    verdict: {
        kind: 'execution', label: 'release failed', tone: 'fail',
        counts: [{ text: '1 passed', row: 'group/Passed' }, { text: '1 failed', row: 'group/Failed' }],
        at: '14:02', libraries: ['steps.py']
    },
    progress: null,
    notice: null,
    dataflow: DATAFLOW,
    drawingMissing: null,
    elements: ['release:e', 'release:c'],
    outOfDate: null,
    ...over
});

const byId = (id: string) => document.getElementById(id) as HTMLElement;
const button = (id: string) => byId(id) as HTMLButtonElement;

let post: Mock<(message: RunPanelToHost) => void>;
let persist: Mock<(state: PersistedRunState) => void>;

function newPage(restored: PersistedRunState = {}): RunPage {
    return new RunPage(document, post, restored, persist);
}

beforeEach(() => {
    mountShell();
    post = vi.fn<(message: RunPanelToHost) => void>();
    persist = vi.fn<(state: PersistedRunState) => void>();
    vi.spyOn(byId('container'), 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({})
    } as DOMRect);
    byId('container').setPointerCapture = vi.fn();
    byId('container').releasePointerCapture = vi.fn();
    URL.createObjectURL = vi.fn(() => 'blob:minimap');
    URL.revokeObjectURL = vi.fn();
});

describe('a run that ended', () => {

    test('shows its dataflow, with its verdict above it', () => {
        newPage().apply(state());
        expect(document.body.dataset.mode).toBe('diagram');
        expect(byId('svg-wrapper').querySelector('svg')).not.toBeNull();
        expect(byId('verdict-bar').classList.contains('visible')).toBe(true);
        expect(byId('verdict-bar').dataset.tone).toBe('fail');
        expect(byId('verdict-kind').textContent).toBe('Execution');
        expect(byId('verdict-label').textContent).toBe('release failed');
        expect(byId('verdict-when').textContent).toBe('14:02');
        expect(byId('verdict-when').title).toBe('Loaded steps.py');
        expect(document.body.classList.contains('busy')).toBe(false);
        expect([button('run-button').disabled, button('check-button').disabled, button('stop-button').disabled]).toEqual([false, false, true]);
    });

    test('a count opens its group in Results', () => {
        newPage().apply(state());
        const counts = Array.from(byId('verdict-counts').querySelectorAll('button'));
        expect(counts.map(c => c.textContent)).toEqual(['1 passed', '1 failed']);
        counts[1].click();
        expect(post).toHaveBeenCalledWith({ type: 'results', row: 'group/Failed' });
    });

    test('a check says so before its verdict, so a valid check is not read as an execution that passed', () => {
        newPage().apply(state({
            check: true,
            verdict: { kind: 'check', label: 'release is valid', tone: 'valid', counts: [], at: '14:02', libraries: [] }
        }));
        expect(byId('verdict-kind').textContent).toBe('Check · no step called');
        expect(byId('verdict-kind').title).toContain('no step was called');
        expect(byId('verdict-label').textContent).toBe('release is valid');
        expect(byId('verdict-when').title).toBe('');
    });

    test('a redrawn run keeps the reader\'s framing, and a state about something else does not redraw', () => {
        const page = newPage();
        page.apply(state());
        const drawn = byId('svg-wrapper').querySelector('svg');
        page.apply(state({ revision: 2, outOfDate: 'release.jd changed since this execution.' }));
        expect(byId('svg-wrapper').querySelector('svg')).toBe(drawn);
        page.apply(state({ revision: 3, dataflow: svg('release (dataflow)', 'release:e') }));
        expect(byId('svg-wrapper').querySelector('svg')).not.toBe(drawn);
        expect(persist).toHaveBeenCalled();
    });

    test('a new run clears the drawing, and keeps the framing for the drawing it makes of the same justification', () => {
        const page = newPage();
        page.apply(state());
        button('zoom-in').click();
        const view = (): number[] => byId('svg-wrapper').querySelector('svg')!.getAttribute('viewBox')!.split(' ').map(Number);
        const sameView = (a: number[], b: number[]): boolean => a.every((n, i) => Math.abs(n - b[i]) < 1e-6);
        const framed = view();
        page.apply(state({ revision: 2, phase: 'running', verdict: null, dataflow: null }));
        expect(document.body.dataset.mode).toBe('empty');
        expect(byId('svg-wrapper').querySelector('svg')).toBeNull();
        page.apply(state({ revision: 3, dataflow: svg('release (dataflow)', 'release:e', 'release:c') }));
        expect(sameView(view(), framed)).toBe(true);
        // Another justification opens on its own.
        page.apply(state({ revision: 4, name: 'other', dataflow: svg('other (dataflow)', 'other:e') }));
        expect(sameView(view(), framed)).toBe(false);
    });

    test('with no drawing, says why', () => {
        newPage().apply(state({ dataflow: null, drawingMissing: 'Drawing needs Graphviz.' }));
        expect(document.body.dataset.mode).toBe('empty');
        expect(byId('empty-message').textContent).toBe('Drawing needs Graphviz.');
        newPage().apply(state({ revision: 2, dataflow: null }));
        expect(byId('empty-message').textContent).toBe('jpipe-runner drew nothing for this execution.');
    });

    test('saves the drawing', () => {
        newPage().apply(state());
        button('download-button').click();
        expect(post).toHaveBeenCalledWith({ type: 'download', svg: DATAFLOW });
    });

    test('a run stopped on its own drawing keeps its colours, and saves them, with nothing marked running or waiting', () => {
        const page = newPage();
        const failed = { id: 'release:e', status: 'fail' as const, reason: null, rootCause: false, produced: [], unreachable: [] };
        page.apply(state({
            revision: 1, phase: 'stopped', verdict: null, notice: { text: 'release was stopped.', action: null },
            progress: { decided: '1 of 2 decided', counts: [], running: [], statuses: [failed], underway: [], pending: [], observed: [] }
        }));
        const node = document.querySelector('#svg-wrapper g[id="release:e"]')!;
        expect(node.textContent).toContain('✘');
        expect(document.querySelectorAll('#svg-wrapper g.jpipe-underway, #svg-wrapper g.jpipe-pending')).toHaveLength(0);
        button('download-button').click();
        const saved = post.mock.calls.map(([m]) => m).find(m => m.type === 'download') as { svg: string };
        expect(saved.svg).toContain('✘');
    });

    test('a state older than the one on show is dropped', () => {
        const page = newPage();
        page.apply(state({ revision: 5 }));
        page.apply(state({ revision: 4, verdict: null, phase: 'running' }));
        expect(byId('verdict-label').textContent).toBe('release failed');
    });
});

describe('a run under way', () => {

    test('is busy over the last drawing, and can only be stopped', () => {
        newPage().apply(state({ phase: 'running', verdict: null, check: true }));
        expect(document.body.classList.contains('busy')).toBe(true);
        expect(byId('verdict-kind').textContent).toBe('Check · no step called');
        expect(byId('verdict-label').textContent).toBe('release, under way');
        expect([button('run-button').disabled, button('check-button').disabled, button('stop-button').disabled]).toEqual([true, true, false]);
        button('stop-button').click();
        expect(post).toHaveBeenCalledWith({ type: 'stop' });
    });

    test('with nothing drawn yet, says it is executing', () => {
        newPage().apply(state({ phase: 'running', verdict: null, dataflow: null }));
        expect(byId('verdict-kind').textContent).toBe('Execution');
        expect(byId('empty-message').textContent).toBe('Executing release…');
    });

    test('says how far it is, each count opening its group, and which step runs', () => {
        newPage().apply(state({
            phase: 'running', verdict: null,
            progress: { decided: '2 of 4 decided', counts: [{ text: '1 failed', row: 'group/Failed' }], running: ['release:e2'], statuses: null, underway: [], pending: [], observed: [] }
        }));
        expect(byId('verdict-label').textContent).toBe('release, under way');
        expect(byId('verdict-counts').textContent).toBe('2 of 4 decided1 failed');
        expect(byId('verdict-when').textContent).toBe('running release:e2');
        (byId('verdict-counts').querySelector('button.verdict-count') as HTMLButtonElement).click();
        expect(post).toHaveBeenCalledWith({ type: 'results', row: 'group/Failed' });
    });

    // With --jobs, from jpipe-runner 4.4, several steps run at once (#136).
    test('names two steps running at once, and counts more, with every one in its tooltip', () => {
        const page = newPage();
        const progress = { decided: '0 of 4 decided', counts: [], running: ['Tests pass', 'Lint is clean'], statuses: null, underway: [], pending: [], observed: [] };
        page.apply(state({ revision: 1, phase: 'running', verdict: null, progress }));
        expect(byId('verdict-when').textContent).toBe('running Tests pass and Lint is clean');
        page.apply(state({ revision: 2, phase: 'running', verdict: null, progress: { ...progress, running: ['a', 'b', 'c'] } }));
        expect(byId('verdict-when').textContent).toBe('running 3 steps');
        expect(byId('verdict-when').title).toBe('The steps under way:\n• a\n• b\n• c');
        page.apply(state({ revision: 3, phase: 'running', verdict: null, progress: { ...progress, running: [] } }));
        expect(byId('verdict-when').textContent).toBe('');
        expect(byId('verdict-when').title).toBe('');
    });

    test('a count is not rebuilt by a state that leaves it as it was, so a click on it is not lost', () => {
        const page = newPage();
        const progress = { decided: '1 of 4 decided', counts: [{ text: '1 failed', row: 'group/Failed' }], running: ['e2'], statuses: null, underway: [], pending: [], observed: [] };
        page.apply(state({ revision: 1, phase: 'running', verdict: null, progress }));
        const count = byId('verdict-counts').querySelector('button')!;
        page.apply(state({ revision: 2, phase: 'running', verdict: null, progress: { ...progress, running: ['e3'] } }));
        expect(byId('verdict-counts').querySelector('button')).toBe(count);
        page.apply(state({ revision: 3, phase: 'running', verdict: null, progress: { ...progress, decided: '2 of 4 decided' } }));
        expect(byId('verdict-counts').querySelector('button')).not.toBe(count);
    });

    test('is read aloud when it ends, not at every step', () => {
        const page = newPage();
        page.apply(state({ revision: 1, phase: 'running', verdict: null }));
        expect(byId('verdict-bar').getAttribute('aria-live')).toBe('off');
        page.apply(state({ revision: 2 }));
        expect(byId('verdict-bar').getAttribute('aria-live')).toBe('polite');
    });

    test('with its own drawing on show, is watched rather than waited for: decided elements coloured, steps under way marked', () => {
        const page = newPage();
        const failed = { id: 'release:e', status: 'fail' as const, reason: 'two tests failed', rootCause: false, produced: [], unreachable: [] };
        page.apply(state({
            revision: 1, phase: 'running', verdict: null,
            progress: { decided: '1 of 2 decided', counts: [], running: ['release:c'], statuses: [failed], underway: ['release:c'], pending: [], observed: [] }
        }));
        expect(document.body.classList.contains('busy')).toBe(false);
        const node = (id: string) => document.querySelector(`#svg-wrapper g[id="${id}"]`)!;
        expect(node('release:e').querySelector('polygon')!.getAttribute('fill')).toBe('#d55e00');
        expect(node('release:e').textContent).toContain('✘');
        expect(node('release:c').querySelector('g.jpipe-underway circle')).not.toBeNull();
        // The run's end: the runner's drawing, with nothing of the page's over it.
        page.apply(state({ revision: 2 }));
        expect(node('release:c').querySelector('.jpipe-underway')).toBeNull();
        expect(node('release:e').textContent).not.toContain('✘');
    });

    test('a step marked under way stays marked when a state leaves the drawing as it was', () => {
        const page = newPage();
        const progress = { decided: '0 of 2 decided', counts: [], running: ['release:e'], statuses: [], underway: ['release:e'], pending: [], observed: [] };
        page.apply(state({ revision: 1, phase: 'running', verdict: null, progress }));
        page.apply(state({ revision: 2, phase: 'running', verdict: null, progress: { ...progress, running: ['release:c'], underway: ['release:c'], pending: [], observed: [] } }));
        const marked = Array.from(document.querySelectorAll('#svg-wrapper .jpipe-underway')).map(n => n.closest('g.node')!.id);
        expect(marked).toEqual(['release:c']);
    });

    test('marks what waits with a clock on its own drawing, and nothing on another run\'s', () => {
        const page = newPage();
        const waiting = { decided: '0 of 2 decided', counts: [], running: [], statuses: [], underway: [], pending: ['release:e', 'release:c'], observed: [] };
        page.apply(state({ revision: 1, phase: 'running', verdict: null, progress: waiting }));
        const marks = () => Array.from(document.querySelectorAll('#svg-wrapper g.jpipe-pending')).map(m => m.closest('g.node')!.id);
        expect(marks()).toEqual(['release:e', 'release:c']);
        page.apply(state({ revision: 2, phase: 'running', verdict: null, progress: { ...waiting, statuses: null } }));
        expect(marks()).toEqual([]);
    });

    test('without its own drawing, waits under the busy overlay', () => {
        newPage().apply(state({
            phase: 'running', verdict: null,
            progress: { decided: '0 of 2 decided', counts: [], running: [], statuses: null, underway: [], pending: [], observed: [] }
        }));
        expect(document.body.classList.contains('busy')).toBe(true);
    });

    test('between two steps, says none runs; once ended, the verdict replaces it', () => {
        const page = newPage();
        page.apply(state({ revision: 1, phase: 'running', verdict: null, progress: { decided: '1 of 4 decided', counts: [], running: [], statuses: null, underway: [], pending: [], observed: [] } }));
        expect(byId('verdict-when').textContent).toBe('');
        page.apply(state({ revision: 2 }));
        expect(byId('verdict-counts').textContent).toBe('1 passed1 failed');
        expect(byId('verdict-when').textContent).toBe('14:02');
    });
});

describe('notices and banners', () => {

    test('a notice says why, and its button does the one thing about it', () => {
        newPage().apply(state({
            phase: 'blocked', verdict: null, dataflow: null,
            notice: { text: 'No step library is checked.', action: { label: 'Show Libraries', id: 'showLibraries' } }
        }));
        expect(byId('notice-banner').classList.contains('visible')).toBe(true);
        expect(byId('notice-text').textContent).toBe('No step library is checked.');
        expect(button('notice-action').hidden).toBe(false);
        button('notice-action').click();
        expect(post).toHaveBeenCalledWith({ type: 'action', id: 'showLibraries' });
        expect(byId('verdict-bar').classList.contains('visible')).toBe(false);
        expect(byId('empty-message').textContent).toContain('▶ executes the justification');
    });

    test('a notice without anything to do has no button', () => {
        newPage().apply(state({ phase: 'stopped', notice: { text: 'release was stopped.', action: null } }));
        expect(button('notice-action').hidden).toBe(true);
        expect(byId('notice-banner').dataset.phase).toBe('stopped');
    });

    test('an execution out of date says why, and executes again; a check checks again', () => {
        const page = newPage();
        page.apply(state({ outOfDate: 'release.jd changed since this execution.' }));
        expect(byId('out-of-date-banner').classList.contains('visible')).toBe(true);
        expect(byId('out-of-date-text').textContent).toBe('release.jd changed since this execution.');
        expect(byId('out-of-date-action').textContent).toBe('Execute again');
        button('out-of-date-action').click();
        expect(post).toHaveBeenLastCalledWith({ type: 'run' });

        page.apply(state({ revision: 2, check: true, outOfDate: 'x' }));
        expect(byId('out-of-date-action').textContent).toBe('Check again');
        button('out-of-date-action').click();
        expect(post).toHaveBeenLastCalledWith({ type: 'check' });

        page.apply(state({ revision: 3, phase: 'running', outOfDate: 'x' }));
        expect(byId('out-of-date-banner').classList.contains('visible')).toBe(false);
    });
});

describe('the toolbar', () => {

    test.each([
        ['run-button', { type: 'run' }],
        ['check-button', { type: 'check' }],
        ['results-button', { type: 'results', row: null }],
        ['output-button', { type: 'output' }]
    ] as const)('%s asks the host', (id, message) => {
        newPage().apply(state());
        button(id).click();
        expect(post).toHaveBeenCalledWith(message);
    });
});

describe('nodes', () => {
    const click = (id: string, detail: number) => {
        const node = Array.from(byId('svg-wrapper').querySelectorAll('g.node')).find(g => g.id === id)!;
        node.querySelector('text')!.dispatchEvent(new PointerEvent('pointerdown', { clientX: 5, clientY: 5, pointerId: 1, button: 0, bubbles: true }));
        byId('container').dispatchEvent(new MouseEvent('click', { detail, bubbles: true }));
        return node;
    };

    test('a click selects the element, here and in Results', () => {
        newPage().apply(state());
        const node = click('release:e', 1);
        expect(post).toHaveBeenCalledWith({ type: 'select', element: 'release:e' });
        expect(node.classList.contains('jpipe-dimmed')).toBe(false);
        expect(byId('svg-wrapper').querySelector('[id="release:c"]')!.classList.contains('jpipe-dimmed')).toBe(true);
    });

    test('a double click opens it', () => {
        newPage().apply(state());
        click('release:c', 2);
        expect(post).toHaveBeenCalledWith({ type: 'open', element: 'release:c' });
    });

    test('a file or a variable is lit too, but there is no row in Results to select', () => {
        newPage().apply(state());
        click('node9', 1);
        expect(post).toHaveBeenLastCalledWith({ type: 'select', element: null });
        expect(byId('svg-wrapper').querySelector('[id="node9"]')!.classList.contains('jpipe-origin')).toBe(true);
        click('node9', 2);
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'open' }));
    });

    describe('a template slot\'s placeholder', () => {
        // jpipe-runner after 4.0 draws a template's @support slot as a node of its own, in the
        // template's cluster, named after the element that fills it.
        const fixture = readFileSync(join(here, 'fixtures', 'svg', 'runner-dataflow-with-template.svg'), 'utf8');
        const elements = ['release:Signoff:review', 'release:Signoff:s', 'release:Signoff:c'];
        const lit = (id: string) => !byId('svg-wrapper').querySelector(`[id="${id}"]`)!.classList.contains('jpipe-dimmed');

        test('a click is a click on the filling element: selected here and in Results, placeholder lit', () => {
            newPage().apply(state({ dataflow: fixture, elements }));
            click('release:Signoff:review@abstract', 1);
            expect(post).toHaveBeenLastCalledWith({ type: 'select', element: 'release:Signoff:review' });
            expect(byId('svg-wrapper').querySelector('[id="release:Signoff:review"]')!.classList.contains('jpipe-origin')).toBe(true);
            expect(lit('release:Signoff:review@abstract')).toBe(true);
        });

        test('Results selecting it back keeps it, and a second click clears it', () => {
            const page = newPage();
            page.apply(state({ dataflow: fixture, elements }));
            click('release:Signoff:review@abstract', 1);
            page.receive({ type: 'select', element: 'release:Signoff:review' });
            click('release:Signoff:review@abstract', 1);
            expect(post).toHaveBeenLastCalledWith({ type: 'select', element: null });
            expect(byId('svg-wrapper').querySelectorAll('.jpipe-dimmed')).toHaveLength(0);
        });

        test('a double click opens the filling element', () => {
            newPage().apply(state({ dataflow: fixture, elements }));
            click('release:Signoff:review@abstract', 2);
            expect(post).toHaveBeenLastCalledWith({ type: 'open', element: 'release:Signoff:review' });
        });
    });

    test('a second click on the selected node clears the selection', () => {
        newPage().apply(state());
        click('release:e', 1);
        click('release:e', 1);
        expect(post).toHaveBeenLastCalledWith({ type: 'select', element: null });
        expect(byId('svg-wrapper').querySelectorAll('.jpipe-dimmed')).toHaveLength(0);
    });

    test('a click on the background, or Escape, clears it too', () => {
        newPage().apply(state());
        click('release:e', 1);
        byId('container').dispatchEvent(new PointerEvent('pointerdown', { clientX: 5, clientY: 5, pointerId: 1, button: 0, bubbles: true }));
        byId('container').dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
        expect(byId('svg-wrapper').querySelectorAll('.jpipe-dimmed')).toHaveLength(0);

        click('release:e', 1);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(byId('svg-wrapper').querySelectorAll('.jpipe-dimmed')).toHaveLength(0);
        expect(post).toHaveBeenLastCalledWith({ type: 'select', element: null });
    });

    test('lights what follows the selected element, and dims the rest', () => {
        const flow = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g class="graph">
<g id="release:e" class="node"><title>release:e</title><text>release:e</text></g>
<g id="release:s" class="node"><title>release:s</title><text>release:s</text></g>
<g id="release:c" class="node"><title>release:c</title><text>release:c</text></g>
<g id="release:e2" class="node"><title>release:e2</title><text>release:e2</text></g>
<g class="edge"><title>release:e&#45;&gt;release:s</title></g>
<g class="edge"><title>release:e2&#45;&gt;release:s</title></g>
<g class="edge"><title>release:s&#45;&gt;release:c</title></g>
</g></svg>`;
        newPage().apply(state({ dataflow: flow, elements: ['release:e', 'release:s', 'release:c', 'release:e2'] }));
        click('release:e', 1);
        const dimmed = Array.from(byId('svg-wrapper').querySelectorAll('.jpipe-dimmed')).map(g => g.querySelector('title')!.textContent);
        expect(dimmed).toEqual(['release:e2', 'release:e2->release:s']);
    });

    test('a selection made in Results is shown, and cleared when it moves off the elements', () => {
        const page = newPage();
        page.apply(state());
        page.receive({ type: 'select', element: 'release:c' });
        const dimmed = () => Array.from(byId('svg-wrapper').querySelectorAll('.jpipe-dimmed')).map(g => g.id);
        expect(dimmed()).toEqual(['release:e', 'node9']);
        page.receive({ type: 'select', element: null });
        expect(dimmed()).toEqual([]);
    });

    test('another justification starts with nothing selected', () => {
        const page = newPage();
        page.apply(state());
        page.receive({ type: 'select', element: 'release:c' });
        page.apply(state({ revision: 2, name: 'other', dataflow: svg('other (dataflow)', 'release:c') }));
        expect(byId('svg-wrapper').querySelectorAll('.jpipe-dimmed')).toHaveLength(0);
    });
});

describe('messages', () => {

    test('only the protocol\'s are taken', () => {
        expect(isRunPanelMessage({ type: 'state' })).toBe(true);
        expect(isRunPanelMessage({ type: 'render' })).toBe(false);
        expect(isRunPanelMessage('state')).toBe(false);
        expect(isRunPanelMessage(null)).toBe(false);
    });

    test('a state message is applied, and anything else is ignored', () => {
        const page = newPage();
        page.receive({ type: 'nonsense' });
        page.receive({ type: 'config', zoomSensitivity: 2 });
        page.receive({ type: 'state', state: state() });
        expect(byId('verdict-label').textContent).toBe('release failed');
    });
});
