import type { HostToRunPanel, RunPanelState, RunPanelToHost, RunView, Tone } from '../shared/run-protocol.js';
import { DiagramCanvas } from './canvas.js';
import { applyDimming } from './highlight.js';
import type { Box } from './viewbox.js';

/**
 * The run panel's page: the last run's drawing on the shared canvas, its verdict, and what can be
 * done about it (jpipe-vscode ADR-VSC-0031).
 *
 * Everything shown comes from one `state` message, applied whole: the page keeps nothing of a
 * run but what the host last said, plus the reader's own choices — which view, how it is framed,
 * which node is selected. `run.ts` connects it to the webview; this has no `acquireVsCodeApi`, so
 * it is tested against the shell's own markup.
 */

/** What survives a webview content reload. */
export interface PersistedRunState {
    view?: RunView;
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
    /** The view the reader asked for. Shown when the run drew it. */
    private view: RunView;
    /** What is on the canvas, so a state that changes something else does not redraw it. */
    private drawn: { name: string; view: RunView; svg: string } | null = null;
    private selected: string | null = null;
    private readonly body: HTMLElement;

    constructor(
        private readonly doc: Document,
        private readonly post: (message: RunPanelToHost) => void,
        restored: PersistedRunState,
        private readonly persist: (state: PersistedRunState) => void
    ) {
        this.body = doc.body;
        this.view = restored.view ?? 'dataflow';
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
                onViewChange: () => this.save(),
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
    }

    private showVerdict(state: RunPanelState): void {
        const bar = byId(this.doc, 'verdict-bar');
        const counts = byId(this.doc, 'verdict-counts');
        const running = state.phase === 'running';
        bar.classList.toggle('visible', running || state.verdict !== null);
        counts.replaceChildren();
        if (running) {
            bar.dataset.tone = 'running';
            byId(this.doc, 'verdict-glyph').textContent = '…';
            byId(this.doc, 'verdict-label').textContent = `${state.check ? 'Checking' : 'Running'} ${state.name}`;
            byId(this.doc, 'verdict-when').textContent = '';
            this.measureBanners();
            return;
        }
        const verdict = state.verdict;
        if (!verdict) {
            this.measureBanners();
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
        when.textContent = verdict.when;
        when.title = verdict.libraries.length > 0 ? `Loaded ${verdict.libraries.join(', ')}` : '';
        this.measureBanners();
    }

    private showNotice(state: RunPanelState): void {
        const notice = state.notice;
        byId(this.doc, 'notice-banner').classList.toggle('visible', notice !== null);
        byId(this.doc, 'notice-banner').dataset.phase = state.phase;
        byId(this.doc, 'notice-text').textContent = notice?.text ?? '';
        const action = byId<HTMLButtonElement>(this.doc, 'notice-action');
        action.hidden = !notice?.action;
        action.textContent = notice?.action?.label ?? '';
        this.measureBanners();
    }

    private showOutOfDate(state: RunPanelState): void {
        const showing = state.outOfDate !== null && state.phase === 'done';
        byId(this.doc, 'out-of-date-banner').classList.toggle('visible', showing);
        byId(this.doc, 'out-of-date-text').textContent = state.outOfDate ?? '';
        byId(this.doc, 'out-of-date-action').textContent = state.check ? 'Check again' : 'Run again';
        this.measureBanners();
    }

    /**
     * Draw the view the reader asked for, or the other when the run drew only that one, or say
     * why there is nothing to draw.
     */
    private showDrawing(state: RunPanelState): void {
        const other: RunView = this.view === 'dataflow' ? 'argument' : 'dataflow';
        const view = state.diagrams[this.view] === null && state.diagrams[other] !== null ? other : this.view;
        const svg = state.diagrams[view];
        for (const button of this.viewButtons()) {
            const named = button.dataset.view as RunView;
            button.setAttribute('aria-pressed', String(named === view));
            button.disabled = state.diagrams[named] === null;
        }
        this.body.dataset.view = view;

        if (svg === null) {
            this.drawn = null;
            this.canvas.clear();
            this.body.dataset.mode = 'empty';
            byId(this.doc, 'empty-message').textContent = this.emptyMessage(state);
            return;
        }
        this.body.dataset.mode = 'diagram';
        const drawn = this.drawn;
        if (drawn?.svg !== svg || drawn.view !== view) {
            // The same view of the same justification keeps its framing from one run to the next.
            const keep = drawn?.name === state.name && drawn.view === view;
            const caption = view === 'dataflow' ? `${state.name} (dataflow)` : state.name;
            this.canvas.show(svg, { documentPath: null, diagramName: caption }, keep);
            this.drawn = { name: state.name, view, svg };
            this.applySelection(false);
        } else {
            this.canvas.showMinimap(true);
        }
    }

    private emptyMessage(state: RunPanelState): string {
        if (state.phase === 'running') return `${state.check ? 'Checking' : 'Running'} ${state.name}…`;
        if (state.diagramsMissing) return state.diagramsMissing;
        if (state.phase === 'done') return `jpipe-runner drew nothing for this ${state.check ? 'check' : 'run'}.`;
        return 'Nothing to draw yet: ▶ runs the justification, and ✓ checks it against its libraries without calling any step.';
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

    private viewButtons(): HTMLButtonElement[] {
        return Array.from(this.doc.querySelectorAll<HTMLButtonElement>('#view-switch button[data-view]'));
    }

    private bindControls(): void {
        const click = (id: string, act: () => void) => byId(this.doc, id).addEventListener('click', act);
        click('run-button', () => this.post({ type: 'run' }));
        click('check-button', () => this.post({ type: 'check' }));
        click('stop-button', () => this.post({ type: 'stop' }));
        click('results-button', () => this.post({ type: 'results', row: null }));
        click('output-button', () => this.post({ type: 'output' }));
        click('download-button', () => this.post({ type: 'download', view: this.body.dataset.view as RunView }));
        click('notice-action', () => {
            const id = this.state?.notice?.action?.id;
            if (id) this.post({ type: 'action', id });
        });
        click('out-of-date-action', () => this.post({ type: this.state?.check ? 'check' : 'run' }));
        for (const button of this.viewButtons()) {
            button.addEventListener('click', () => {
                this.view = button.dataset.view as RunView;
                this.save();
                if (this.state) this.showDrawing(this.state);
            });
        }
        // The banner stack changes height when a banner wraps, which no message announces.
        new ResizeObserver(() => this.measureBanners()).observe(byId(this.doc, 'banners'));
    }

    /** Push the banner stack's height down to the layers, as the preview does. */
    private measureBanners(): void {
        this.body.style.setProperty('--banners-height', `${byId(this.doc, 'banners').offsetHeight}px`);
    }

    private save(): void {
        this.persist({ view: this.view, vb: this.canvas.view ?? undefined });
    }
}
