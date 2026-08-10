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
    return v < lo ? lo : v > hi ? hi : v;
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
    const match = /^\s*([+-]?[\d.]+(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i.exec(attr);
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

/** The viewBox showing the diagram at its intrinsic size, centred. */
export function naturalBox(frame: Frame): Box {
    const { content, viewport, baseScale } = frame;
    return centerOnPoint(
        { x: 0, y: 0, w: viewport.width / baseScale, h: viewport.height / baseScale },
        boxCenter(content)
    );
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
