import type { HostToWebview, RenderMessage, ViewMode, WebviewToHost } from '../shared/preview-protocol.js';
import { adaptToDarkTheme, applyDimming, findElement, stripCaptions } from './highlight.js';
import { Minimap } from './minimap.js';
import {
    type Box,
    type Frame,
    type Size,
    type WheelGesture,
    centerOn,
    clampTranslation,
    clientToUser,
    formatViewBox,
    initialBox,
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
const banner = document.getElementById('unsaved-banner') as HTMLElement;
const diagOutput = document.getElementById('diag-output') as HTMLElement;
const zoomValue = document.getElementById('zoom-value') as HTMLElement;
const highlightToggle = document.getElementById('highlight-toggle') as HTMLElement;
const modeToggle = document.getElementById('mode-toggle') as HTMLElement;
const drawer = document.getElementById('download-drawer') as HTMLElement;

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
 * True while the view is still exactly what the diagram opened at.
 *
 * It decides what a panel resize does. Preserving how much of the diagram is on screen is the
 * right answer once someone has chosen a zoom, but applying it to an untouched view drifts off
 * the default: the panel settling to its final size just after the first render was enough to
 * turn a clean 100% into 109%.
 */
let pristine = true;
/** Multiplier on the wheel zoom step, from the user's settings. */
let zoomSensitivity = 1;
let unsaved = false;
let highlightEnabled = false;
let highlightName: string | null = null;
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

/** Back to the view the diagram opened at: intrinsic size, or shrunk if it does not fit. */
function fit(): void {
    const f = frame();
    if (!f) return;
    setViewBox(initialBox(f));
    pristine = true;
}

/** Record that the view is now the user's rather than the default. */
function adjusted(): void {
    pristine = false;
    cancelAnimation();
}

function persist(): void {
    vscode.setState({
        vb: vb ?? undefined,
        documentUri: lastDocumentUri,
        diagramName: lastDiagramName,
        highlightEnabled
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
 */
function installSvg(svgText: string): SVGSVGElement | null {
    try {
        const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const root = parsed.documentElement;
        if (root.nodeName !== 'parsererror' && root instanceof SVGSVGElement) {
            wrapper.replaceChildren(document.adoptNode(root));
            return root;
        }
    } catch { /* fall through to the forgiving path */ }

    wrapper.innerHTML = svgText;
    return wrapper.querySelector('svg');
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
    // The banner says what is stale, which depends on what is being shown.
    banner.textContent = mode === 'diagnostic'
        ? '⚠ Unsaved changes — diagnostic reflects last saved version'
        : '⚠ Unsaved changes — showing last saved version';
}

function setUnsaved(value: boolean): void {
    unsaved = value;
    banner.classList.toggle('visible', value);
    document.body.classList.toggle('has-unsaved-banner', value);
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
    document.body.classList.toggle('jpipe-render-error', msg.error !== null);
    setUnsaved(msg.unsaved);
    setBusy(false);

    if (svgEl && content) {
        // The panel may have been resized while the compiler ran, so a preserved view still
        // has to be re-fitted to the current aspect ratio.
        const f = { content, viewport: panelSize(), baseScale };
        const keep = sameDiagram && previous !== null;
        setViewBox(keep ? clampTranslation(normalizeAspect(previous, f.viewport), content) : initialBox(f));
        if (!keep) pristine = true;
    } else {
        minimap.release();
        minimap.hide();
    }

    lastDocumentUri = msg.documentUri;
    lastDiagramName = msg.diagramName;
    applyHighlight(msg.highlight);
}

/* -------------------------------------------------------------- highlight */

function applyHighlight(name: string | null): void {
    highlightName = name;
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
    // The view is no longer the default framing, so a later resize must preserve it rather
    // than snap back and undo the reveal.
    pristine = false;
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
    applyHighlight(highlightName);
    persist();
});

modeToggle.addEventListener('click', () => vscode.postMessage({ type: 'toggleMode' }));

document.getElementById('jpipe-link')?.addEventListener('click', event => {
    event.preventDefault();
    vscode.postMessage({ type: 'openLink', url: 'https://jpipe.org' });
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
    setViewBox(pristine ? initialBox(f) : clampTranslation(normalizeAspect(vb, f.viewport), f.content));
}).observe(container);

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
    applyHighlight(highlightName);
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

/* --------------------------------------------------------------- messages */

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
    const msg = event.data;
    switch (msg.type) {
        case 'render':
            applyRender(msg);
            break;
        case 'highlight':
            applyHighlight(msg.name);
            break;
        case 'setUnsaved':
            setUnsaved(msg.unsaved);
            break;
        case 'view':
            setMode(msg.mode);
            setBusy(false);
            break;
        case 'diagnostic':
            // textContent, so compiler output can never be interpreted as markup.
            diagOutput.textContent = msg.output;
            setMode('diagnostic');
            setUnsaved(unsaved);
            setBusy(false);
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
    // A restored view is someone's deliberate framing, not the default one. Leaving it marked
    // pristine would let the first resize after the replay — which the empty-to-diagram layer
    // switch is enough to trigger — throw it away and snap back to the opening view.
    if (vb) pristine = false;
}

// The extension replays its last render in response, so a reloaded webview comes back with the
// diagram it had rather than a blank panel.
vscode.postMessage({ type: 'ready' });
