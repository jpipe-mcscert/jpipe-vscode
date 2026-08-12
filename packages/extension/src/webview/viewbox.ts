/**
 * Pure geometry for the preview canvas.
 *
 * The preview navigates by rewriting the root `<svg>`'s `viewBox` rather than by scaling a
 * wrapper element: `transform: scale()` grows a box visually without creating scroll extent,
 * which is why magnified diagrams used to be clipped at the panel edge and unreachable.
 *
 * Everything here is deliberately free of the DOM and of `vscode`, so it is unit-testable
 * without a browser or an editor host. The DOM adapters (`preview.ts`, `minimap.ts`) read
 * geometry out of the page, call these functions, and write the result back.
 *
 * THE INVARIANT: `vb.w / vb.h === viewport.width / viewport.height` at all times. Under it the
 * default `preserveAspectRatio="xMidYMid meet"` behaves identically to `none` — no letterbox,
 * no distortion — and the client-to-user mapping is a single uniform scale on both axes. Every
 * function here either preserves that ratio or restores it.
 */

/** A rectangle in SVG user space: what the `viewBox` attribute denotes. */
export interface Box { x: number; y: number; w: number; h: number }

/** A point in SVG user space. */
export interface Pt { x: number; y: number }

/** The pixel size of the drawing surface. */
export interface Size { width: number; height: number }

/** The subset of `DOMRect` this module needs, so tests need no DOM. */
export interface Rect { left: number; top: number; width: number; height: number }

/**
 * Everything the zoom functions need about the diagram currently on screen.
 *
 * `baseScale` is the CSS pixels per user unit at which the diagram is drawn at its intrinsic
 * size — the size the compiler laid it out for. That is what 100% means here.
 */
export interface Frame {
    content: Box;
    viewport: Size;
    baseScale: number;
}

export function clamp(v: number, lo: number, hi: number): number {
    // Every call site guarantees lo <= hi, so the standard form is safe: kMin <= kMax,
    // 1/MAX_WHEEL_STEP < MAX_WHEEL_STEP, and clampTranslation's span is content + viewport
    // less twice a 0.25 overlap, which cannot invert.
    return Math.min(Math.max(v, lo), hi);
}

/** Fraction of the content added as breathing room on each side when fitting. */
const FIT_PADDING = 0.03;

/**
 * Parse a `viewBox` attribute. SVG allows either whitespace or commas between the four
 * numbers; Graphviz emits the whitespace form (`"0.00 0.00 428.00 376.00"`).
 *
 * Returns null for anything unusable — a caller that gets null falls back to the element's
 * width/height attributes, then to `getBBox()`, then gives up on pan/zoom for that render.
 */
export function parseViewBox(attr: string | null | undefined): Box | null {
    if (!attr) return null;
    const parts = attr.trim().split(/[\s,]+/);
    if (parts.length !== 4) return null;
    const [x, y, w, h] = parts.map(Number);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
}

/** Serialise a box back into a `viewBox` attribute value. */
export function formatViewBox(b: Box): string {
    return `${b.x} ${b.y} ${b.w} ${b.h}`;
}

/** CSS pixels per unit, for the absolute units SVG allows on `width`/`height`. */
const UNIT_PX: Record<string, number> = {
    '': 1, px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4
};

/**
 * Parse an SVG length into CSS pixels.
 *
 * Graphviz emits points (`width="274pt"`), which is not the same as user units — a diagram at
 * its intrinsic size is drawn a third larger than its viewBox numbers suggest. Getting this
 * wrong would make the 100% zoom level quietly wrong by that factor.
 *
 * Relative units (`%`, `em`, …) have no meaning without a containing block, so they are
 * rejected rather than guessed at.
 */
export function parseLength(attr: string | null | undefined): number | null {
    if (!attr) return null;
    // Trimmed first so the pattern carries no leading or trailing `\s*`. Those two, with a
    // possibly-empty unit between them, could split a run of spaces many ways — the
    // backtracking S8786 reports. `trim()` removes exactly the characters `\s` matches, in
    // linear time. The one remaining `\s*` sits between digits and letters, which are disjoint.
    const match = /^([+-]?[\d.]+(?:e[+-]?\d+)?)\s*([a-z]*)$/i.exec(attr.trim());
    if (!match) return null;
    const value = Number(match[1]);
    const factor = UNIT_PX[match[2].toLowerCase()];
    if (!Number.isFinite(value) || value <= 0 || factor === undefined) return null;
    return value * factor;
}

/** The scale at which the diagram is drawn at the size the compiler laid it out for. */
export function naturalScale(content: Box, intrinsicWidthPx: number | null): number {
    if (intrinsicWidthPx === null || content.w <= 0) return 1;
    return intrinsicWidthPx / content.w;
}

/** CSS pixels per SVG user unit — the scale the user perceives as "zoom". */
export function scaleOf(vb: Box, viewport: Size): number {
    return viewport.width / vb.w;
}

/**
 * The viewBox that frames the whole diagram with a little padding.
 *
 * The result always matches the viewport's aspect ratio (that is the invariant), so one axis
 * gets more than `FIT_PADDING` of slack — whichever axis is not the binding constraint.
 */
export function fitBox(content: Box, viewport: Size, padding: number = FIT_PADDING): Box {
    const aspect = viewport.width / viewport.height;
    const paddedW = content.w * (1 + 2 * padding);
    const paddedH = content.h * (1 + 2 * padding);
    const [w, h] = paddedW / paddedH > aspect
        ? [paddedW, paddedW / aspect]
        : [paddedH * aspect, paddedH];
    return centerOnPoint({ x: 0, y: 0, w, h }, boxCenter(content));
}

/** The viewBox that shows the diagram at a given scale, centred on it. */
export function boxAtScale(frame: Frame, k: number): Box {
    return centerOnPoint(
        { x: 0, y: 0, w: frame.viewport.width / k, h: frame.viewport.height / k },
        boxCenter(frame.content)
    );
}

/** The viewBox showing the diagram at its intrinsic size, centred. */
export function naturalBox(frame: Frame): Box {
    return boxAtScale(frame, frame.baseScale);
}

/**
 * Fill the panel with the diagram, enlarging it if there is room.
 *
 * Distinct from `initialBox`, which caps at intrinsic size. The distinction is who asked: an
 * opening view is chosen for the user and should not inflate a four-node model to fill a wide
 * panel, whereas someone clicking "fit to window" is asking for exactly that.
 *
 * Capped at the same ceiling as every other route to a zoom level, so the control cannot reach
 * a magnification the wheel and the buttons refuse to.
 */
export function fitToWindowBox(frame: Frame): Box {
    const fitted = fitBox(frame.content, frame.viewport);
    const wanted = scaleOf(fitted, frame.viewport);
    const capped = Math.min(wanted, kMax(frame));
    return capped === wanted ? fitted : boxAtScale(frame, capped);
}

/**
 * The view a diagram opens at, and the one the fit control returns to.
 *
 * Intrinsic size when the panel can afford it, shrunk to fit when it cannot. Scaling *up* to
 * fill the panel is deliberately not done: it made a four-node justification fill a wide panel
 * at cartoon size, which is neither useful nor what the compiler laid the diagram out for.
 */
export function initialBox(frame: Frame): Box {
    const fitted = fitBox(frame.content, frame.viewport);
    return scaleOf(fitted, frame.viewport) < frame.baseScale ? fitted : naturalBox(frame);
}

/**
 * The zoom range: a quarter of intrinsic size up to four times it.
 *
 * Anchored on the intrinsic scale rather than on the fit, which is the point. The old ceiling
 * was a multiple of whatever the panel had shrunk the diagram to, so on a large model it capped
 * out while the labels were still unreadable. Measured against the size the compiler laid the
 * diagram out for, 100% is legible by construction whatever the model's size, and 400% is
 * generous magnification rather than a barely-adequate one.
 *
 * The floor also admits the fit scale, since a diagram far too big for the panel must still be
 * viewable in full.
 */
export function kMin(frame: Frame): number {
    return Math.min(scaleOf(fitBox(frame.content, frame.viewport), frame.viewport), frame.baseScale) / 4;
}

export function kMax(frame: Frame): number {
    return frame.baseScale * 4;
}

/**
 * Zoom by `factor` (of the viewBox, so factor < 1 zooms *in*) about a fixed point in user
 * space — the point under the pointer stays under the pointer.
 *
 * The clamp is applied to the resulting *scale*, then the effective factor is re-derived from
 * it. Clamping the factor directly would let the anchor drift out from under the cursor
 * whenever the clamp binds.
 */
export function zoomAt(vb: Box, anchor: Pt, factor: number, frame: Frame): Box {
    const current = scaleOf(vb, frame.viewport);
    const target = clamp(current / factor, kMin(frame), kMax(frame));
    const f = current / target;
    return clampTranslation({
        x: anchor.x - (anchor.x - vb.x) * f,
        y: anchor.y - (anchor.y - vb.y) * f,
        w: vb.w * f,
        h: vb.h * f
    }, frame.content);
}

/** One toolbar/keyboard zoom step, about the centre of the current view. */
export const ZOOM_STEP = 1.25;

export function stepZoom(vb: Box, direction: 'in' | 'out', frame: Frame): Box {
    return zoomAt(vb, boxCenter(vb), direction === 'in' ? 1 / ZOOM_STEP : ZOOM_STEP, frame);
}

/** The zoom readout, where 100% is the diagram at its intrinsic size. */
export function zoomPercent(vb: Box, frame: Frame): number {
    return Math.round(scaleOf(vb, frame.viewport) / frame.baseScale * 100);
}

/* -------------------------------------------------------------------------- */
/* Wheel input                                                                 */
/* -------------------------------------------------------------------------- */

/** The parts of a `WheelEvent` the classification depends on. */
export interface WheelSample {
    deltaMode: number;
    deltaX: number;
    deltaY: number;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
}

export type WheelIntent = 'zoom' | 'pan';

/**
 * A wheel notch is coarse, discrete and purely vertical. A trackpad emits a fast stream of
 * small, often fractional deltas, usually with some horizontal component.
 *
 * The browser reports both as `wheel` events with no flag saying which device produced them,
 * so this is a heuristic — but the two streams are different enough in practice to separate,
 * and getting it right is what lets each device keep its native gesture.
 */
export function isWheelNotch(e: WheelSample): boolean {
    // Line- and page-mode deltas only ever come from a real wheel.
    if (e.deltaMode !== 0) return true;
    if (e.deltaX !== 0) return false;
    if (!Number.isInteger(e.deltaY)) return false;
    return Math.abs(e.deltaY) >= WHEEL_NOTCH_MIN;
}

/** Smallest pixel delta a real wheel notch produces; trackpads routinely emit far less. */
const WHEEL_NOTCH_MIN = 40;

/**
 * What a wheel gesture should do, classifying this event alone.
 *
 * Zoom on a mouse wheel, because that is what was asked for and what the hardware suits; pan on
 * a trackpad's two-finger scroll, because that is what every other application does with it.
 * Ctrl/Cmd always zooms — that is how a pinch arrives — and Shift always pans, so either
 * mapping can be overridden from the keyboard.
 *
 * Prefer `gestureIntent`: a single swipe is a stream of events whose shape drifts as it
 * accelerates, and deciding afresh each time lets one gesture change its mind halfway through.
 */
export function wheelIntent(e: WheelSample): WheelIntent {
    if (e.ctrlKey || e.metaKey) return 'zoom';
    if (e.shiftKey) return 'pan';
    return isWheelNotch(e) ? 'zoom' : 'pan';
}

/** What `gestureIntent` remembers between events. */
export interface WheelGesture {
    intent: WheelIntent | null;
    lastEventTime: number;
}

export const NO_WHEEL_GESTURE: WheelGesture = { intent: null, lastEventTime: -Infinity };

/** Silence long enough to count as the end of one gesture and the start of the next. */
export const WHEEL_GESTURE_GAP_MS = 180;

/**
 * What a wheel gesture should do, holding to the decision for the length of the gesture.
 *
 * A trackpad swipe is not one event but a stream, and its shape changes as it accelerates: the
 * early samples are small and fractional, the accelerated ones can be large, whole and purely
 * vertical — indistinguishable from a wheel notch. Classifying every sample independently
 * therefore lets a single swipe pan for a moment and then abruptly start zooming.
 *
 * So the device inference is made once, when a gesture begins, and held until the stream goes
 * quiet. Modifiers are exempt and take effect immediately: they are an explicit instruction
 * rather than a guess, and they re-latch, so a pinch keeps zooming through the momentum tail
 * after Ctrl is released.
 */
export function gestureIntent(e: WheelSample, now: number, state: WheelGesture): { intent: WheelIntent; state: WheelGesture } {
    const continuing = state.intent !== null && (now - state.lastEventTime) <= WHEEL_GESTURE_GAP_MS;
    let intent: WheelIntent;
    if (e.ctrlKey || e.metaKey) {
        intent = 'zoom';
    } else if (e.shiftKey) {
        intent = 'pan';
    } else {
        intent = continuing ? state.intent as WheelIntent : wheelIntent(e);
    }
    return { intent, state: { intent, lastEventTime: now } };
}

/** Per-event zoom clamp, so one violent flick cannot cross the whole range at once. */
const MAX_WHEEL_STEP = 1.5;
/** Chosen so one 120-unit wheel notch is about 1.2x at the default sensitivity. */
const WHEEL_ZOOM_RATE = 0.0015;

/**
 * Turn a wheel delta into a viewBox scale factor.
 *
 * Exponential in the delta, which makes it symmetric — equal and opposite gestures cancel
 * exactly — and scale-invariant, so a notch feels the same at every zoom level.
 */
export function wheelZoomFactor(deltaY: number, sensitivity = 1): number {
    return clamp(Math.exp(deltaY * WHEEL_ZOOM_RATE * sensitivity), 1 / MAX_WHEEL_STEP, MAX_WHEEL_STEP);
}

/**
 * Pixels per unit for the delta modes: 0 is already pixels, 1 is lines, 2 is pages.
 *
 * `viewportSize` must be the viewport's extent along the axis being converted — a page of
 * horizontal scrolling is a viewport width, not a height.
 */
/**
 * `WheelEvent.deltaMode` values. Named because `1` and `2` at a call site say nothing, and the
 * DOM exposes them only as constants on the event's constructor.
 */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export function wheelPixels(deltaMode: number, viewportSize: number): number {
    switch (deltaMode) {
        case DOM_DELTA_LINE: return 16;
        case DOM_DELTA_PAGE: return viewportSize;
        default:             return 1;
    }
}

/* -------------------------------------------------------------------------- */
/* Resize                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How the current view came about. A resize has to honour the reason, not just the numbers.
 *
 * `initial` — untouched since the diagram loaded.
 * `fitted` — the user asked to fill the panel.
 * `custom` — the user framed it themselves, by zooming, panning or following the cursor.
 */
export type ViewOrigin = 'initial' | 'fitted' | 'custom';

/**
 * The view to adopt when the panel changes size.
 *
 * An untouched view is re-derived rather than adjusted, because adjusting it drifts: preserving
 * on-screen area through the panel settling to its final size just after the first render was
 * enough to turn a clean 100% into 109%. A fitted view re-fits, so it keeps meaning what the
 * user asked for. Only a view someone framed themselves is preserved as-is, and then what is
 * worth preserving is how much of the diagram is showing.
 */
export function viewOnResize(origin: ViewOrigin, vb: Box, frame: Frame): Box {
    if (origin === 'initial') return initialBox(frame);
    if (origin === 'fitted') return fitToWindowBox(frame);
    return clampTranslation(normalizeAspect(vb, frame.viewport), frame.content);
}

/** Pan by a drag delta in client pixels. Dragging right moves the content right, so the viewBox moves left. */
export function panBy(vb: Box, dxClient: number, dyClient: number, rect: Rect, content: Box): Box {
    return clampTranslation({
        x: vb.x - dxClient * vb.w / rect.width,
        y: vb.y - dyClient * vb.h / rect.height,
        w: vb.w,
        h: vb.h
    }, content);
}

/** Map a client (CSS pixel) coordinate to SVG user space. */
export function clientToUser(cx: number, cy: number, rect: Rect, vb: Box): Pt {
    return {
        x: vb.x + (cx - rect.left) * vb.w / rect.width,
        y: vb.y + (cy - rect.top) * vb.h / rect.height
    };
}

/**
 * Restore the aspect invariant after the panel is resized, preserving both the centre of the
 * view and how much of the diagram is on screen.
 *
 * Preserving *area* rather than width or height is what makes a resize feel neutral: widening
 * the panel by a little should not zoom, and picking either axis arbitrarily would.
 */
export function normalizeAspect(vb: Box, viewport: Size): Box {
    if (viewport.width <= 0 || viewport.height <= 0) return vb;
    const k = Math.sqrt((viewport.width * viewport.height) / (vb.w * vb.h));
    return centerOnPoint({ x: 0, y: 0, w: viewport.width / k, h: viewport.height / k }, boxCenter(vb));
}

/** Fraction of the smaller of view/content that must stay overlapping on each axis. */
const MIN_OVERLAP = 0.25;

/**
 * Keep the diagram reachable without pinning it to the edges.
 *
 * Deliberately permissive: it must still be possible to centre an element that sits on the
 * boundary of the diagram, which a strict "never show empty space" clamp would forbid.
 */
export function clampTranslation(vb: Box, content: Box): Box {
    const mx = Math.min(vb.w, content.w) * MIN_OVERLAP;
    const my = Math.min(vb.h, content.h) * MIN_OVERLAP;
    return {
        ...vb,
        x: clamp(vb.x, content.x - vb.w + mx, content.x + content.w - mx),
        y: clamp(vb.y, content.y - vb.h + my, content.y + content.h - my)
    };
}

/** True when there is anywhere to pan to — drives the grab cursor. */
export function isPannable(vb: Box, content: Box): boolean {
    return vb.w < content.w * 0.999 || vb.h < content.h * 0.999;
}

/** Band around the edge of the view within which an element counts as needing to be brought in. */
const REVEAL_MARGIN = 0.08;

/**
 * Whether `target` is off-screen, or close enough to the edge to be effectively unreadable.
 */
export function needsPan(target: Box, vb: Box, margin: number = REVEAL_MARGIN): boolean {
    const mx = vb.w * margin;
    const my = vb.h * margin;
    return target.x < vb.x + mx
        || target.x + target.w > vb.x + vb.w - mx
        || target.y < vb.y + my
        || target.y + target.h > vb.y + vb.h - my;
}

/**
 * Centre the view on `target` without changing the zoom.
 *
 * Zoom is left alone on purpose: adjusting it in response to cursor movement is disorienting
 * and overrides a choice the user made deliberately. The fit control and the minimap cover
 * "show me more" explicitly.
 */
export function centerOn(vb: Box, target: Box, content: Box): Box {
    return clampTranslation(centerOnPoint(vb, boxCenter(target)), content);
}

/* -------------------------------------------------------------------------- */
/* Minimap                                                                     */
/* -------------------------------------------------------------------------- */

/** Where the current view sits within the minimap, in minimap-local pixels. */
export function minimapRect(vb: Box, content: Box, mm: Size): Rect {
    const m = mm.width / content.w;
    return {
        left: (vb.x - content.x) * m,
        top: (vb.y - content.y) * m,
        width: vb.w * m,
        height: vb.h * m
    };
}

/** Move the view so its top-left lands at a minimap-local pixel position. */
export function minimapToViewBox(vb: Box, left: number, top: number, content: Box, mm: Size): Box {
    const m = mm.width / content.w;
    return clampTranslation({ ...vb, x: content.x + left / m, y: content.y + top / m }, content);
}

/**
 * Show the minimap only once it has something to say — i.e. once part of the diagram is off
 * screen. No setting and no button: it appears when you zoom in and vanishes at fit.
 */
export function shouldShowMinimap(vb: Box, content: Box): boolean {
    return vb.w < content.w * 0.9 || vb.h < content.h * 0.9;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function boxCenter(b: Box): Pt {
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function centerOnPoint(b: Box, c: Pt): Box {
    return { x: c.x - b.w / 2, y: c.y - b.h / 2, w: b.w, h: b.h };
}
