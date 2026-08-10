import { describe, expect, test } from 'vitest';
import {
    type Box,
    type Frame,
    type Rect,
    type Size,
    type WheelIntent,
    centerOn,
    clampTranslation,
    clientToUser,
    boxAtScale,
    fitBox,
    fitToWindowBox,
    initialBox,
    isPannable,
    kMax,
    kMin,
    naturalBox,
    naturalScale,
    minimapRect,
    minimapToViewBox,
    needsPan,
    normalizeAspect,
    panBy,
    parseLength,
    parseViewBox,
    scaleOf,
    shouldShowMinimap,
    stepZoom,
    viewOnResize,
    gestureIntent,
    NO_WHEEL_GESTURE,
    WHEEL_GESTURE_GAP_MS,
    wheelIntent,
    wheelPixels,
    wheelZoomFactor,
    zoomAt,
    zoomPercent
} from '../src/webview/viewbox.js';

/**
 * This is the geometry the preview canvas navigates by. It has no DOM and no editor host, so
 * it is the only part of the preview that can be checked automatically — everything else
 * (gestures, the SVG itself, the CSP) is an Extension Development Host check. That makes the
 * invariants below worth stating explicitly rather than testing by eyeball.
 */

/** A landscape panel, and the Graphviz output of a typical model. */
const VIEWPORT: Size = { width: 800, height: 600 };
const CONTENT: Box = { x: 0, y: 0, w: 428, h: 376 };

/** Graphviz lays out in points, so a diagram at intrinsic size is 4/3 px per user unit. */
const BASE = 4 / 3;

function frameOf(content: Box = CONTENT, viewport: Size = VIEWPORT, baseScale = BASE): Frame {
    return { content, viewport, baseScale };
}

/** The client rect of an <svg> that fills the panel below the 44px toolbar. */
function rectOf(viewport: Size, left = 0, top = 44): Rect {
    return { left, top, width: viewport.width, height: viewport.height };
}

const aspect = (b: Box | Size) => 'w' in b ? b.w / b.h : b.width / b.height;

describe('parseViewBox', () => {
    test.each([
        ['the Graphviz form', '0.00 0.00 428.00 376.00', { x: 0, y: 0, w: 428, h: 376 }],
        ['comma separated', '0,0,428,376', { x: 0, y: 0, w: 428, h: 376 }],
        ['comma and space', '0, 0, 428, 376', { x: 0, y: 0, w: 428, h: 376 }],
        ['surrounding whitespace', '  0 0 428 376\n', { x: 0, y: 0, w: 428, h: 376 }],
        ['a negative origin', '-4 -8 428 376', { x: -4, y: -8, w: 428, h: 376 }],
        ['exponent notation', '0 0 4.28e2 3.76e2', { x: 0, y: 0, w: 428, h: 376 }]
    ])('parses %s', (_label, attr, expected) => {
        expect(parseViewBox(attr)).toEqual(expected);
    });

    test.each([
        ['null', null],
        ['undefined', undefined],
        ['an empty string', ''],
        ['whitespace only', '   '],
        ['garbage', 'not a viewBox'],
        ['too few numbers', '0 0 428'],
        ['too many numbers', '0 0 428 376 12'],
        ['a non-numeric member', '0 0 428 abc'],
        ['Infinity', '0 0 Infinity 376'],
        ['zero width', '0 0 0 376'],
        ['zero height', '0 0 428 0'],
        ['negative width', '0 0 -428 376']
    ])('rejects %s', (_label, attr) => {
        expect(parseViewBox(attr)).toBeNull();
    });
});

describe('fitBox', () => {
    test('matches the viewport aspect ratio — the invariant everything else rests on', () => {
        for (const content of [CONTENT, { x: 0, y: 0, w: 3000, h: 200 }, { x: 0, y: 0, w: 200, h: 3000 }]) {
            for (const viewport of [VIEWPORT, { width: 400, height: 900 }, { width: 640, height: 640 }]) {
                expect(aspect(fitBox(content, viewport))).toBeCloseTo(aspect(viewport), 9);
            }
        }
    });

    test('content wider than the viewport binds on width, leaving vertical slack', () => {
        const wide: Box = { x: 0, y: 0, w: 3000, h: 200 };
        const fitted = fitBox(wide, VIEWPORT, 0.03);
        expect(fitted.w).toBeCloseTo(3000 * 1.06, 9);
        expect(fitted.h).toBeGreaterThan(200 * 1.06);
    });

    test('content taller than the viewport binds on height, leaving horizontal slack', () => {
        const tall: Box = { x: 0, y: 0, w: 200, h: 3000 };
        const fitted = fitBox(tall, VIEWPORT, 0.03);
        expect(fitted.h).toBeCloseTo(3000 * 1.06, 9);
        expect(fitted.w).toBeGreaterThan(200 * 1.06);
    });

    test('keeps the content centred, including a non-zero origin', () => {
        const offset: Box = { x: -100, y: 250, w: 428, h: 376 };
        const fitted = fitBox(offset, VIEWPORT);
        expect(fitted.x + fitted.w / 2).toBeCloseTo(offset.x + offset.w / 2, 9);
        expect(fitted.y + fitted.h / 2).toBeCloseTo(offset.y + offset.h / 2, 9);
    });

    test('applies the padding, and applies more of it when asked', () => {
        const square: Box = { x: 0, y: 0, w: 100, h: 100 };
        const viewport: Size = { width: 500, height: 500 };
        expect(fitBox(square, viewport, 0).w).toBeCloseTo(100, 9);
        expect(fitBox(square, viewport, 0.1).w).toBeCloseTo(120, 9);
    });

    test('the whole diagram is inside the fitted view', () => {
        const fitted = fitBox(CONTENT, VIEWPORT);
        expect(fitted.x).toBeLessThanOrEqual(CONTENT.x);
        expect(fitted.y).toBeLessThanOrEqual(CONTENT.y);
        expect(fitted.x + fitted.w).toBeGreaterThanOrEqual(CONTENT.x + CONTENT.w);
        expect(fitted.y + fitted.h).toBeGreaterThanOrEqual(CONTENT.y + CONTENT.h);
    });
});

describe('normalizeAspect', () => {
    const resized: Size = { width: 500, height: 900 };

    test('is a no-op when the aspects already agree', () => {
        const vb = fitBox(CONTENT, VIEWPORT);
        expect(normalizeAspect(vb, VIEWPORT)).toEqual(vb);
    });

    test('adopts the new viewport aspect', () => {
        const vb = fitBox(CONTENT, VIEWPORT);
        expect(aspect(normalizeAspect(vb, resized))).toBeCloseTo(aspect(resized), 9);
    });

    test('preserves the centre of the view', () => {
        const vb: Box = { x: 100, y: 50, w: 200, h: 150 };
        const out = normalizeAspect(vb, resized);
        expect(out.x + out.w / 2).toBeCloseTo(vb.x + vb.w / 2, 9);
        expect(out.y + out.h / 2).toBeCloseTo(vb.y + vb.h / 2, 9);
    });

    test('preserves area, so a resize does not silently zoom', () => {
        const vb: Box = { x: 100, y: 50, w: 200, h: 150 };
        const out = normalizeAspect(vb, resized);
        expect(out.w * out.h).toBeCloseTo(vb.w * vb.h, 6);
    });

    test('is idempotent', () => {
        const once = normalizeAspect({ x: 100, y: 50, w: 200, h: 150 }, resized);
        expect(normalizeAspect(once, resized)).toEqual(once);
    });
});

describe('clientToUser', () => {
    const vb: Box = { x: 10, y: 20, w: 400, h: 300 };
    const rect = rectOf(VIEWPORT);

    test('maps the four corners of the rect to the four corners of the viewBox', () => {
        expect(clientToUser(rect.left, rect.top, rect, vb)).toEqual({ x: 10, y: 20 });
        expect(clientToUser(rect.left + rect.width, rect.top, rect, vb)).toEqual({ x: 410, y: 20 });
        expect(clientToUser(rect.left, rect.top + rect.height, rect, vb)).toEqual({ x: 10, y: 320 });
        const br = clientToUser(rect.left + rect.width, rect.top + rect.height, rect, vb);
        expect(br).toEqual({ x: 410, y: 320 });
    });

    test('maps the centre to the centre', () => {
        const c = clientToUser(rect.left + rect.width / 2, rect.top + rect.height / 2, rect, vb);
        expect(c.x).toBeCloseTo(vb.x + vb.w / 2, 9);
        expect(c.y).toBeCloseTo(vb.y + vb.h / 2, 9);
    });

    test('honours a rect that is not at the origin', () => {
        const offset = rectOf(VIEWPORT, 250, 120);
        expect(clientToUser(250, 120, offset, vb)).toEqual({ x: 10, y: 20 });
    });

    test('honours a negative viewBox origin', () => {
        const negative: Box = { x: -200, y: -150, w: 400, h: 300 };
        expect(clientToUser(rect.left, rect.top, rect, negative)).toEqual({ x: -200, y: -150 });
    });
});

describe('zoomAt', () => {
    const rect = rectOf(VIEWPORT);

    test('keeps the anchor point under the pointer — the whole point of zoom-at-cursor', () => {
        const client = { x: 610, y: 180 };
        let vb = fitBox(CONTENT, VIEWPORT);
        for (const factor of [1 / 1.25, 1 / 1.25, 1.4, 1 / 3, 2]) {
            const anchor = clientToUser(client.x, client.y, rect, vb);
            vb = zoomAt(vb, anchor, factor, frameOf());
            const after = clientToUser(client.x, client.y, rect, vb);
            expect(after.x).toBeCloseTo(anchor.x, 6);
            expect(after.y).toBeCloseTo(anchor.y, 6);
        }
    });

    test('a factor of 1 is the identity', () => {
        const vb = fitBox(CONTENT, VIEWPORT);
        const out = zoomAt(vb, { x: 100, y: 100 }, 1, frameOf());
        expect(out.w).toBeCloseTo(vb.w, 9);
        expect(out.h).toBeCloseTo(vb.h, 9);
    });

    test('scales the viewBox by exactly the factor when the clamp does not bind', () => {
        const vb = fitBox(CONTENT, VIEWPORT);
        const out = zoomAt(vb, boxCenterOf(vb), 1 / 1.25, frameOf());
        expect(out.w).toBeCloseTo(vb.w / 1.25, 9);
        expect(out.h).toBeCloseTo(vb.h / 1.25, 9);
    });

    test('preserves the aspect invariant', () => {
        const vb = zoomAt(fitBox(CONTENT, VIEWPORT), { x: 100, y: 100 }, 1 / 2.5, frameOf());
        expect(aspect(vb)).toBeCloseTo(aspect(VIEWPORT), 9);
    });

    test('zooming in past the ceiling lands exactly on it, never past', () => {
        let vb = fitBox(CONTENT, VIEWPORT);
        for (let i = 0; i < 60; i++) vb = zoomAt(vb, boxCenterOf(vb), 1 / 1.25, frameOf());
        expect(scaleOf(vb, VIEWPORT)).toBeCloseTo(kMax(frameOf()), 6);
    });

    test('zooming out past the floor lands exactly on it, never past', () => {
        let vb = fitBox(CONTENT, VIEWPORT);
        for (let i = 0; i < 60; i++) vb = zoomAt(vb, boxCenterOf(vb), 1.25, frameOf());
        expect(scaleOf(vb, VIEWPORT)).toBeCloseTo(kMin(frameOf()), 6);
    });

    test('the anchor still holds when the clamp binds', () => {
        const client = { x: 700, y: 500 };
        let vb = fitBox(CONTENT, VIEWPORT);
        for (let i = 0; i < 40; i++) vb = zoomAt(vb, clientToUser(client.x, client.y, rect, vb), 1 / 1.25, frameOf());
        // At the ceiling a further zoom must be a complete no-op, not a drift.
        const anchor = clientToUser(client.x, client.y, rect, vb);
        const after = zoomAt(vb, anchor, 1 / 1.25, frameOf());
        expect(clientToUser(client.x, client.y, rect, after).x).toBeCloseTo(anchor.x, 6);
    });

    test('the ceiling is 400% of intrinsic size, whatever the model is worth', () => {
        const huge = frameOf({ x: 0, y: 0, w: 40000, h: 30000 });
        const small = frameOf({ x: 0, y: 0, w: 40, h: 30 });
        expect(kMax(huge) / huge.baseScale).toBeCloseTo(4, 9);
        expect(kMax(small) / small.baseScale).toBeCloseTo(4, 9);
    });

    test('a model far too big for the panel can still be zoomed out to see whole', () => {
        const huge = frameOf({ x: 0, y: 0, w: 40000, h: 30000 });
        expect(kMin(huge)).toBeLessThan(scaleOf(fitBox(huge.content, VIEWPORT), VIEWPORT));
    });
});

describe('parseLength', () => {
    test.each([
        ['the Graphviz form', '274pt', 274 * 4 / 3],
        ['pixels', '274px', 274],
        ['a bare number', '274', 274],
        ['inches', '2in', 192],
        ['picas', '3pc', 48],
        ['centimetres', '2.54cm', 96],
        ['millimetres', '25.4mm', 96],
        ['surrounding whitespace', ' 274pt ', 274 * 4 / 3],
        ['an uppercase unit', '274PT', 274 * 4 / 3]
    ])('parses %s', (_label, attr, expected) => {
        expect(parseLength(attr)).toBeCloseTo(expected as number, 9);
    });

    test.each([
        ['null', null],
        ['undefined', undefined],
        ['an empty string', ''],
        ['garbage', 'wide'],
        ['a percentage, which needs a containing block', '100%'],
        ['a font-relative unit', '20em'],
        ['zero', '0pt'],
        ['a negative length', '-10pt']
    ])('rejects %s', (_label, attr) => {
        expect(parseLength(attr)).toBeNull();
    });
});

describe('naturalScale', () => {
    test('turns the Graphviz point size into pixels per user unit', () => {
        expect(naturalScale({ x: 0, y: 0, w: 274, h: 213 }, 274 * 4 / 3)).toBeCloseTo(4 / 3, 9);
    });

    test('falls back to 1:1 when the intrinsic size is unusable', () => {
        expect(naturalScale(CONTENT, null)).toBe(1);
    });
});

describe('initialBox', () => {
    /**
     * The rule the panel opens on: intrinsic size when it fits, shrunk when it does not, and
     * never blown up. A four-node justification filling a wide panel was the complaint that
     * put this here.
     */
    test('a small diagram opens at intrinsic size, not stretched to fill the panel', () => {
        const frame = frameOf({ x: 0, y: 0, w: 100, h: 80 });
        expect(zoomPercent(initialBox(frame), frame)).toBe(100);
    });

    test('and is centred, with the slack around it', () => {
        const frame = frameOf({ x: 0, y: 0, w: 100, h: 80 });
        const box = initialBox(frame);
        expect(box.x + box.w / 2).toBeCloseTo(50, 9);
        expect(box.y + box.h / 2).toBeCloseTo(40, 9);
        expect(box.w).toBeGreaterThan(100);
    });

    test('a diagram too big for the panel is shrunk to fit', () => {
        const frame = frameOf({ x: 0, y: 0, w: 4000, h: 3000 });
        expect(initialBox(frame)).toEqual(fitBox(frame.content, VIEWPORT));
        expect(zoomPercent(initialBox(frame), frame)).toBeLessThan(100);
    });

    test('the whole of an oversized diagram is visible', () => {
        const frame = frameOf({ x: 0, y: 0, w: 4000, h: 3000 });
        const box = initialBox(frame);
        expect(box.x).toBeLessThanOrEqual(0);
        expect(box.x + box.w).toBeGreaterThanOrEqual(4000);
    });

    test('matches the panel aspect either way', () => {
        for (const content of [{ x: 0, y: 0, w: 100, h: 80 }, { x: 0, y: 0, w: 4000, h: 3000 }]) {
            expect(aspect(initialBox(frameOf(content)))).toBeCloseTo(aspect(VIEWPORT), 9);
        }
    });

    test('naturalBox reads exactly 100% by construction', () => {
        expect(zoomPercent(naturalBox(frameOf()), frameOf())).toBe(100);
    });
});

describe('fitToWindowBox', () => {
    /**
     * The fit control and the opening view diverge on purpose: opening is automatic and caps at
     * intrinsic size so a four-node model does not fill a wide panel, while clicking "fit to
     * window" is a request to fill it.
     */
    test('enlarges a small diagram to fill the panel, unlike the opening view', () => {
        const frame = frameOf({ x: 0, y: 0, w: 100, h: 80 });
        expect(zoomPercent(initialBox(frame), frame)).toBe(100);
        expect(zoomPercent(fitToWindowBox(frame), frame)).toBeGreaterThan(100);
    });

    test('agrees with the opening view when the diagram is too big to fit', () => {
        const frame = frameOf({ x: 0, y: 0, w: 4000, h: 3000 });
        expect(fitToWindowBox(frame)).toEqual(initialBox(frame));
    });

    test('shows the whole diagram either way', () => {
        for (const content of [{ x: 0, y: 0, w: 100, h: 80 }, { x: 0, y: 0, w: 4000, h: 3000 }]) {
            const box = fitToWindowBox(frameOf(content));
            expect(box.x).toBeLessThanOrEqual(content.x);
            expect(box.y).toBeLessThanOrEqual(content.y);
            expect(box.x + box.w).toBeGreaterThanOrEqual(content.x + content.w);
            expect(box.y + box.h).toBeGreaterThanOrEqual(content.y + content.h);
        }
    });

    test('keeps the aspect invariant', () => {
        expect(aspect(fitToWindowBox(frameOf({ x: 0, y: 0, w: 100, h: 80 })))).toBeCloseTo(aspect(VIEWPORT), 9);
    });

    test('will not exceed the zoom ceiling the other controls respect', () => {
        // A tiny diagram would otherwise fit at a magnification the wheel refuses to reach.
        const frame = frameOf({ x: 0, y: 0, w: 8, h: 6 });
        expect(scaleOf(fitToWindowBox(frame), VIEWPORT)).toBeCloseTo(kMax(frame), 6);
        expect(zoomPercent(fitToWindowBox(frame), frame)).toBe(400);
    });

    test('stays centred on the diagram when the ceiling binds', () => {
        const content: Box = { x: 100, y: 200, w: 8, h: 6 };
        const box = fitToWindowBox(frameOf(content));
        expect(box.x + box.w / 2).toBeCloseTo(content.x + content.w / 2, 9);
        expect(box.y + box.h / 2).toBeCloseTo(content.y + content.h / 2, 9);
    });
});

describe('viewOnResize', () => {
    /**
     * A resize has to honour why the view looks the way it does. This lives here rather than in
     * the ResizeObserver callback precisely so it can be checked: observer delivery is tied to
     * the frame loop, which the browser harness cannot drive.
     */
    const small = frameOf({ x: 0, y: 0, w: 100, h: 80 });
    const taller: Size = { width: 800, height: 1000 };

    test('an untouched view is re-derived, not adjusted', () => {
        const grown = { ...small, viewport: taller };
        expect(viewOnResize('initial', initialBox(small), grown)).toEqual(initialBox(grown));
    });

    test('an untouched small diagram still reads 100% after a resize', () => {
        const grown = { ...small, viewport: taller };
        expect(zoomPercent(viewOnResize('initial', initialBox(small), grown), grown)).toBe(100);
    });

    test('a fitted view re-fits the new panel', () => {
        const grown = { ...small, viewport: taller };
        expect(viewOnResize('fitted', fitToWindowBox(small), grown)).toEqual(fitToWindowBox(grown));
    });

    test('a fitted view still shows the whole diagram after a resize', () => {
        const grown = { ...small, viewport: taller };
        const box = viewOnResize('fitted', fitToWindowBox(small), grown);
        expect(box.x).toBeLessThanOrEqual(small.content.x);
        expect(box.x + box.w).toBeGreaterThanOrEqual(small.content.x + small.content.w);
    });

    test('a view the user framed keeps how much of the diagram is showing', () => {
        const frame = frameOf({ x: 0, y: 0, w: 4000, h: 3000 });
        const chosen: Box = { x: 1000, y: 800, w: 400, h: 300 };
        const out = viewOnResize('custom', chosen, { ...frame, viewport: taller });
        expect(out.w * out.h).toBeCloseTo(chosen.w * chosen.h, 6);
        expect(out.x + out.w / 2).toBeCloseTo(chosen.x + chosen.w / 2, 6);
    });

    test('every origin comes back matching the new panel aspect', () => {
        const grown = { ...small, viewport: taller };
        for (const origin of ['initial', 'fitted', 'custom'] as const) {
            expect(aspect(viewOnResize(origin, initialBox(small), grown))).toBeCloseTo(aspect(taller), 9);
        }
    });
});

describe('boxAtScale', () => {
    test('produces exactly the scale asked for', () => {
        const frame = frameOf();
        for (const k of [0.5, 1, BASE, 3]) {
            expect(scaleOf(boxAtScale(frame, k), VIEWPORT)).toBeCloseTo(k, 9);
        }
    });

    test('naturalBox is the intrinsic-scale case', () => {
        expect(boxAtScale(frameOf(), BASE)).toEqual(naturalBox(frameOf()));
    });
});

describe('stepZoom and zoomPercent', () => {
    test('reads 100% at intrinsic size', () => {
        expect(zoomPercent(naturalBox(frameOf()), frameOf())).toBe(100);
    });

    test('reads below 100% when the diagram had to shrink to fit', () => {
        const frame = frameOf({ x: 0, y: 0, w: 4000, h: 3000 });
        expect(zoomPercent(fitBox(frame.content, VIEWPORT), frame)).toBeLessThan(100);
    });

    test('one step in from intrinsic size reads exactly 125%', () => {
        const frame = frameOf();
        expect(zoomPercent(stepZoom(naturalBox(frame), 'in', frame), frame)).toBe(125);
    });

    test('steps round-trip exactly while they stay inside the range', () => {
        // Four steps is 244% — comfortably under the 400% ceiling, which a round trip could
        // not survive: clamping is deliberately lossy.
        const start = naturalBox(frameOf());
        let vb = start;
        for (let i = 0; i < 4; i++) vb = stepZoom(vb, 'in', frameOf());
        for (let i = 0; i < 4; i++) vb = stepZoom(vb, 'out', frameOf());
        expect(vb.w).toBeCloseTo(start.w, 6);
        expect(vb.h).toBeCloseTo(start.h, 6);
    });

    test('is monotone in scale', () => {
        const fit = fitBox(CONTENT, VIEWPORT);
        const inOne = stepZoom(fit, 'in', frameOf());
        const inTwo = stepZoom(inOne, 'in', frameOf());
        const percents = [fit, inOne, inTwo].map(v => zoomPercent(v, frameOf()));
        expect(percents).toEqual([...percents].sort((a, b) => a - b));
    });
});

describe('wheelIntent', () => {
    /**
     * A mouse wheel and a trackpad both arrive as `wheel` events with nothing to tell them
     * apart, so this is a heuristic — and a wrong answer means a gesture does the opposite of
     * what the platform trained the user to expect. The samples below are what the two devices
     * actually emit.
     */
    const sample = (over: Partial<import('../src/webview/viewbox.js').WheelSample> = {}) => ({
        deltaMode: 0, deltaX: 0, deltaY: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...over
    });

    test.each([
        ['a standard wheel notch', { deltaY: 120 }],
        ['a notch scrolling the other way', { deltaY: -120 }],
        ['the smaller notch some mice send', { deltaY: 100 }],
        ['a notch at the classification threshold', { deltaY: 40 }],
        ['line-mode deltas', { deltaMode: 1, deltaY: 3 }],
        ['page-mode deltas', { deltaMode: 2, deltaY: 1 }]
    ])('zooms on %s', (_label, over) => {
        expect(wheelIntent(sample(over))).toBe('zoom');
    });

    test.each([
        ['a fine trackpad delta', { deltaY: 4 }],
        ['a fractional delta', { deltaY: 12.5 }],
        ['a delta with a horizontal component', { deltaY: 60, deltaX: 3 }],
        ['a purely horizontal swipe', { deltaX: 40, deltaY: 0 }],
        ['a momentum tail', { deltaY: 0.5 }]
    ])('pans on %s', (_label, over) => {
        expect(wheelIntent(sample(over))).toBe('pan');
    });

    test('ctrl and cmd always zoom — that is how a pinch arrives', () => {
        expect(wheelIntent(sample({ deltaY: 2, ctrlKey: true }))).toBe('zoom');
        expect(wheelIntent(sample({ deltaY: 2, metaKey: true }))).toBe('zoom');
    });

    test('shift always pans, even on a wheel', () => {
        expect(wheelIntent(sample({ deltaY: 120, shiftKey: true }))).toBe('pan');
    });

    test('ctrl wins over shift, so a pinch is never misread', () => {
        expect(wheelIntent(sample({ deltaY: 2, ctrlKey: true, shiftKey: true }))).toBe('zoom');
    });
});

describe('gestureIntent', () => {
    /**
     * A swipe is a stream whose shape drifts as it accelerates: early samples are small and
     * fractional, later ones can be large, whole and purely vertical — the exact shape of a
     * wheel notch. Classifying each sample on its own therefore lets one gesture pan briefly
     * and then start zooming, which these cases exist to prevent.
     */
    const sample = (over: Partial<import('../src/webview/viewbox.js').WheelSample> = {}) => ({
        deltaMode: 0, deltaX: 0, deltaY: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...over
    });

    /** Feed a stream of (event, time) pairs and collect what each one decided. */
    function run(stream: Array<[ReturnType<typeof sample>, number]>): WheelIntent[] {
        let state = NO_WHEEL_GESTURE;
        return stream.map(([event, now]) => {
            const result = gestureIntent(event, now, state);
            state = result.state;
            return result.intent;
        });
    }

    test('an accelerating trackpad swipe keeps panning once it starts', () => {
        const intents = run([
            [sample({ deltaY: 3.5, deltaX: 0.5 }), 0],
            [sample({ deltaY: 18 }), 16],
            [sample({ deltaY: 64 }), 32],      // now indistinguishable from a wheel notch
            [sample({ deltaY: 120 }), 48],
            [sample({ deltaY: 90 }), 64]
        ]);
        expect(intents).toEqual(['pan', 'pan', 'pan', 'pan', 'pan']);
    });

    test('a decelerating wheel stream keeps zooming as its deltas shrink', () => {
        const intents = run([
            [sample({ deltaY: 120 }), 0],
            [sample({ deltaY: 120 }), 40],
            [sample({ deltaY: 12 }), 80]
        ]);
        expect(intents).toEqual(['zoom', 'zoom', 'zoom']);
    });

    test('a new gesture after a pause is classified afresh', () => {
        const intents = run([
            [sample({ deltaY: 4, deltaX: 1 }), 0],
            [sample({ deltaY: 120 }), WHEEL_GESTURE_GAP_MS + 1]
        ]);
        expect(intents).toEqual(['pan', 'zoom']);
    });

    test('a gap exactly at the threshold still counts as the same gesture', () => {
        const intents = run([
            [sample({ deltaY: 4, deltaX: 1 }), 0],
            [sample({ deltaY: 120 }), WHEEL_GESTURE_GAP_MS]
        ]);
        expect(intents).toEqual(['pan', 'pan']);
    });

    test('the very first event is classified on its own merits', () => {
        expect(run([[sample({ deltaY: 120 }), 0]])).toEqual(['zoom']);
        expect(run([[sample({ deltaY: 4 }), 0]])).toEqual(['pan']);
    });

    test('a modifier takes effect immediately, mid-gesture', () => {
        const intents = run([
            [sample({ deltaY: 4 }), 0],
            [sample({ deltaY: 4, ctrlKey: true }), 16],
            [sample({ deltaY: 120, shiftKey: true }), 32]
        ]);
        expect(intents).toEqual(['pan', 'zoom', 'pan']);
    });

    test('a pinch keeps zooming through the momentum after ctrl is released', () => {
        const intents = run([
            [sample({ deltaY: -3, ctrlKey: true }), 0],
            [sample({ deltaY: -2 }), 16],
            [sample({ deltaY: -1 }), 32]
        ]);
        expect(intents).toEqual(['zoom', 'zoom', 'zoom']);
    });

    test('does not mutate the state handed to it', () => {
        const before = { ...NO_WHEEL_GESTURE };
        gestureIntent(sample({ deltaY: 120 }), 5, NO_WHEEL_GESTURE);
        expect(NO_WHEEL_GESTURE).toEqual(before);
    });
});

describe('wheelZoomFactor', () => {
    test('a notch is a modest step, not a leap', () => {
        const factor = wheelZoomFactor(-120);
        expect(1 / factor).toBeGreaterThan(1.1);
        expect(1 / factor).toBeLessThan(1.3);
    });

    test('is symmetric, so equal and opposite gestures cancel', () => {
        expect(wheelZoomFactor(120) * wheelZoomFactor(-120)).toBeCloseTo(1, 9);
    });

    test('sensitivity scales the step', () => {
        expect(wheelZoomFactor(-120, 2)).toBeLessThan(wheelZoomFactor(-120, 1));
        expect(wheelZoomFactor(-120, 0.5)).toBeGreaterThan(wheelZoomFactor(-120, 1));
        expect(wheelZoomFactor(-120, 1)).toBeCloseTo(wheelZoomFactor(-60, 2), 9);
    });

    test('a violent flick is capped, so one gesture cannot cross the whole range', () => {
        expect(wheelZoomFactor(-100000)).toBeCloseTo(1 / 1.5, 9);
        expect(wheelZoomFactor(100000)).toBeCloseTo(1.5, 9);
    });

    test('zero delta is the identity', () => {
        expect(wheelZoomFactor(0)).toBe(1);
    });
});

describe('wheelPixels', () => {
    test.each([
        ['pixel mode is already pixels', 0, 1],
        ['line mode is a line height', 1, 16],
        ['page mode is a viewport', 2, 800]
    ])('%s', (_label, mode, expected) => {
        expect(wheelPixels(mode as number, 800)).toBe(expected);
    });

    test('page mode converts against the axis it is given, not always the height', () => {
        // A page of horizontal scrolling is a viewport width; using the height would mis-scale
        // horizontal panning on any panel that is not square.
        expect(wheelPixels(2, 1200)).toBe(1200);
        expect(wheelPixels(2, 600)).toBe(600);
    });

    test('the other modes ignore the viewport entirely', () => {
        expect(wheelPixels(0, 1200)).toBe(wheelPixels(0, 600));
        expect(wheelPixels(1, 1200)).toBe(wheelPixels(1, 600));
    });
});

describe('panBy', () => {
    const content: Box = { x: 0, y: 0, w: 4000, h: 3000 };
    const vb: Box = { x: 1000, y: 800, w: 400, h: 300 };
    const rect = rectOf(VIEWPORT);

    test('dragging right moves the viewBox left, so the content follows the pointer', () => {
        expect(panBy(vb, 80, 0, rect, content).x).toBeLessThan(vb.x);
        expect(panBy(vb, -80, 0, rect, content).x).toBeGreaterThan(vb.x);
    });

    test('translates by the drag delta converted to user units', () => {
        const out = panBy(vb, 80, 60, rect, content);
        expect(out.x).toBeCloseTo(vb.x - 80 * vb.w / rect.width, 9);
        expect(out.y).toBeCloseTo(vb.y - 60 * vb.h / rect.height, 9);
    });

    test('does not change the zoom', () => {
        const out = panBy(vb, 80, 60, rect, content);
        expect(out.w).toBe(vb.w);
        expect(out.h).toBe(vb.h);
    });

    test('a huge drag clamps but leaves the diagram on screen', () => {
        const out = panBy(vb, -100000, -100000, rect, content);
        expect(out.x).toBeLessThan(content.x + content.w);
        expect(out.x + out.w).toBeGreaterThan(content.x);
        expect(out.y).toBeLessThan(content.y + content.h);
        expect(out.y + out.h).toBeGreaterThan(content.y);
    });
});

describe('clampTranslation', () => {
    const content: Box = { x: 0, y: 0, w: 4000, h: 3000 };

    test('leaves a view well inside the content alone', () => {
        const vb: Box = { x: 1000, y: 800, w: 400, h: 300 };
        expect(clampTranslation(vb, content)).toEqual(vb);
    });

    test('keeps at least a quarter of the view overlapping the content', () => {
        const vb: Box = { x: 99999, y: 99999, w: 400, h: 300 };
        const out = clampTranslation(vb, content);
        const overlapX = Math.min(out.x + out.w, content.x + content.w) - Math.max(out.x, content.x);
        expect(overlapX).toBeCloseTo(Math.min(out.w, content.w) * 0.25, 6);
    });

    test('is permissive enough to centre an element on the very edge of the diagram', () => {
        const vb: Box = { x: 0, y: 0, w: 400, h: 300 };
        const corner: Box = { x: content.x, y: content.y, w: 20, h: 15 };
        const out = centerOn(vb, corner, content);
        expect(out.x).toBeCloseTo(corner.x + corner.w / 2 - vb.w / 2, 6);
    });
});

describe('isPannable', () => {
    test('is false at fit and true once zoomed in', () => {
        const fit = fitBox(CONTENT, VIEWPORT);
        expect(isPannable(fit, CONTENT)).toBe(false);
        expect(isPannable(stepZoom(fit, 'in', frameOf()), CONTENT)).toBe(true);
    });
});

describe('needsPan', () => {
    const vb: Box = { x: 0, y: 0, w: 1000, h: 1000 };

    test.each([
        ['comfortably inside', { x: 400, y: 400, w: 50, h: 50 }, false],
        ['inside but within the edge band', { x: 40, y: 400, w: 20, h: 20 }, true],
        ['straddling the left edge', { x: -10, y: 400, w: 50, h: 50 }, true],
        ['fully off to the right', { x: 2000, y: 400, w: 50, h: 50 }, true],
        ['fully above', { x: 400, y: -500, w: 50, h: 50 }, true],
        ['larger than the view', { x: -100, y: -100, w: 5000, h: 5000 }, true]
    ])('%s', (_label, target, expected) => {
        expect(needsPan(target as Box, vb)).toBe(expected);
    });
});

describe('centerOn', () => {
    const content: Box = { x: 0, y: 0, w: 4000, h: 3000 };

    test('puts the target centre at the view centre', () => {
        const vb: Box = { x: 1000, y: 800, w: 400, h: 300 };
        const target: Box = { x: 2000, y: 1500, w: 100, h: 80 };
        const out = centerOn(vb, target, content);
        expect(out.x + out.w / 2).toBeCloseTo(target.x + target.w / 2, 9);
        expect(out.y + out.h / 2).toBeCloseTo(target.y + target.h / 2, 9);
    });

    test('does not change the zoom', () => {
        const vb: Box = { x: 1000, y: 800, w: 400, h: 300 };
        const out = centerOn(vb, { x: 2000, y: 1500, w: 100, h: 80 }, content);
        expect(out.w).toBe(vb.w);
        expect(out.h).toBe(vb.h);
    });

    test('a target near a corner still ends up fully visible after clamping', () => {
        const vb: Box = { x: 1000, y: 800, w: 400, h: 300 };
        const corner: Box = { x: 3960, y: 2970, w: 30, h: 20 };
        const out = centerOn(vb, corner, content);
        expect(out.x).toBeLessThanOrEqual(corner.x);
        expect(out.x + out.w).toBeGreaterThanOrEqual(corner.x + corner.w);
        expect(out.y).toBeLessThanOrEqual(corner.y);
        expect(out.y + out.h).toBeGreaterThanOrEqual(corner.y + corner.h);
    });
});

describe('minimap', () => {
    const content: Box = { x: 0, y: 0, w: 4000, h: 3000 };
    const mm: Size = { width: 200, height: 150 };

    test('the whole content maps to the whole minimap', () => {
        expect(minimapRect(content, content, mm)).toEqual({ left: 0, top: 0, width: 200, height: 150 });
    });

    test('a view in the middle maps to the middle', () => {
        const vb: Box = { x: 1800, y: 1350, w: 400, h: 300 };
        const r = minimapRect(vb, content, mm);
        expect(r.left + r.width / 2).toBeCloseTo(100, 9);
        expect(r.top + r.height / 2).toBeCloseTo(75, 9);
    });

    test('honours a non-zero content origin', () => {
        const shifted: Box = { x: -1000, y: -500, w: 4000, h: 3000 };
        expect(minimapRect(shifted, shifted, mm).left).toBeCloseTo(0, 9);
    });

    test('round-trips through minimapToViewBox', () => {
        const vb: Box = { x: 1800, y: 1350, w: 400, h: 300 };
        const r = minimapRect(vb, content, mm);
        const back = minimapToViewBox(vb, r.left, r.top, content, mm);
        expect(back.x).toBeCloseTo(vb.x, 6);
        expect(back.y).toBeCloseTo(vb.y, 6);
    });

    test('dragging the box past the edge clamps instead of losing the diagram', () => {
        const vb: Box = { x: 1800, y: 1350, w: 400, h: 300 };
        const out = minimapToViewBox(vb, 5000, 5000, content, mm);
        expect(out.x).toBeLessThan(content.x + content.w);
        expect(out.x + out.w).toBeGreaterThan(content.x);
    });

    test.each([
        ['hidden at fit', { x: 0, y: 0, w: 4000, h: 3000 }, false],
        ['hidden just below the threshold', { x: 0, y: 0, w: 3960, h: 2970 }, false],
        ['shown just above it', { x: 0, y: 0, w: 3560, h: 2670 }, true],
        ['shown when zoomed in', { x: 1800, y: 1350, w: 400, h: 300 }, true],
        ['shown when only one axis is cropped', { x: 0, y: 0, w: 4000, h: 1000 }, true]
    ])('%s', (_label, vb, expected) => {
        expect(shouldShowMinimap(vb as Box, content)).toBe(expected);
    });
});

function boxCenterOf(b: Box) {
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}
