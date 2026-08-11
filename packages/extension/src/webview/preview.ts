import type { HostToWebview, RenderMessage, ViewMode, WebviewToHost } from '../shared/preview-protocol.js';
import { renderFailureNotice, showsFailureNotice } from '../shared/render-failure.js';
import { DiagnosticView, type DiagnosticViewState } from './diagnostic-view.js';
import { adaptToDarkTheme, applyDimming, findElement, stripCaptions } from './highlight.js';
import { Minimap } from './minimap.js';
import {
    type Box,
    type Frame,
    type Size,
    type ViewOrigin,
    type WheelGesture,
    centerOn,
    clampTranslation,
    clientToUser,
    formatViewBox,
    fitToWindowBox,
    initialBox,
    viewOnResize,
    isPannable,
    naturalScale,
    needsPan,
    normalizeAspect,
    panBy,
    parseLength,
    parseViewBox,
    naturalBox,
    stepZoom,
    gestureIntent,
    NO_WHEEL_GESTURE,
    wheelPixels,
    wheelZoomFactor,
    zoomAt,
    zoomPercent
} from './viewbox.js';

/**
 * The preview canvas.
 *
 * Navigation rewrites the root `<svg>`'s `viewBox` rather than scaling a wrapper element.
 * A CSS `transform: scale()` grows a box visually without creating any scroll extent, which is
 * why magnified diagrams used to be clipped at the panel edge with no way to reach the rest.
 *
 * This module is a thin adapter by design: it reads geometry out of the page, hands it to the
 * pure functions in `viewbox.ts`, and writes the result back. There is no browser in the test
 * environment, so the less arithmetic that lives here the better.
 */

/**
 * What survives a webview content reload (`Developer: Reload Webviews`, an extension-host
 * restart). The diagram itself comes back via the `ready` replay; this is what makes it come
 * back framed the way the user left it, which is the whole point of the exercise.
 */
interface PersistedState {
    vb?: Box;
    documentUri?: string | null;
    diagramName?: string | null;
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
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const container = document.getElementById('container') as HTMLElement;
const wrapper = document.getElementById('svg-wrapper') as HTMLElement;
const banners = document.getElementById('banners') as HTMLElement;
const banner = document.getElementById('unsaved-banner') as HTMLElement;
const bannerText = document.getElementById('unsaved-banner-text') as HTMLElement;
const errorBanner = document.getElementById('error-banner') as HTMLElement;
const errorBannerText = document.getElementById('error-banner-text') as HTMLElement;
const errorBannerAction = document.getElementById('error-banner-action') as HTMLElement;

/** The current failure notice, or null. Kept because it outlives the mode it is shown in. */
let renderFailure: string | null = null;
const diagOutput = document.getElementById('diag-output') as HTMLElement;
const zoomValue = document.getElementById('zoom-value') as HTMLElement;
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

/** The current SVG, or null while nothing has rendered. */
let svgEl: SVGSVGElement | null = null;
/** The diagram's full extent in user space, i.e. the viewBox the compiler produced. */
let content: Box | null = null;
/**
 * CSS pixels per user unit at the diagram's intrinsic size — the 100% mark.
 *
 * Graphviz lays out in points, so this is 4/3 rather than 1, and taking it for 1 would put the
 * zoom readout out by a third.
 */
let baseScale = 1;
/** What is on screen. Always the same aspect ratio as the panel. */
let vb: Box | null = null;
/** Set when the SVG carries no usable geometry: navigation is disabled rather than guessed at. */
let navigable = false;

let lastRevision = -1;
/** The diagnostic path is just as async as the render one, and drops stale results the same way. */
let lastDiagnosticRevision = -1;
let lastDocumentUri: string | null = null;
let lastDiagramName: string | null = null;
let diagramName: string | null = null;
/**
 * The compiler's SVG exactly as it arrived, kept so the diagram can be rebuilt without asking
 * for a recompile — which is what following a theme change needs, since adapting to a dark
 * theme throws away the canvas Graphviz painted and cannot be reversed in place.
 */
let lastSvg: string | null = null;
let lastDocumentPath: string | null = null;

/**
 * How the current view came about, which is what a panel resize needs to know.
 *
 * `initial` — untouched since the diagram loaded, so a resize re-derives the opening view.
 *   Preserving on-screen area instead would drift it: the panel settling to its final size just
 *   after the first render was enough to turn a clean 100% into 109%.
 * `fitted` — the user asked to fill the panel, so a resize fills the new panel.
 * `custom` — the user framed it themselves; a resize keeps how much of the diagram is showing.
 */
let viewOrigin: ViewOrigin = 'initial';
/** Multiplier on the wheel zoom step, from the user's settings. */
let zoomSensitivity = 1;
let highlightEnabled = false;
let highlightName: string | null = null;
/** The model `highlightName` belongs to; an element id alone does not identify a row. */
let highlightModel: string | null = null;
let lastMatched: SVGGraphicsElement | null = null;

let animation = 0;
let drag: { pointerId: number; x: number; y: number } | null = null;
/** Which way the in-flight wheel gesture was going, so it cannot change its mind halfway. */
let wheelGesture: WheelGesture = NO_WHEEL_GESTURE;

const minimap = new Minimap(document.getElementById('minimap') as HTMLElement, onMinimapNavigate);

/* ------------------------------------------------------------------ helpers */

function panelSize(): Size {
    const rect = container.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
}

function svgRect(): DOMRect {
    return (svgEl ?? container).getBoundingClientRect();
}

/** The geometry the zoom functions need, sampled from the page as it is now. */
function frame(): Frame | null {
    return content ? { content, viewport: panelSize(), baseScale } : null;
}

function setViewBox(next: Box): void {
    const f = frame();
    if (!svgEl || !f) return;
    vb = next;
    svgEl.setAttribute('viewBox', formatViewBox(next));
    zoomValue.textContent = `${zoomPercent(next, f)}%`;
    container.classList.toggle('pannable', isPannable(next, f.content));
    minimap.update(next, f.content, f.viewport);
    persist();
}

/** Jump to exactly 100%: the diagram at the size the compiler laid it out for. */
function actualSize(): void {
    const f = frame();
    if (!f) return;
    adjusted();
    setViewBox(clampTranslation(naturalBox(f), f.content));
}

/**
 * Fill the panel with the whole diagram, enlarging a small one to do it.
 *
 * Deliberately not the same as the opening view, which caps at intrinsic size. The difference
 * is who asked: opening is automatic and should not inflate a four-node model to fill a wide
 * panel, whereas clicking "fit to window" is a request to do exactly that.
 */
function fit(): void {
    const f = frame();
    if (!f) return;
    cancelAnimation();
    setViewBox(fitToWindowBox(f));
    viewOrigin = 'fitted';
}

/** Record that the view is now the user's rather than one we chose. */
function adjusted(): void {
    viewOrigin = 'custom';
    cancelAnimation();
}

function persist(): void {
    vscode.setState({
        vb: vb ?? undefined,
        documentUri: lastDocumentUri,
        diagramName: lastDiagramName,
        highlightEnabled,
        diag: diagnosticView.getState()
    });
}

function cancelAnimation(): void {
    if (animation) {
        cancelAnimationFrame(animation);
        animation = 0;
    }
}

/** Ease the view to `target`. CSS transitions do not apply to the viewBox attribute. */
function animateTo(target: Box, ms = 220): void {
    cancelAnimation();
    if (reduceMotion.matches || !vb) {
        setViewBox(target);
        return;
    }
    const from = vb;
    const start = performance.now();
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const step = (now: number) => {
        const u = Math.min(1, (now - start) / ms);
        const e = 1 - Math.pow(1 - u, 3);
        setViewBox({
            x: lerp(from.x, target.x, e),
            y: lerp(from.y, target.y, e),
            w: lerp(from.w, target.w, e),
            h: lerp(from.h, target.h, e)
        });
        animation = u < 1 ? requestAnimationFrame(step) : 0;
    };
    animation = requestAnimationFrame(step);
}

/** VS Code stamps the theme kind onto the webview's body element. */
function isDarkTheme(): boolean {
    return document.body.classList.contains('vscode-dark')
        || document.body.classList.contains('vscode-high-contrast');
}

/** True for events the canvas must not swallow — the toolbar and the scrollable diagnostic text. */
function isChrome(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('#toolbar, #diagnostic-overlay, #minimap') !== null;
}

/* -------------------------------------------------------------- the diagram */

/**
 * Establish the diagram's extent.
 *
 * Graphviz always emits a viewBox, but the other routes cost nothing and mean an unexpected
 * compiler build degrades to a static picture rather than a broken panel. Whatever is resolved
 * is written back, so nothing downstream has to repeat the fallback.
 */
function resolveContent(svg: SVGSVGElement): Box | null {
    const fromAttr = parseViewBox(svg.getAttribute('viewBox'));
    if (fromAttr) return fromAttr;

    const w = parseLength(svg.getAttribute('width'));
    const h = parseLength(svg.getAttribute('height'));
    if (w !== null && h !== null) {
        const box = { x: 0, y: 0, w, h };
        svg.setAttribute('viewBox', formatViewBox(box));
        return box;
    }

    try {
        const bbox = svg.getBBox();
        if (bbox.width > 0 && bbox.height > 0) {
            const box = { x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height };
            svg.setAttribute('viewBox', formatViewBox(box));
            return box;
        }
    } catch { /* getBBox throws on an unrendered tree; fall through */ }

    return null;
}

/**
 * Put a freshly compiled SVG into the page.
 *
 * Parsed as XML rather than assigned through innerHTML: the HTML parser reaches SVG attribute
 * casing (`viewBox`, `preserveAspectRatio`) through a fix-up table, and a malformed document
 * surfaces as a detectable `<parsererror>` instead of silently mangled markup.
 *
 * A document the parser rejects is not shown at all. There used to be an `innerHTML = svgText`
 * fallback here, on the reasoning that showing something beats showing nothing — but the text is
 * the compiler's rendering of a user's model, so that line was an HTML injection sink fed by
 * file content. The panel's CSP (`default-src 'none'`, a nonce for scripts and no
 * `'unsafe-inline'`) does block the inline handlers that would exploit it, but that is a
 * defence in another file which nothing ties to this one. Since the only markup that reached
 * the fallback was markup an XML parser had already refused, the honest answer is to drop it:
 * the caller treats `null` as "no diagram", which is true.
 */
function installSvg(svgText: string): SVGSVGElement | null {
    try {
        const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const root = parsed.documentElement;
        if (root.nodeName !== 'parsererror' && root instanceof SVGSVGElement) {
            wrapper.replaceChildren(document.adoptNode(root));
            return root;
        }
    } catch { /* unparseable — fall through and show nothing */ }

    // Clear the canvas, or the previous diagram would sit there looking current.
    wrapper.replaceChildren();
    return null;
}

/* ------------------------------------------------------------------ modes */

function setMode(mode: ViewMode): void {
    document.body.dataset.mode = mode;
    modeToggle.classList.toggle('active', mode === 'diagnostic');
    modeToggle.setAttribute('aria-pressed', String(mode === 'diagnostic'));
    const modeLabel = mode === 'diagnostic' ? 'Back to diagram view' : 'Diagnostic view';
    modeToggle.dataset.tooltip = modeLabel;
    modeToggle.setAttribute('aria-label', modeLabel);
    if (mode !== 'diagram') minimap.hide();
    else if (vb && content) minimap.update(vb, content, panelSize());
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
/**
 * Put the compiler's SVG into the page and make it presentable: caption stripped, adapted to
 * the theme, geometry resolved.
 *
 * Kept separate from `applyRender` because it has to be repeatable. The theme adaptation is
 * destructive — it deletes the canvas Graphviz painted — so following a theme change means
 * rebuilding from the original text rather than trying to undo it.
 */
function installDiagram(): void {
    svgEl = lastSvg === null ? null : installSvg(lastSvg);
    lastMatched = null;

    if (svgEl) {
        stripCaptions(svgEl, lastDocumentPath, diagramName);
        if (isDarkTheme()) adaptToDarkTheme(svgEl);
        content = resolveContent(svgEl);
        baseScale = naturalScale(content ?? { x: 0, y: 0, w: 1, h: 1 }, parseLength(svgEl.getAttribute('width')));
        navigable = content !== null;
        // Serialised now, while the viewBox still spans the whole diagram: panning rewrites it,
        // so a copy taken later would show the current view as though it were the whole thing.
        // Taken from the live element rather than the raw text so the overview matches what the
        // canvas shows, theme adaptation included.
        if (content) minimap.setSource(new XMLSerializer().serializeToString(svgEl));
    } else {
        content = null;
        navigable = false;
    }
}

function applyRender(msg: RenderMessage): void {
    if (msg.revision < lastRevision) return;
    lastRevision = msg.revision;

    const sameDiagram = msg.documentUri === lastDocumentUri && msg.diagramName === lastDiagramName;
    const previous = vb;

    lastSvg = msg.svg;
    lastDocumentPath = msg.documentPath;
    diagramName = msg.diagramName;
    installDiagram();

    setMode('diagram');
    setRenderFailure(msg.error);
    setUnsaved(msg.unsaved);
    setBusy(false);

    if (svgEl && content) {
        // The panel may have been resized while the compiler ran, so a preserved view still
        // has to be re-fitted to the current aspect ratio.
        const f = { content, viewport: panelSize(), baseScale };
        const keep = sameDiagram && previous !== null;
        setViewBox(keep ? clampTranslation(normalizeAspect(previous, f.viewport), content) : initialBox(f));
        if (!keep) viewOrigin = 'initial';
    } else {
        minimap.release();
        minimap.hide();
    }

    lastDocumentUri = msg.documentUri;
    lastDiagramName = msg.diagramName;
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
        revealElement(matched);
    } else if (!matched) {
        lastMatched = null;
    }
}

/**
 * Bring `el` into view if it has drifted off screen.
 *
 * The target box comes from `getBoundingClientRect` mapped back through the client-to-user
 * transform, not from `getBBox`. `getBBox` reports coordinates in the element's own user
 * space, which for a Graphviz node sits under the translate on `g#graph0` — converting would
 * mean composing matrices through `getCTM`, whose exact meaning browsers have disagreed about.
 * The client rect already accounts for every transform including the viewBox mapping, and
 * since `dot` emits `rotate(0)` the axis-aligned result is exact rather than an approximation.
 */
function revealElement(el: SVGGraphicsElement): void {
    if (!vb || !content || !navigable) return;
    const rect = svgRect();
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return;

    const topLeft = clientToUser(box.left, box.top, rect, vb);
    const bottomRight = clientToUser(box.right, box.bottom, rect, vb);
    const target: Box = {
        x: topLeft.x,
        y: topLeft.y,
        w: bottomRight.x - topLeft.x,
        h: bottomRight.y - topLeft.y
    };

    if (!needsPan(target, vb)) return;
    // The view is no longer one we chose, so a later resize must preserve it rather than snap
    // back and undo the reveal.
    viewOrigin = 'custom';
    animateTo(centerOn(vb, target, content));
}

/* ------------------------------------------------------------------ input */

container.addEventListener('wheel', event => {
    const f = frame();
    if (!navigable || !vb || !f || isChrome(event.target)) return;
    // Must be non-passive, or preventDefault is ignored and Electron zooms the whole page,
    // toolbar included.
    event.preventDefault();
    adjusted();

    // Each axis converts against its own viewport extent: a page of horizontal scrolling is a
    // viewport width, not a height.
    const dx = event.deltaX * wheelPixels(event.deltaMode, container.clientWidth);
    const dy = event.deltaY * wheelPixels(event.deltaMode, container.clientHeight);

    // A mouse wheel zooms and a trackpad's two-finger scroll pans, each keeping the gesture the
    // hardware is used for elsewhere. A pinch arrives as ctrl+wheel and always zooms. Decided
    // once per gesture rather than per event, so an accelerating swipe cannot switch mid-flight.
    const decision = gestureIntent(event, performance.now(), wheelGesture);
    wheelGesture = decision.state;
    if (decision.intent === 'pan') {
        setViewBox(panBy(vb, -dx, -dy, svgRect(), f.content));
        return;
    }
    const anchor = clientToUser(event.clientX, event.clientY, svgRect(), vb);
    setViewBox(zoomAt(vb, anchor, wheelZoomFactor(dy, zoomSensitivity), f));
}, { passive: false });

container.addEventListener('pointerdown', event => {
    if (event.button !== 0 && event.button !== 1) return;
    if (isChrome(event.target)) return;
    // The drawer closes on a document click, which preventDefault below would suppress.
    setDrawerOpen(false);
    if (!navigable) return;
    adjusted();
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    container.setPointerCapture(event.pointerId);
    container.classList.add('dragging');
    event.preventDefault();
});

container.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId || !vb || !content) return;
    setViewBox(panBy(vb, event.clientX - drag.x, event.clientY - drag.y, svgRect(), content));
    drag.x = event.clientX;
    drag.y = event.clientY;
});

for (const type of ['pointerup', 'pointercancel'] as const) {
    container.addEventListener(type, event => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        container.releasePointerCapture(event.pointerId);
        container.classList.remove('dragging');
        drag = null;
    });
}

document.addEventListener('keydown', event => {
    // Leave the editor's own Ctrl/Cmd+= and Ctrl/Cmd+0 alone.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.body.dataset.mode !== 'diagram' || !navigable) return;
    if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        zoomStep('in');
    } else if (event.key === '-') {
        event.preventDefault();
        zoomStep('out');
    } else if (event.key === '0') {
        event.preventDefault();
        fit();
    } else if (event.key === '1') {
        event.preventDefault();
        actualSize();
    } else if (PAN_KEYS[event.key]) {
        // Panning without a pointer. The minimap is a mouse convenience; the canvas itself has
        // to be navigable from the keyboard, and arrow keys are what people try first.
        const f = frame();
        if (!vb || !f) return;
        event.preventDefault();
        adjusted();
        const [dx, dy] = PAN_KEYS[event.key];
        const stride = event.shiftKey ? PAN_STRIDE_FAST : PAN_STRIDE;
        setViewBox(panBy(vb, -dx * stride, -dy * stride, svgRect(), f.content));
    }
});

/** Arrow keys, in client pixels per press. Shift moves a screenful at a time. */
const PAN_KEYS: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
};
const PAN_STRIDE = 60;
const PAN_STRIDE_FAST = 300;

function zoomStep(direction: 'in' | 'out'): void {
    const f = frame();
    if (!vb || !f) return;
    adjusted();
    setViewBox(stepZoom(vb, direction, f));
}

document.getElementById('zoom-in')?.addEventListener('click', () => zoomStep('in'));
document.getElementById('zoom-out')?.addEventListener('click', () => zoomStep('out'));
document.getElementById('zoom-fit')?.addEventListener('click', fit);
// Clicking a zoom percentage resets it to 100% in most image editors, and it would otherwise
// just be a second fit button sitting three controls along from the first.
zoomValue.addEventListener('click', actualSize);

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
drawer.querySelectorAll('button[data-format]').forEach(btn => {
    btn.addEventListener('click', () => {
        const format = btn.getAttribute('data-format');
        if (format) {
            vscode.postMessage({ type: 'download', format });
            setDrawerOpen(false);
        }
    });
});
document.addEventListener('click', () => setDrawerOpen(false));

function onMinimapNavigate(left: number, top: number, mm: Size): void {
    if (!vb || !content) return;
    adjusted();
    setViewBox(minimap.toViewBox(vb, left, top, content, mm));
}

/**
 * A resize changes the panel's aspect ratio, which the viewBox has to match or the diagram
 * letterboxes. This also covers the unsaved banner appearing, which shifts the layers down.
 */
new ResizeObserver(() => {
    const f = frame();
    if (!vb || !f || !navigable) return;
    setViewBox(viewOnResize(viewOrigin, vb, f));
}).observe(container);

/**
 * The banner stack changes height on its own when a banner wraps, which a narrow panel makes
 * ordinary — and nothing sends a message when that happens.
 */
new ResizeObserver(() => measureBanners()).observe(banners);

/**
 * Follow the editor's theme while the panel stays open.
 *
 * VS Code swaps the theme class on the body rather than reloading the webview, and the page now
 * outlives many renders, so without this a light-to-dark switch would leave the previous
 * theme's rendering in place until the next compile.
 */
let wasDark = isDarkTheme();
new MutationObserver(() => {
    if (isDarkTheme() === wasDark) return;
    wasDark = !wasDark;
    if (lastSvg === null) return;
    const keep = vb;
    installDiagram();
    if (keep && content) setViewBox(clampTranslation(normalizeAspect(keep, panelSize()), content));
    applyHighlight(highlightName, highlightModel);
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

/* --------------------------------------------------------------- messages */

/** Every `type` the host is allowed to send. Anything else is not from our protocol. */
const HOST_MESSAGE_TYPES: ReadonlySet<string> = new Set<HostToWebview['type']>([
    'render', 'highlight', 'setUnsaved', 'view', 'diagnostic', 'diagnosticText', 'busy', 'config'
]);

/**
 * Whether an arriving payload is one of ours.
 *
 * This is the only place `HostToWebview` is asserted, and it is asserted about a value typed
 * `unknown` — the listener below deliberately does not annotate `MessageEvent<HostToWebview>`.
 * That annotation would be a claim the runtime does not make: `postMessage` carries whatever the
 * sender put in it, so declaring the payload well-typed on arrival makes every field look safe
 * to reach for and lets a later edit skip the check without the compiler objecting.
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
            zoomSensitivity = msg.zoomSensitivity;
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
    // Seed the view so the replayed render counts as "the same diagram" and keeps this frame
    // rather than re-fitting.
    vb = restored.vb ?? null;
    lastDocumentUri = restored.documentUri ?? null;
    lastDiagramName = restored.diagramName ?? null;
    // A restored view is someone's deliberate framing, not one we chose. Leaving it marked
    // `initial` would let the first resize after the replay — which the empty-to-diagram layer
    // switch is enough to trigger — throw it away and snap back to the opening view.
    if (vb) viewOrigin = 'custom';
    // Recorded now, applied when the replayed report arrives.
    diagnosticView.restoreState(restored.diag);
}

// The extension replays its last render in response, so a reloaded webview comes back with the
// diagram it had rather than a blank panel.
vscode.postMessage({ type: 'ready' });
