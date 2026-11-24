import { adaptToDarkTheme, stripCaptions } from './highlight.js';
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
 * A Graphviz diagram on a pannable, zoomable canvas: what the preview and the run panel share.
 *
 * Navigation rewrites the root `<svg>`'s `viewBox` rather than scaling a wrapper element.
 * A CSS `transform: scale()` grows a box visually without creating any scroll extent, which is
 * why magnified diagrams used to be clipped at the panel edge with no way to reach the rest.
 *
 * This is a thin adapter by design: it reads geometry out of the page, hands it to the pure
 * functions in `viewbox.ts`, and writes the result back. The page that owns it decides what is
 * drawn and when; the canvas only shows it and lets the reader move around it.
 */

/** The parts of the page the canvas drives. */
export interface CanvasElements {
    /** The layer that takes the pointer, the wheel and the keys. */
    container: HTMLElement;
    /** Where the `<svg>` is put. */
    wrapper: HTMLElement;
    /** The zoom readout, which also resets to 100% when clicked. */
    zoomValue: HTMLElement;
    /** The overview map's root, holding `#minimap-img` and `#minimap-rect`. */
    minimap: HTMLElement;
    zoomIn?: HTMLElement | null;
    zoomOut?: HTMLElement | null;
    zoomFit?: HTMLElement | null;
}

/** What the canvas asks of the page that owns it. */
export interface CanvasHooks {
    /** Whether the canvas is the layer on show: the keys pan and zoom only then. */
    isShowing(): boolean;
    /** Whether an event's target is the page's chrome — a toolbar, an overlay — which the canvas leaves alone. */
    isChrome(target: EventTarget | null): boolean;
    /** The view changed. The page persists it. */
    onViewChange(): void;
    /** A press on the canvas, before any pan. The page closes its menus. */
    onPress?(): void;
    /** The diagram was rebuilt for a theme change, so what the page drew over it must be drawn again. */
    onRebuilt?(): void;
    /** A node was clicked, not dragged. `twice` for the second click of a double click. */
    onNodeClick?(node: SVGGElement, twice: boolean): void;
    /** The canvas was clicked, not dragged, away from every node. */
    onBackgroundClick?(): void;
}

/** What a diagram's caption says, so it can be stripped: the panel already says it. */
export interface Caption {
    documentPath: string | null;
    diagramName: string | null;
}

/**
 * What a page persists of the canvas, for a reloaded page to come back framed as the reader left
 * it: the view on screen, and which diagram it frames, so that the replay of that diagram keeps it.
 */
export interface SavedFraming {
    vb: Box;
    /** The diagram's identity, as `show` was given it. */
    on: string;
}

/**
 * A diagram's identity, as `show` takes it: the model `name` in the document `document`. Two
 * diagrams are the same diagram, drawn again, when their identities are equal.
 */
export function diagramIdentity(document: string | null, name: string | null): string {
    return JSON.stringify([document, name]);
}

/** Arrow keys, in client pixels per press. Shift moves a screenful at a time. */
const PAN_KEYS: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
};
const PAN_STRIDE = 60;
const PAN_STRIDE_FAST = 300;
/** How far, in client pixels, a press may move and still be a click rather than a pan. */
const CLICK_SLOP = 4;

export class DiagramCanvas {
    private svgEl: SVGSVGElement | null = null;
    /** The diagram's full extent in user space, i.e. the viewBox the compiler produced. */
    private content: Box | null = null;
    /**
     * CSS pixels per user unit at the diagram's intrinsic size — the 100% mark.
     *
     * Graphviz lays out in points, so this is 4/3 rather than 1, and taking it for 1 would put the
     * zoom readout out by a third.
     */
    private baseScale = 1;
    /** What is on screen. Always the same aspect ratio as the panel. */
    private vb: Box | null = null;
    /** Set when the SVG carries no usable geometry: navigation is disabled rather than guessed at. */
    /** Whether the diagram can be panned and zoomed: it has a frame to move within. */
    private get navigable(): boolean {
        return this.content !== null;
    }
    /**
     * How the current view came about, which is what a panel resize needs to know.
     *
     * `initial` — untouched since the diagram loaded, so a resize re-derives the opening view.
     *   Preserving on-screen area instead would drift it: the panel settling to its final size just
     *   after the first render was enough to turn a clean 100% into 109%.
     * `fitted` — the user asked to fill the panel, so a resize fills the new panel.
     * `custom` — the user framed it themselves; a resize keeps how much of the diagram is showing.
     */
    private viewOrigin: ViewOrigin = 'initial';
    /** Multiplier on the wheel zoom step, from the user's settings. */
    private zoomSensitivity = 1;
    private animation = 0;
    private drag: { pointerId: number; x: number; y: number } | null = null;
    /** Where a press began, and the node under it: what tells a click from a pan. */
    private press: { x: number; y: number; node: SVGGElement | null; moved: boolean } | null = null;
    /** Which way the in-flight wheel gesture was going, so it cannot change its mind halfway. */
    private wheelGesture: WheelGesture = NO_WHEEL_GESTURE;
    /**
     * The SVG exactly as it arrived, kept so the diagram can be rebuilt without asking for it
     * again — which is what following a theme change needs, since adapting to a dark theme throws
     * away the canvas Graphviz painted and cannot be reversed in place.
     */
    private source: { svg: string; caption: Caption } | null = null;
    /**
     * The identity of the diagram the view frames: what tells the same diagram, drawn again, from
     * another. Kept when the canvas is cleared, so that a diagram gone for a while, the drawing of a
     * run between two runs say, comes back framed as it was.
     */
    private framedOn: string | null = null;
    private readonly minimap: Minimap;
    private readonly reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    constructor(private readonly els: CanvasElements, private readonly hooks: CanvasHooks) {
        this.minimap = new Minimap(els.minimap, (left, top, mm) => this.onMinimapNavigate(left, top, mm));
        this.bindInput();
        this.bindControls();
        this.observe();
    }

    /** The diagram on show, or null while there is none. */
    get svg(): SVGSVGElement | null {
        return this.svgEl;
    }

    /** What is on screen. A page persists `framing`, which says which diagram it frames, not this. */
    get view(): Box | null {
        return this.vb;
    }

    /** What is on screen, and which diagram it frames: what the page persists. */
    get framing(): SavedFraming | null {
        return this.vb && this.framedOn !== null ? { vb: this.vb, on: this.framedOn } : null;
    }

    /**
     * Seed the framing a reloaded page was showing, so the diagram replayed into it comes back
     * framed as the reader left it. A restored view is someone's deliberate framing, not one we
     * chose: left `initial`, the first resize after the replay would throw it away.
     */
    restoreFraming(saved: SavedFraming): void {
        this.vb = saved.vb;
        this.framedOn = saved.on;
        this.viewOrigin = 'custom';
    }

    setZoomSensitivity(value: number): void {
        this.zoomSensitivity = value;
    }

    /**
     * Show `svgText`, keeping the current framing when it is the diagram framed last, redrawn, and
     * opening on the initial view otherwise. The diagram is told by `identity`, or else by what its
     * caption names. False when the text is no diagram, which leaves the canvas empty.
     */
    show(svgText: string, caption: Caption, identity = diagramIdentity(caption.documentPath, caption.diagramName)): boolean {
        const previous = this.vb;
        this.source = { svg: svgText, caption };
        this.install();
        const content = this.content;
        if (!this.svgEl || !content) {
            this.minimap.release();
            this.minimap.hide();
            return this.svgEl !== null;
        }
        // The panel may have been resized while the diagram was produced, so a preserved view
        // still has to be re-fitted to the current aspect ratio.
        const f = { content, viewport: this.panelSize(), baseScale: this.baseScale };
        const keep = identity === this.framedOn && previous !== null;
        // Named once its view is set: a diagram that could not be shown leaves the view, and what
        // it frames, as they were.
        this.framedOn = identity;
        this.setViewBox(keep ? clampTranslation(normalizeAspect(previous, f.viewport), content) : initialBox(f));
        if (!keep) this.viewOrigin = 'initial';
        return true;
    }

    /** Take the diagram away. */
    clear(): void {
        this.source = null;
        this.svgEl = null;
        this.content = null;
        this.els.wrapper.replaceChildren();
        this.minimap.release();
        this.minimap.hide();
    }

    /** Take the overview map off screen, for a page whose canvas is not the layer on show. */
    hideMinimap(): void {
        this.minimap.hide();
    }

    /** Show the overview map again, as the current view needs it, once the canvas is back on show. */
    refreshMinimap(): void {
        if (this.vb && this.content) this.minimap.update(this.vb, this.content, this.panelSize());
    }

    /** Jump to exactly 100%: the diagram at the size it was laid out for. */
    actualSize(): void {
        const f = this.frame();
        if (!f) return;
        this.adjusted();
        this.setViewBox(clampTranslation(naturalBox(f), f.content));
    }

    /**
     * Fill the panel with the whole diagram, enlarging a small one to do it.
     *
     * Deliberately not the same as the opening view, which caps at intrinsic size. The difference
     * is who asked: opening is automatic and should not inflate a four-node model to fill a wide
     * panel, whereas clicking "fit to window" is a request to do exactly that.
     */
    fit(): void {
        const f = this.frame();
        if (!f) return;
        this.cancelAnimation();
        this.setViewBox(fitToWindowBox(f));
        this.viewOrigin = 'fitted';
    }

    zoomStep(direction: 'in' | 'out'): void {
        const f = this.frame();
        if (!this.vb || !f) return;
        this.adjusted();
        this.setViewBox(stepZoom(this.vb, direction, f));
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
    reveal(el: Element): void {
        const vb = this.vb;
        const content = this.content;
        if (!vb || !content || !this.navigable) return;
        const rect = this.svgRect();
        const box = el.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) return;

        const topLeft = clientToUser(box.left, box.top, rect, vb);
        const bottomRight = clientToUser(box.right, box.bottom, rect, vb);
        const target: Box = { x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y };

        if (!needsPan(target, vb)) return;
        // The view is no longer one we chose, so a later resize must preserve it rather than snap
        // back and undo the reveal.
        this.viewOrigin = 'custom';
        this.animateTo(centerOn(vb, target, content));
    }

    /* ------------------------------------------------------------------ helpers */

    private panelSize(): Size {
        const rect = this.els.container.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
    }

    private svgRect(): DOMRect {
        return (this.svgEl ?? this.els.container).getBoundingClientRect();
    }

    /** The geometry the zoom functions need, sampled from the page as it is now. */
    private frame(): Frame | null {
        return this.content ? { content: this.content, viewport: this.panelSize(), baseScale: this.baseScale } : null;
    }

    private setViewBox(next: Box): void {
        const f = this.frame();
        if (!this.svgEl || !f) return;
        this.vb = next;
        this.svgEl.setAttribute('viewBox', formatViewBox(next));
        this.els.zoomValue.textContent = `${zoomPercent(next, f)}%`;
        this.els.container.classList.toggle('pannable', isPannable(next, f.content));
        this.minimap.update(next, f.content, f.viewport);
        this.hooks.onViewChange();
    }

    /** Record that the view is now the user's rather than one we chose. */
    private adjusted(): void {
        this.viewOrigin = 'custom';
        this.cancelAnimation();
    }

    private cancelAnimation(): void {
        if (this.animation) {
            cancelAnimationFrame(this.animation);
            this.animation = 0;
        }
    }

    /** Ease the view to `target`. CSS transitions do not apply to the viewBox attribute. */
    private animateTo(target: Box, ms = 220): void {
        this.cancelAnimation();
        const from = this.vb;
        if (this.reduceMotion.matches || !from) {
            this.setViewBox(target);
            return;
        }
        const start = performance.now();
        const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
        const step = (now: number) => {
            const u = Math.min(1, (now - start) / ms);
            const e = 1 - Math.pow(1 - u, 3);
            this.setViewBox({
                x: lerp(from.x, target.x, e),
                y: lerp(from.y, target.y, e),
                w: lerp(from.w, target.w, e),
                h: lerp(from.h, target.h, e)
            });
            this.animation = u < 1 ? requestAnimationFrame(step) : 0;
        };
        this.animation = requestAnimationFrame(step);
    }

    /* -------------------------------------------------------------- the diagram */

    /**
     * Put the SVG into the page and make it presentable: caption stripped, adapted to the theme,
     * geometry resolved. Repeatable, because the theme adaptation is destructive — it deletes the
     * canvas Graphviz painted — so following a theme change means rebuilding from the original
     * text rather than trying to undo it.
     */
    private install(): void {
        this.svgEl = this.source === null ? null : installSvg(this.els.wrapper, this.source.svg);
        if (this.svgEl && this.source) {
            stripCaptions(this.svgEl, this.source.caption.documentPath, this.source.caption.diagramName);
            if (isDarkTheme()) adaptToDarkTheme(this.svgEl);
            this.content = resolveContent(this.svgEl);
            this.baseScale = naturalScale(this.content ?? { x: 0, y: 0, w: 1, h: 1 }, parseLength(this.svgEl.getAttribute('width')));
            // Serialised now, while the viewBox still spans the whole diagram: panning rewrites it,
            // so a copy taken later would show the current view as though it were the whole thing.
            // Taken from the live element rather than the raw text so the overview matches what the
            // canvas shows, theme adaptation included.
            if (this.content) this.minimap.setSource(new XMLSerializer().serializeToString(this.svgEl));
        } else {
            this.content = null;
            }
    }

    /* ------------------------------------------------------------------ input */

    private bindInput(): void {
        const container = this.els.container;
        container.addEventListener('wheel', event => this.onWheel(event), { passive: false });
        container.addEventListener('pointerdown', event => this.onPointerDown(event));
        container.addEventListener('pointermove', event => {
            if (this.press && Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) > CLICK_SLOP) {
                this.press.moved = true;
            }
            const drag = this.drag;
            if (drag?.pointerId !== event.pointerId || !this.vb || !this.content) return;
            this.setViewBox(panBy(this.vb, event.clientX - drag.x, event.clientY - drag.y, this.svgRect(), this.content));
            drag.x = event.clientX;
            drag.y = event.clientY;
        });
        for (const type of ['pointerup', 'pointercancel'] as const) {
            container.addEventListener(type, event => {
                if (this.drag?.pointerId !== event.pointerId) return;
                container.releasePointerCapture(event.pointerId);
                container.classList.remove('dragging');
                this.drag = null;
            });
        }
        // The node is taken from the press, not from the click: once the canvas has captured the
        // pointer to pan, the click is aimed at the canvas itself rather than at what was under it.
        container.addEventListener('click', event => {
            const press = this.press;
            this.press = null;
            if (!press || press.moved) return;
            if (press.node) this.hooks.onNodeClick?.(press.node, event.detail >= 2);
            else this.hooks.onBackgroundClick?.();
        });
        document.addEventListener('keydown', event => this.onKey(event));
    }

    private onWheel(event: WheelEvent): void {
        const f = this.frame();
        const vb = this.vb;
        if (!this.navigable || !vb || !f || this.hooks.isChrome(event.target)) return;
        // Must be non-passive, or preventDefault is ignored and Electron zooms the whole page,
        // toolbar included.
        event.preventDefault();
        this.adjusted();

        // Each axis converts against its own viewport extent: a page of horizontal scrolling is a
        // viewport width, not a height.
        const container = this.els.container;
        const dx = event.deltaX * wheelPixels(event.deltaMode, container.clientWidth);
        const dy = event.deltaY * wheelPixels(event.deltaMode, container.clientHeight);

        // A mouse wheel zooms and a trackpad's two-finger scroll pans, each keeping the gesture the
        // hardware is used for elsewhere. A pinch arrives as ctrl+wheel and always zooms. Decided
        // once per gesture rather than per event, so an accelerating swipe cannot switch mid-flight.
        const decision = gestureIntent(event, performance.now(), this.wheelGesture);
        this.wheelGesture = decision.state;
        if (decision.intent === 'pan') {
            this.setViewBox(panBy(vb, -dx, -dy, this.svgRect(), f.content));
            return;
        }
        const anchor = clientToUser(event.clientX, event.clientY, this.svgRect(), vb);
        this.setViewBox(zoomAt(vb, anchor, wheelZoomFactor(dy, this.zoomSensitivity), f));
    }

    private onPointerDown(event: PointerEvent): void {
        if (event.button !== 0 && event.button !== 1) return;
        if (this.hooks.isChrome(event.target)) return;
        const node = event.target instanceof Element ? event.target.closest('g.node') : null;
        this.press = { x: event.clientX, y: event.clientY, node: node as SVGGElement | null, moved: false };
        // The page's menus close on a document click, which preventDefault below would suppress.
        this.hooks.onPress?.();
        if (!this.navigable) return;
        this.adjusted();
        this.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        this.els.container.setPointerCapture(event.pointerId);
        this.els.container.classList.add('dragging');
        event.preventDefault();
    }

    private onKey(event: KeyboardEvent): void {
        // Leave the editor's own Ctrl/Cmd+= and Ctrl/Cmd+0 alone.
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (!this.hooks.isShowing() || !this.navigable) return;
        const zoomKeys: Record<string, () => void> = {
            '=': () => this.zoomStep('in'),
            '+': () => this.zoomStep('in'),
            '-': () => this.zoomStep('out'),
            '0': () => this.fit(),
            '1': () => this.actualSize()
        };
        const zoom = zoomKeys[event.key];
        if (zoom) {
            event.preventDefault();
            zoom();
            return;
        }
        // Panning without a pointer. The minimap is a mouse convenience; the canvas itself has to
        // be navigable from the keyboard, and arrow keys are what people try first.
        const pan = PAN_KEYS[event.key];
        const f = this.frame();
        if (!pan || !this.vb || !f) return;
        event.preventDefault();
        this.adjusted();
        const stride = event.shiftKey ? PAN_STRIDE_FAST : PAN_STRIDE;
        this.setViewBox(panBy(this.vb, -pan[0] * stride, -pan[1] * stride, this.svgRect(), f.content));
    }

    private bindControls(): void {
        this.els.zoomIn?.addEventListener('click', () => this.zoomStep('in'));
        this.els.zoomOut?.addEventListener('click', () => this.zoomStep('out'));
        this.els.zoomFit?.addEventListener('click', () => this.fit());
        // Clicking a zoom percentage resets it to 100% in most image editors, and it would otherwise
        // just be a second fit button sitting three controls along from the first.
        this.els.zoomValue.addEventListener('click', () => this.actualSize());
    }

    private onMinimapNavigate(left: number, top: number, mm: Size): void {
        if (!this.vb || !this.content) return;
        this.adjusted();
        this.setViewBox(this.minimap.toViewBox(this.vb, left, top, this.content, mm));
    }

    private observe(): void {
        // A resize changes the panel's aspect ratio, which the viewBox has to match or the diagram
        // letterboxes. This also covers a banner appearing, which shifts the layers down.
        new ResizeObserver(() => {
            const f = this.frame();
            if (!this.vb || !f || !this.navigable) return;
            this.setViewBox(viewOnResize(this.viewOrigin, this.vb, f));
        }).observe(this.els.container);

        // Follow the editor's theme while the panel stays open. VS Code swaps the theme class on
        // the body rather than reloading the webview, and the page outlives many renders, so
        // without this a light-to-dark switch would leave the previous theme's rendering in place
        // until the next one.
        let wasDark = isDarkTheme();
        new MutationObserver(() => {
            if (isDarkTheme() === wasDark) return;
            wasDark = !wasDark;
            if (this.source === null) return;
            const keep = this.vb;
            this.install();
            if (keep && this.content) this.setViewBox(clampTranslation(normalizeAspect(keep, this.panelSize()), this.content));
            this.hooks.onRebuilt?.();
        }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
}

/** VS Code stamps the theme kind onto the webview's body element. */
export function isDarkTheme(): boolean {
    return document.body.classList.contains('vscode-dark')
        || document.body.classList.contains('vscode-high-contrast');
}

/**
 * Establish the diagram's extent.
 *
 * Graphviz always emits a viewBox, but the other routes cost nothing and mean an unexpected
 * build degrades to a static picture rather than a broken panel. Whatever is resolved is written
 * back, so nothing downstream has to repeat the fallback.
 */
export function resolveContent(svg: SVGSVGElement): Box | null {
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
 * Put an SVG document into `wrapper`.
 *
 * Parsed as XML rather than assigned through innerHTML: the HTML parser reaches SVG attribute
 * casing (`viewBox`, `preserveAspectRatio`) through a fix-up table, and a malformed document
 * surfaces as a detectable `<parsererror>` instead of silently mangled markup.
 *
 * A document the parser rejects is not shown at all. There used to be an `innerHTML = svgText`
 * fallback here, on the reasoning that showing something beats showing nothing — but the text is
 * a rendering of a user's model, so that line was an HTML injection sink fed by file content. The
 * panel's CSP (`default-src 'none'`, a nonce for scripts and no `'unsafe-inline'`) does block the
 * inline handlers that would exploit it, but that is a defence in another file which nothing ties
 * to this one. Since the only markup that reached the fallback was markup an XML parser had
 * already refused, the honest answer is to drop it: the caller treats `null` as "no diagram",
 * which is true.
 */
export function installSvg(wrapper: HTMLElement, svgText: string): SVGSVGElement | null {
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
