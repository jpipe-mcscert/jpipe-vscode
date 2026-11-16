import type { HostToRunPanel, RunKind, RunPanelState, RunPanelToHost, Tone } from '../shared/run-protocol.js';
import { DiagramCanvas } from './canvas.js';
import { applyDimming } from './highlight.js';
import type { Box } from './viewbox.js';

/**
 * The run panel's page: the last run's dataflow on the shared canvas, its verdict, and what can be
 * done about it (jpipe-vscode ADR-VSC-0031).
 *
 * Everything shown comes from one `state` message, applied whole: the page keeps nothing of a run
 * but what the host last said, plus the reader's own choices — how the drawing is framed, which
 * node is selected. `run.ts` connects it to the webview; this has no `acquireVsCodeApi`, so it is
 * tested against the shell's own markup.
 */

/** What survives a webview content reload. */
export interface PersistedRunState {
    vb?: Box;
}

/** How the verdict reads, besides its words and hue: a different shape for each. */
const GLYPHS: Readonly<Record<Tone, string>> = {
    pass: '✔',
    valid: '✔',
    fail: '✖',
    skip: '⊘',
    invalid: '✖'
};

/** What was done, said before the verdict: a check that is valid is no execution that passed. */
const KINDS: Readonly<Record<RunKind, { says: string; explains: string }>> = {
    execution: { says: 'Execution', explains: 'Every step was called.' },
    check: { says: 'Check · no step called', explains: 'The libraries were validated against the model; no step was called.' }
};

/** Every `type` the host is allowed to send. Anything else is not from our protocol. */
const HOST_MESSAGE_TYPES: ReadonlySet<string> = new Set<HostToRunPanel['type']>(['state', 'select', 'config']);

export function isRunPanelMessage(value: unknown): value is HostToRunPanel {
    return typeof value === 'object'
        && value !== null
        && HOST_MESSAGE_TYPES.has((value as { type?: unknown }).type as string);
}

const byId = <T extends HTMLElement = HTMLElement>(doc: Document, id: string): T => doc.getElementById(id) as T;

export class RunPage {
    private readonly canvas: DiagramCanvas;
    private state: RunPanelState | null = null;
    /** What is on the canvas, so a state that changes something else does not redraw it. */
    private drawn: { name: string; svg: string } | null = null;
    private selected: string | null = null;
    private readonly body: HTMLElement;

    constructor(
        private readonly doc: Document,
        private readonly post: (message: RunPanelToHost) => void,
        restored: PersistedRunState,
        private readonly persist: (state: PersistedRunState) => void
    ) {
        this.body = doc.body;
        this.canvas = new DiagramCanvas(
            {
                container: byId(doc, 'container'),
                wrapper: byId(doc, 'svg-wrapper'),
                zoomValue: byId(doc, 'zoom-value'),
                minimap: byId(doc, 'minimap'),
                zoomIn: byId(doc, 'zoom-in'),
                zoomOut: byId(doc, 'zoom-out'),
                zoomFit: byId(doc, 'zoom-fit')
            },
            {
                isShowing: () => this.body.dataset.mode === 'diagram',
                isChrome: target => target instanceof Element && target.closest('#toolbar, #banners, #minimap') !== null,
                onViewChange: () => this.persist({ vb: this.canvas.view ?? undefined }),
                onRebuilt: () => this.applySelection(false),
                onNodeClick: (node, twice) => this.nodeClicked(node, twice)
            }
        );
        if (restored.vb) this.canvas.restoreView(restored.vb);
        this.bindControls();
    }

    /** A message from the host, if it is one. */
    receive(message: unknown): void {
        if (!isRunPanelMessage(message)) return;
        switch (message.type) {
            case 'state':
                this.apply(message.state);
                break;
            case 'select':
                this.selected = message.element;
                this.applySelection(true);
                break;
            case 'config':
                this.canvas.setZoomSensitivity(message.zoomSensitivity);
                break;
        }
    }

    /** Show `state`, unless the page already shows a newer one. */
    apply(state: RunPanelState): void {
        if (this.state && state.revision < this.state.revision) return;
        if (this.state?.name !== state.name) this.selected = null;
        this.state = state;
        const running = state.phase === 'running';
        this.body.dataset.phase = state.phase;
        this.body.classList.toggle('busy', running);
        byId<HTMLButtonElement>(this.doc, 'run-button').disabled = running;
        byId<HTMLButtonElement>(this.doc, 'check-button').disabled = running;
        byId<HTMLButtonElement>(this.doc, 'stop-button').disabled = !running;
        this.showVerdict(state);
        this.showNotice(state);
        this.showOutOfDate(state);
        this.showDrawing(state);
        this.measureBanners();
    }

    private showVerdict(state: RunPanelState): void {
        const bar = byId(this.doc, 'verdict-bar');
        const counts = byId(this.doc, 'verdict-counts');
        const running = state.phase === 'running';
        const verdict = running ? null : state.verdict;
        bar.classList.toggle('visible', running || verdict !== null);
        counts.replaceChildren();
        const kind = KINDS[verdict?.kind ?? (state.check ? 'check' : 'execution')];
        const kindLabel = byId(this.doc, 'verdict-kind');
        kindLabel.textContent = kind.says;
        kindLabel.title = kind.explains;
        if (!verdict) {
            bar.dataset.tone = 'running';
            byId(this.doc, 'verdict-glyph').textContent = '…';
            byId(this.doc, 'verdict-label').textContent = running ? `${state.name}, under way` : '';
            byId(this.doc, 'verdict-when').textContent = '';
            return;
        }
        bar.dataset.tone = verdict.tone;
        byId(this.doc, 'verdict-glyph').textContent = GLYPHS[verdict.tone];
        byId(this.doc, 'verdict-label').textContent = verdict.label;
        for (const count of verdict.counts) {
            const link = this.doc.createElement('button');
            link.type = 'button';
            link.className = 'verdict-count';
            link.textContent = count.text;
            link.title = 'Show in Results';
            link.addEventListener('click', () => this.post({ type: 'results', row: count.row }));
            counts.append(link);
        }
        const when = byId(this.doc, 'verdict-when');
        when.textContent = verdict.at ?? '';
        when.title = verdict.libraries.length > 0 ? `Loaded ${verdict.libraries.join(', ')}` : '';
    }

    private showNotice(state: RunPanelState): void {
        const notice = state.notice;
        const banner = byId(this.doc, 'notice-banner');
        banner.classList.toggle('visible', notice !== null);
        banner.dataset.phase = state.phase;
        byId(this.doc, 'notice-text').textContent = notice?.text ?? '';
        const action = byId<HTMLButtonElement>(this.doc, 'notice-action');
        action.hidden = !notice?.action;
        action.textContent = notice?.action?.label ?? '';
    }

    private showOutOfDate(state: RunPanelState): void {
        const showing = state.outOfDate !== null && state.phase === 'done';
        byId(this.doc, 'out-of-date-banner').classList.toggle('visible', showing);
        byId(this.doc, 'out-of-date-text').textContent = state.outOfDate ?? '';
        byId(this.doc, 'out-of-date-action').textContent = state.check ? 'Check again' : 'Execute again';
    }

    /** Draw the run's dataflow, or say why there is nothing to draw. */
    private showDrawing(state: RunPanelState): void {
        const svg = state.dataflow;
        if (svg === null) {
            this.drawn = null;
            this.canvas.clear();
            this.body.dataset.mode = 'empty';
            byId(this.doc, 'empty-message').textContent = this.emptyMessage(state);
            return;
        }
        this.body.dataset.mode = 'diagram';
        if (this.drawn?.svg === svg) {
            this.canvas.showMinimap(true);
            return;
        }
        // The same justification keeps its framing from one run to the next.
        const keep = this.drawn?.name === state.name;
        this.canvas.show(svg, { documentPath: null, diagramName: `${state.name} (dataflow)` }, keep);
        this.drawn = { name: state.name, svg };
        this.applySelection(false);
    }

    private emptyMessage(state: RunPanelState): string {
        if (state.phase === 'running') return `${state.check ? 'Checking' : 'Executing'} ${state.name}…`;
        if (state.drawingMissing) return state.drawingMissing;
        if (state.phase === 'done') return `jpipe-runner drew nothing for this ${state.check ? 'check' : 'execution'}.`;
        return 'Nothing to draw yet: ▶ executes the justification, and ✓ checks it against its libraries without calling any step.';
    }

    /** The node of `element` on the canvas, if it is drawn. */
    private nodeOf(element: string): SVGGElement | null {
        const svg = this.canvas.svg;
        if (!svg) return null;
        return Array.from(svg.querySelectorAll<SVGGElement>('g.node')).find(node => node.id === element) ?? null;
    }

    /** Mark the selected element's node by dimming the rest, and bring it into view when asked. */
    private applySelection(reveal: boolean): void {
        const svg = this.canvas.svg;
        if (!svg) return;
        const node = this.selected === null ? null : this.nodeOf(this.selected);
        applyDimming(svg, node);
        if (node && reveal) this.canvas.reveal(node);
    }

    /** A click selects the element in Results; a double click opens it where it is written. */
    private nodeClicked(node: SVGGElement, twice: boolean): void {
        if (!this.state?.elements.includes(node.id)) return;
        if (twice) {
            this.post({ type: 'open', element: node.id });
            return;
        }
        this.selected = node.id;
        this.applySelection(false);
        this.post({ type: 'select', element: node.id });
    }

    private bindControls(): void {
        const click = (id: string, act: () => void) => byId(this.doc, id).addEventListener('click', act);
        click('run-button', () => this.post({ type: 'run' }));
        click('check-button', () => this.post({ type: 'check' }));
        click('stop-button', () => this.post({ type: 'stop' }));
        click('results-button', () => this.post({ type: 'results', row: null }));
        click('output-button', () => this.post({ type: 'output' }));
        click('download-button', () => this.post({ type: 'download' }));
        click('notice-action', () => {
            const id = this.state?.notice?.action?.id;
            if (id) this.post({ type: 'action', id });
        });
        click('out-of-date-action', () => this.post({ type: this.state?.check ? 'check' : 'run' }));
        // The banner stack changes height when a banner wraps, which no message announces.
        new ResizeObserver(() => this.measureBanners()).observe(byId(this.doc, 'banners'));
    }

    /** Push the banner stack's height down to the layers, as the preview does. */
    private measureBanners(): void {
        this.body.style.setProperty('--banners-height', `${byId(this.doc, 'banners').offsetHeight}px`);
    }
}
