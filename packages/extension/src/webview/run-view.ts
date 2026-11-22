import type { HostToRunPanel, Progress, RunKind, RunPanelState, RunPanelToHost, Tone, VerdictCount } from '../shared/run-protocol.js';
import { DiagramCanvas } from './canvas.js';
import { applyFocus, downstream, elementOf, nameOf, nodeNamed } from './flow.js';
import { colourRun, markProgress } from './run-colours.js';
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
    /**
     * What the verdict bar's counts show, so a state that changes something else leaves them be:
     * a run under way sends one at every step, and a count rebuilt between a press and its release
     * would drop the click, or the keyboard focus on it.
     */
    private countsShown: string | null = null;
    /** What is on the canvas, so a state that changes something else does not redraw it. */
    private drawn: { name: string; svg: string } | null = null;
    /**
     * The justification whose drawing the canvas was last framed on: kept when a new run clears
     * the canvas, so that the drawing it makes of the same justification opens as the reader left
     * the last one.
     */
    private framed: string | null = null;
    /**
     * The node selected, by the name Graphviz gave it, which is the element's id for an element:
     * kept across a redraw, where the node itself is replaced.
     */
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
                onRebuilt: () => this.applyMarks(),
                onNodeClick: (node, twice) => this.nodeClicked(node, twice),
                onBackgroundClick: () => this.select(null)
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
        // A run whose own drawing is on show is watched as it goes, not waited for.
        this.body.classList.toggle('busy', running && !state.progress?.statuses);
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
        // Read aloud when the run ends, not at every step it takes.
        bar.setAttribute('aria-live', running ? 'off' : 'polite');
        const kind = KINDS[verdict?.kind ?? (state.check ? 'check' : 'execution')];
        const kindLabel = byId(this.doc, 'verdict-kind');
        kindLabel.textContent = kind.says;
        kindLabel.title = kind.explains;
        const when = byId(this.doc, 'verdict-when');
        if (!verdict) {
            bar.dataset.tone = 'running';
            byId(this.doc, 'verdict-glyph').textContent = '…';
            byId(this.doc, 'verdict-label').textContent = running ? `${state.name}, under way` : '';
            when.textContent = '';
            when.title = '';
            const progress = running ? state.progress : null;
            this.showCounts(counts, progress && { caption: progress.decided, counts: progress.counts });
            if (progress) this.showRunning(progress, when);
            return;
        }
        bar.dataset.tone = verdict.tone;
        byId(this.doc, 'verdict-glyph').textContent = GLYPHS[verdict.tone];
        byId(this.doc, 'verdict-label').textContent = verdict.label;
        this.showCounts(counts, { caption: null, counts: verdict.counts });
        when.textContent = verdict.at ?? '';
        when.title = verdict.libraries.length > 0 ? `Loaded ${verdict.libraries.join(', ')}` : '';
    }

    /**
     * The verdict bar's counts, each opening its group in Results, after a caption when there is
     * one: for a run under way, how many elements its events have decided. Left as they are when
     * they say the same.
     */
    private showCounts(counts: HTMLElement, shown: { caption: string | null; counts: VerdictCount[] } | null): void {
        const key = JSON.stringify(shown);
        if (key === this.countsShown) return;
        this.countsShown = key;
        counts.replaceChildren();
        if (!shown) return;
        if (shown.caption !== null) {
            const caption = this.doc.createElement('span');
            caption.className = 'verdict-progress';
            caption.textContent = shown.caption;
            counts.append(caption);
        }
        counts.append(...shown.counts.map(count => this.countLink(count)));
    }

    /** The step a run under way is running, from its events. */
    private showRunning(progress: Progress, when: HTMLElement): void {
        when.textContent = progress.running ? `running ${progress.running}` : '';
        when.title = progress.running ? 'The step under way' : '';
    }

    /** A count of the verdict bar: a button that opens what it counts in Results. */
    private countLink(count: VerdictCount): HTMLButtonElement {
        const link = this.doc.createElement('button');
        link.type = 'button';
        link.className = 'verdict-count';
        link.textContent = count.text;
        link.title = 'Show in Results';
        link.addEventListener('click', () => this.post({ type: 'results', row: count.row }));
        return link;
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

    /**
     * Draw the run's dataflow, or say why there is nothing to draw. A run under way whose own
     * drawing is on show has its decided elements coloured over it, as the runner will colour them
     * when it ends, and its steps under way marked.
     */
    private showDrawing(state: RunPanelState): void {
        const statuses = state.progress?.statuses;
        const svg = state.dataflow !== null && statuses ? colourRun(state.dataflow, statuses, state.progress?.observed) : state.dataflow;
        if (svg === null) {
            this.drawn = null;
            this.canvas.clear();
            this.body.dataset.mode = 'empty';
            byId(this.doc, 'empty-message').textContent = this.emptyMessage(state);
            return;
        }
        this.body.dataset.mode = 'diagram';
        if (this.drawn?.svg === svg) {
            this.canvas.refreshMinimap();
            this.applyMarks();
            return;
        }
        // The same justification keeps its framing from one run to the next, and from the drawing
        // a run is coloured on to the one it ends with, which puts every node in the same place.
        const keep = this.framed === state.name;
        this.canvas.show(svg, { documentPath: null, diagramName: `${state.name} (dataflow)` }, keep);
        this.drawn = { name: state.name, svg };
        this.framed = state.name;
        this.applyMarks();
    }

    /**
     * What the page draws over the drawing on show: where a run under way is, on its own drawing
     * (a spinner on what runs, a clock on what waits, as in Results), and the selection.
     */
    private applyMarks(): void {
        const svg = this.canvas.svg;
        const progress = this.state?.phase === 'running' && this.state.progress?.statuses ? this.state.progress : null;
        if (svg) markProgress(svg, { underway: progress?.underway ?? [], pending: progress?.pending ?? [] });
        this.applySelection(false);
    }

    private emptyMessage(state: RunPanelState): string {
        if (state.phase === 'running') return `${state.check ? 'Checking' : 'Executing'} ${state.name}…`;
        if (state.drawingMissing) return state.drawingMissing;
        if (state.phase === 'done') return `jpipe-runner drew nothing for this ${state.check ? 'check' : 'execution'}.`;
        return 'Nothing to draw yet: ▶ executes the justification, and ✓ checks it against its libraries without calling any step.';
    }

    /**
     * Light the selected node and everything that follows it — what its arrows lead to, up to the
     * conclusion — by dimming the rest, and bring the node into view when asked.
     */
    private applySelection(reveal: boolean): void {
        const svg = this.canvas.svg;
        if (!svg) return;
        const node = this.selected === null ? null : nodeNamed(svg, this.selected);
        applyFocus(svg, node && downstream(svg, node), node);
        if (node && reveal) this.canvas.reveal(node);
    }

    /** Select the node named `name`, or clear the selection; Results follows when it is an element's. */
    private select(name: string | null): void {
        if (name === this.selected) return;
        this.selected = name;
        this.applySelection(false);
        this.post({ type: 'select', element: name === null ? null : this.elementNamed(name) });
    }

    /**
     * A click selects a node, and a second click on the selected node clears the selection, as a
     * click on the background does. A double click opens an element where it is written.
     */
    private nodeClicked(node: SVGGElement, twice: boolean): void {
        const name = this.standIn(nameOf(node));
        if (twice) {
            const element = this.elementNamed(name);
            if (element) this.post({ type: 'open', element });
            return;
        }
        this.select(name === this.selected ? null : name);
    }

    /**
     * The node a click on `name` acts on: a template slot's placeholder stands for the node of the
     * element that fills it, so selecting either is selecting that element — here, and when
     * Results selects it back — and lights the same flow, placeholder included.
     */
    private standIn(name: string): string {
        const filler = elementOf(name);
        const svg = this.canvas.svg;
        return filler !== name && svg && nodeNamed(svg, filler) ? filler : name;
    }

    /** The run's element named `name`, if it is one. */
    private elementNamed(name: string): string | null {
        return this.state?.elements.includes(name) ? name : null;
    }

    private bindControls(): void {
        const click = (id: string, act: () => void) => byId(this.doc, id).addEventListener('click', act);
        click('run-button', () => this.post({ type: 'run' }));
        click('check-button', () => this.post({ type: 'check' }));
        click('stop-button', () => this.post({ type: 'stop' }));
        click('results-button', () => this.post({ type: 'results', row: null }));
        click('output-button', () => this.post({ type: 'output' }));
        // What is on show, colours included: a run that ended without its report has no other.
        click('download-button', () => this.post({ type: 'download', svg: this.drawn?.svg ?? null }));
        click('notice-action', () => {
            const id = this.state?.notice?.action?.id;
            if (id) this.post({ type: 'action', id });
        });
        click('out-of-date-action', () => this.post({ type: this.state?.check ? 'check' : 'run' }));
        // Escape clears the selection, as it does in the editor's own lists.
        this.doc.addEventListener('keydown', event => {
            if (event.key === 'Escape' && this.selected !== null) this.select(null);
        });
        // The banner stack changes height when a banner wraps, which no message announces.
        new ResizeObserver(() => this.measureBanners()).observe(byId(this.doc, 'banners'));
    }

    /** Push the banner stack's height down to the layers, as the preview does. */
    private measureBanners(): void {
        this.body.style.setProperty('--banners-height', `${byId(this.doc, 'banners').offsetHeight}px`);
    }
}
