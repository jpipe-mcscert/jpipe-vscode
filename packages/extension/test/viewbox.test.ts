import { describe, expect, test } from 'vitest';
import {
    type Box,
    type Rect,
    type Size,
    centerOn,
    clampTranslation,
    clientToUser,
    fitBox,
    isPannable,
    kMax,
    kMin,
    minimapRect,
    minimapToViewBox,
    needsPan,
    normalizeAspect,
    panBy,
    parseViewBox,
    scaleOf,
    shouldShowMinimap,
    stepZoom,
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
            vb = zoomAt(vb, anchor, factor, VIEWPORT, CONTENT);
            const after = clientToUser(client.x, client.y, rect, vb);
            expect(after.x).toBeCloseTo(anchor.x, 6);
            expect(after.y).toBeCloseTo(anchor.y, 6);
        }
    });

    test('a factor of 1 is the identity', () => {
        const vb = fitBox(CONTENT, VIEWPORT);
        const out = zoomAt(vb, { x: 100, y: 100 }, 1, VIEWPORT, CONTENT);
        expect(out.w).toBeCloseTo(vb.w, 9);
        expect(out.h).toBeCloseTo(vb.h, 9);
    });

    test('scales the viewBox by exactly the factor when the clamp does not bind', () => {
        const vb = fitBox(CONTENT, VIEWPORT);
        const out = zoomAt(vb, boxCenterOf(vb), 1 / 1.25, VIEWPORT, CONTENT);
        expect(out.w).toBeCloseTo(vb.w / 1.25, 9);
        expect(out.h).toBeCloseTo(vb.h / 1.25, 9);
    });

    test('preserves the aspect invariant', () => {
        const vb = zoomAt(fitBox(CONTENT, VIEWPORT), { x: 100, y: 100 }, 1 / 2.5, VIEWPORT, CONTENT);
        expect(aspect(vb)).toBeCloseTo(aspect(VIEWPORT), 9);
    });

    test('zooming in past the ceiling lands exactly on it, never past', () => {
        let vb = fitBox(CONTENT, VIEWPORT);
        for (let i = 0; i < 60; i++) vb = zoomAt(vb, boxCenterOf(vb), 1 / 1.25, VIEWPORT, CONTENT);
        expect(scaleOf(vb, VIEWPORT)).toBeCloseTo(kMax(CONTENT, VIEWPORT), 6);
    });

    test('zooming out past the floor lands exactly on it, never past', () => {
        let vb = fitBox(CONTENT, VIEWPORT);
        for (let i = 0; i < 60; i++) vb = zoomAt(vb, boxCenterOf(vb), 1.25, VIEWPORT, CONTENT);
        expect(scaleOf(vb, VIEWPORT)).toBeCloseTo(kMin(CONTENT, VIEWPORT), 6);
    });

    test('the anchor still holds when the clamp binds', () => {
        const client = { x: 700, y: 500 };
        let vb = fitBox(CONTENT, VIEWPORT);
        for (let i = 0; i < 40; i++) vb = zoomAt(vb, clientToUser(client.x, client.y, rect, vb), 1 / 1.25, VIEWPORT, CONTENT);
        // At the ceiling a further zoom must be a complete no-op, not a drift.
        const anchor = clientToUser(client.x, client.y, rect, vb);
        const after = zoomAt(vb, anchor, 1 / 1.25, VIEWPORT, CONTENT);
        expect(clientToUser(client.x, client.y, rect, after).x).toBeCloseTo(anchor.x, 6);
    });

    test('a large model can be magnified far enough to read, unlike the old fixed 3x ceiling', () => {
        const huge: Box = { x: 0, y: 0, w: 40000, h: 30000 };
        const fitScale = scaleOf(fitBox(huge, VIEWPORT), VIEWPORT);
        expect(kMax(huge, VIEWPORT) / fitScale).toBeGreaterThan(100);
    });

    test('a small model still gets a meaningful 400% ceiling', () => {
        const small: Box = { x: 0, y: 0, w: 40, h: 30 };
        const fitScale = scaleOf(fitBox(small, VIEWPORT), VIEWPORT);
        expect(kMax(small, VIEWPORT) / fitScale).toBeCloseTo(4, 6);
    });
});

describe('stepZoom and zoomPercent', () => {
    test('reads 100% at fit', () => {
        expect(zoomPercent(fitBox(CONTENT, VIEWPORT), VIEWPORT, CONTENT)).toBe(100);
    });

    test('one step in reads exactly 125%, preserving the old first step', () => {
        const vb = stepZoom(fitBox(CONTENT, VIEWPORT), 'in', VIEWPORT, CONTENT);
        expect(zoomPercent(vb, VIEWPORT, CONTENT)).toBe(125);
    });

    test('steps round-trip exactly', () => {
        const start = fitBox(CONTENT, VIEWPORT);
        let vb = start;
        for (let i = 0; i < 6; i++) vb = stepZoom(vb, 'in', VIEWPORT, CONTENT);
        for (let i = 0; i < 6; i++) vb = stepZoom(vb, 'out', VIEWPORT, CONTENT);
        expect(vb.w).toBeCloseTo(start.w, 6);
        expect(vb.h).toBeCloseTo(start.h, 6);
    });

    test('is monotone in scale', () => {
        const fit = fitBox(CONTENT, VIEWPORT);
        const inOne = stepZoom(fit, 'in', VIEWPORT, CONTENT);
        const inTwo = stepZoom(inOne, 'in', VIEWPORT, CONTENT);
        const percents = [fit, inOne, inTwo].map(v => zoomPercent(v, VIEWPORT, CONTENT));
        expect(percents).toEqual([...percents].sort((a, b) => a - b));
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
        expect(isPannable(stepZoom(fit, 'in', VIEWPORT, CONTENT), CONTENT)).toBe(true);
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
