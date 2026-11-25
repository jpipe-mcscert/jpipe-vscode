import type { HostToWebview, RenderMessage, ViewMode, WebviewToHost } from '../shared/preview-protocol.js';
import { renderFailureNotice, showsFailureNotice } from '../shared/render-failure.js';
import { DiagnosticView, type DiagnosticViewState } from './diagnostic-view.js';
import { applyDimming, findElement } from './highlight.js';
import { DiagramCanvas, diagramIdentity, type SavedFraming } from './canvas.js';

/**
 * The preview panel's page: the diagram of the model under the cursor, or its diagnostic report.
 *
 * The canvas itself — panning, zooming, the minimap, following the theme — is `canvas.ts`, which
 * the run panel shares. What is here is the preview's own: the two layers and the switch between
 * them, the banners, the cursor highlight, and the messages from the host.
 */

/**
 * What survives a webview content reload (`Developer: Reload Webviews`, an extension-host
 * restart). The diagram itself comes back via the `ready` replay; this is what makes it come
 * back framed the way the user left it, which is the whole point of the exercise.
 */
interface PersistedState {
    framing?: SavedFraming;
    highlightEnabled?: boolean;
    /**
     * Where the reader was in the diagnostic view: which tab, what they had filtered, which
     * macros they had opened, how far down they had scrolled. The report is rebuilt on every
     * save, so without this every save would return them to the top of the first tab.
     */
    diag?: DiagnosticViewState;
}

declare function acquireVsCodeApi(): {
    postMessage(msg: WebviewToHost): void;
    getState(): PersistedState | undefined;
    setState(state: PersistedState): void;
};

const vscode = acquireVsCodeApi();

const banners = document.getElementById('banners') as HTMLElement;
const banner = document.getElementById('unsaved-banner') as HTMLElement;
const bannerText = document.getElementById('unsaved-banner-text') as HTMLElement;
const errorBanner = document.getElementById('error-banner') as HTMLElement;
const errorBannerText = document.getElementById('error-banner-text') as HTMLElement;
const errorBannerAction = document.getElementById('error-banner-action') as HTMLElement;

/** The current failure notice, or null. Kept because it outlives the mode it is shown in. */
let renderFailure: string | null = null;
const diagOutput = document.getElementById('diag-output') as HTMLElement;
const highlightToggle = document.getElementById('highlight-toggle') as HTMLElement;
const modeToggle = document.getElementById('mode-toggle') as HTMLElement;
const drawer = document.getElementById('download-drawer') as HTMLElement;

const diagnosticView = new DiagnosticView(
    {
        overlay: document.getElementById('diagnostic-overlay') as HTMLElement,
        tabs: document.getElementById('diag-tabs') as HTMLElement,
        filter: document.getElementById('diag-filter') as HTMLInputElement,
        controlsExtra: document.getElementById('diag-controls-extra') as HTMLElement,
        panel: document.getElementById('diag-panel') as HTMLElement,
        output: diagOutput,
        faces: document.getElementById('diag-faces') as HTMLElement,
        copyButton: document.getElementById('diag-copy') as HTMLElement
    },
    {
        revealLocation: (source, line, column) =>
            vscode.postMessage({ type: 'revealLocation', source, line, column }),
        requestTextReport: () => vscode.postMessage({ type: 'requestTextReport' }),
        // `navigator.clipboard` is available in the webview and needs no extra permission; the
        // host is not involved.
        copy: text => void navigator.clipboard?.writeText(text),
        persist: () => persist()
    }
);

/* --------------------------------------------------------------- page state */

let lastRevision = -1;
/** The diagnostic path is just as async as the render one, and drops stale results the same way. */
let lastDiagnosticRevision = -1;
let diagramName: string | null = null;

let highlightEnabled = false;
let highlightName: string | null = null;
/** The model `highlightName` belongs to; an element id alone does not identify a row. */
let highlightModel: string | null = null;
let lastMatched: SVGGraphicsElement | null = null;

/** True for events the canvas must not swallow — the toolbar and the scrollable diagnostic text. */
function isChrome(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('#toolbar, #diagnostic-overlay, #minimap') !== null;
}

const canvas = new DiagramCanvas(
    {
        container: document.getElementById('container') as HTMLElement,
        wrapper: document.getElementById('svg-wrapper') as HTMLElement,
        zoomValue: document.getElementById('zoom-value') as HTMLElement,
        minimap: document.getElementById('minimap') as HTMLElement,
        zoomIn: document.getElementById('zoom-in'),
        zoomOut: document.getElementById('zoom-out'),
        zoomFit: document.getElementById('zoom-fit')
    },
    {
        isShowing: () => document.body.dataset.mode === 'diagram',
        isChrome,
        onViewChange: () => persist(),
        onPress: () => setDrawerOpen(false),
        // Adapting to a theme rebuilds the diagram, and the dimming with it.
        onRebuilt: () => {
            lastMatched = null;
            applyHighlight(highlightName, highlightModel);
        }
    }
);

function persist(): void {
    vscode.setState({
        framing: canvas.framing ?? undefined,
        highlightEnabled,
        diag: diagnosticView.getState()
    });
}

/* ------------------------------------------------------------------ modes */

function setMode(mode: ViewMode): void {
    document.body.dataset.mode = mode;
    modeToggle.classList.toggle('active', mode === 'diagnostic');
    modeToggle.setAttribute('aria-pressed', String(mode === 'diagnostic'));
    const modeLabel = mode === 'diagnostic' ? 'Back to diagram view' : 'Diagnostic view';
    modeToggle.dataset.tooltip = modeLabel;
    modeToggle.setAttribute('aria-label', modeLabel);
    if (mode === 'diagram') canvas.refreshMinimap();
    else canvas.hideMinimap();
    // The banner says what is stale, which depends on what is being shown. Written into the text
    // span rather than over the banner: the banner also holds the glyph that tells it apart from
    // the failure banner, and `textContent` on the parent would take that with it.
    bannerText.textContent = mode === 'diagnostic'
        ? 'Unsaved changes — diagnostic reflects last saved version'
        : 'Unsaved changes — showing last saved version';
    // The failure banner speaks about a diagram, and there is not one in every mode.
    applyRenderFailure();
}

/**
 * Both the render and the diagnostic message carry their own `unsaved`, so this no longer keeps
 * a copy: the page has nowhere to read one that the next message would not immediately correct.
 */
function setUnsaved(value: boolean): void {
    banner.classList.toggle('visible', value);
    measureBanners();
}

/**
 * Say that the compiler failed, and offer the one place the reasons are.
 *
 * A render only arrives carrying an error when the compiler produced usable SVG anyway, so there
 * is always a plausible-looking diagram underneath this — which is exactly why the tint alone was
 * not enough. It said something had happened without saying that what was on screen could no
 * longer be trusted.
 */
function setRenderFailure(error: RenderMessage['error']): void {
    renderFailure = renderFailureNotice(error);
    applyRenderFailure();
}

/**
 * Show the failure banner only where it is true.
 *
 * Its wording is about the diagram below it, and its one control offers the diagnostic view — so
 * in the diagnostic view it describes a layer that is not there and points at where the reader
 * already is. The notice is kept rather than dropped, because the diagram it describes is still
 * what comes back when the mode is switched again.
 */
function applyRenderFailure(): void {
    const showing = showsFailureNotice(renderFailure, document.body.dataset.mode as ViewMode);
    errorBannerText.textContent = renderFailure ?? '';
    errorBanner.classList.toggle('visible', showing);
    measureBanners();
}

/**
 * Push the banner stack's height down to the layers.
 *
 * Measured rather than assumed: either banner may be up and on a narrow panel either may wrap, so
 * a constant would be wrong in three of the cases it has to cover. Observed as well as called,
 * since wrapping happens on a resize — no message arrives to prompt a re-measure, and a stale
 * height leaves the layers over the banner they were supposed to clear.
 */
function measureBanners(): void {
    document.body.style.setProperty('--banners-height', `${banners.offsetHeight}px`);
}

function setBusy(busy: boolean): void {
    document.body.classList.toggle('busy', busy);
}

/* ----------------------------------------------------------------- render */

/**
 * Apply a render.
 *
 * Sets every piece of view state from the message, always by toggling rather than adding.
 * When the document was rebuilt for each render, stale state was cleared implicitly; now that
 * the page persists, anything left half-set stays set — a failed compile would tint the panel
 * permanently, for instance.
 */
function applyRender(msg: RenderMessage): void {
    if (msg.revision < lastRevision) return;
    lastRevision = msg.revision;

    diagramName = msg.diagramName;
    lastMatched = null;

    setMode('diagram');
    // A diagram is its model in its document: the framing is kept while both stay the same.
    canvas.show(msg.svg, { documentPath: msg.documentPath, diagramName: msg.diagramName },
        diagramIdentity(msg.documentUri, msg.diagramName));
    setRenderFailure(msg.error);
    setUnsaved(msg.unsaved);
    setBusy(false);

    applyHighlight(msg.highlight, msg.diagramName);
}

/* -------------------------------------------------------------- highlight */

/**
 * `model` is the model the element is declared in. The diagram only ever shows one model, so it
 * ignores it; the symbol table shows them all, and an element id is unique only within its model.
 */
function applyHighlight(name: string | null, model: string | null): void {
    highlightName = name;
    highlightModel = model;
    // The same signal drives both views, but not on the same terms. Dimming a diagram is
    // intrusive enough to be opt-in; marking a row in a table is not, and the control that opts
    // in lives in the diagram toolbar — which the diagnostic view does not show. Gating the
    // symbol table on it would mean leaving the diagnostic view, enabling highlighting, and
    // coming back, to get behaviour the other panel has no say in.
    diagnosticView.setCursorSymbol(name, model);
    const svgEl = canvas.svg;
    if (!svgEl) return;

    if (!highlightEnabled || !name) {
        applyDimming(svgEl, null);
        lastMatched = null;
        return;
    }

    const matched = findElement(svgEl, diagramName, name);
    applyDimming(svgEl, matched);

    // Only reveal when the element itself changes: the cursor moves on every keystroke, and
    // re-centring on each one would make the panel impossible to read.
    if (matched && matched !== lastMatched) {
        lastMatched = matched;
        canvas.reveal(matched);
    } else if (!matched) {
        lastMatched = null;
    }
}

/* ------------------------------------------------------------------ input */

highlightToggle.addEventListener('click', () => {
    highlightEnabled = !highlightEnabled;
    highlightToggle.classList.toggle('active', highlightEnabled);
    highlightToggle.setAttribute('aria-pressed', String(highlightEnabled));
    lastMatched = null;
    applyHighlight(highlightName, highlightModel);
    persist();
});

modeToggle.addEventListener('click', () => vscode.postMessage({ type: 'toggleMode' }));
errorBannerAction.addEventListener('click', () => vscode.postMessage({ type: 'toggleMode' }));

document.getElementById('jpipe-link')?.addEventListener('click', event => {
    event.preventDefault();
    vscode.postMessage({ type: 'openLink', url: 'https://jpipe.org' });
});

document.getElementById('open-settings')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openSettings' });
});

const downloadToggle = document.getElementById('download-toggle');
downloadToggle?.addEventListener('click', event => {
    event.stopPropagation();
    setDrawerOpen(!drawer.classList.contains('open'));
});

function setDrawerOpen(open: boolean): void {
    drawer.classList.toggle('open', open);
    downloadToggle?.setAttribute('aria-expanded', String(open));
}
drawer.addEventListener('click', event => event.stopPropagation());
drawer.querySelectorAll<HTMLElement>('button[data-format]').forEach(btn => {
    btn.addEventListener('click', () => {
        const format = btn.dataset.format;
        if (format) {
            vscode.postMessage({ type: 'download', format });
            setDrawerOpen(false);
        }
    });
});
document.addEventListener('click', () => setDrawerOpen(false));

/**
 * The banner stack changes height on its own when a banner wraps, which a narrow panel makes
 * ordinary — and nothing sends a message when that happens.
 */
new ResizeObserver(() => measureBanners()).observe(banners);

/* --------------------------------------------------------------- messages */

/** Every `type` the host is allowed to send. Anything else is not from our protocol. */
const HOST_MESSAGE_TYPES: ReadonlySet<string> = new Set<HostToWebview['type']>([
    'render', 'highlight', 'setUnsaved', 'view', 'diagnostic', 'diagnosticText', 'busy', 'config'
]);

/**
 * Whether an arriving payload is one of ours.
 *
 * The single place `HostToWebview` is asserted, and it is asserted about an `unknown` — see the
 * listener below for why the event is not typed as carrying one.
 */
function isHostMessage(value: unknown): value is HostToWebview {
    return typeof value === 'object'
        && value !== null
        && HOST_MESSAGE_TYPES.has((value as { type?: unknown }).type as string);
}

/**
 * The panel's inbox.
 *
 * The extension host is the only party that can post here — the panel is an isolated webview
 * whose CSP is `default-src 'none'` — so this listener is not a cross-origin surface in the way
 * the shape of the API suggests. It is not checked by `event.origin` because a webview's origin
 * is an opaque per-session `vscode-webview://` identity rather than anything this code can name,
 * so a comparison would either be vacuous or, if it were wrong, would silently take the whole
 * panel offline. What is checked instead is that the message belongs to the protocol at all,
 * which is the part that would actually matter if something else ever did get to post here.
 *
 * The event is typed `unknown` rather than `MessageEvent<HostToWebview>` on purpose: the latter
 * asserts something the runtime does not provide, since `postMessage` carries whatever the
 * sender put in it, and it would let a later edit reach for a field before validating it.
 *
 * Sonar reports S2819 here and it is marked a false positive on the project: the rule looks for
 * an `event.origin` comparison, and a webview has no cross-origin sender to compare against.
 * Two shapes of inline validation were tried before settling on that; the rule fires on whether
 * it can see `event.data` inspected in this function, not on whether the payload is checked.
 * The predicate above is the clearer arrangement, so it is the one kept.
 */
window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!isHostMessage(event.data)) return;
    const msg = event.data;
    switch (msg.type) {
        case 'render':
            applyRender(msg);
            break;
        case 'highlight':
            applyHighlight(msg.name, msg.model);
            break;
        case 'setUnsaved':
            setUnsaved(msg.unsaved);
            break;
        case 'view':
            setMode(msg.mode);
            setBusy(false);
            break;
        case 'diagnostic':
            if (msg.revision < lastDiagnosticRevision) break;
            lastDiagnosticRevision = msg.revision;
            diagnosticView.show(msg.report, msg.raw);
            setMode('diagnostic');
            setUnsaved(msg.unsaved);
            setBusy(false);
            break;
        case 'diagnosticText':
            // A reply about a run the panel has already moved past describes the previous save.
            if (msg.revision === lastDiagnosticRevision) diagnosticView.showTextReport(msg.text);
            break;
        case 'busy':
            setBusy(msg.busy);
            break;
        case 'config':
            canvas.setZoomSensitivity(msg.zoomSensitivity);
            break;
    }
});

const restored = vscode.getState();
if (restored) {
    if (restored.highlightEnabled) {
        highlightEnabled = true;
        highlightToggle.classList.add('active');
        highlightToggle.setAttribute('aria-pressed', 'true');
    }
    // Seed the framing, so that the replayed render is the same diagram and keeps it rather than
    // re-fitting.
    if (restored.framing) canvas.restoreFraming(restored.framing);
    // Recorded now, applied when the replayed report arrives.
    diagnosticView.restoreState(restored.diag);
}

// The extension replays its last render in response, so a reloaded webview comes back with the
// diagram it had rather than a blank panel.
vscode.postMessage({ type: 'ready' });
