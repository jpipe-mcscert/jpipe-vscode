/**
 * @vitest-environment happy-dom
 */

/**
 * Adapting the compiler's SVG to a dark theme.
 *
 * The fixture is real `dot` output, not a hand-written stand-in: the whole job here is reacting to
 * colours and structure this code does not choose, so a fixture written to match the
 * implementation would agree with it about a diagram the compiler never produces.
 *
 * It is a template implementing another, which is what puts a Graphviz *cluster* in the picture —
 * the pale panel `dot` paints behind an inherited region, on the assumption of a white page.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test } from 'vitest';
import { adaptToDarkTheme } from '../src/webview/highlight.js';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'fixtures', 'svg', 'template-with-cluster.svg'), 'utf8');

let svg: SVGSVGElement;

beforeEach(() => {
    document.body.innerHTML = source.slice(source.indexOf('<svg'));
    svg = document.querySelector('svg') as unknown as SVGSVGElement;
});

/** The node `dot` drew for an element, found by the id the exporter gave it. */
function node(id: string): Element {
    const found = Array.from(svg.querySelectorAll('g.node')).find(g => g.getAttribute('id') === id);
    expect(found, `fixture has no node '${id}'`).toBeDefined();
    return found!;
}

const backdrop = () => svg.querySelector('g.cluster polygon') as Element;

describe('the fixture is the shape this code exists for', () => {

    test('it has an inherited region drawn as a pale panel', () => {
        expect(backdrop().getAttribute('fill')).toBe('lightyellow');
        expect(backdrop().getAttribute('fill-opacity')).toBeNull();
    });

    // An unfilled box is the whole visual identity of a sub-conclusion, and it is the case that
    // makes the panel a problem: nothing of its own sits between its label and the panel.
    test('and a sub-conclusion inside it with no fill of its own', () => {
        const shape = node('refined:base:sc').querySelector('polygon, path')!;
        expect(shape.getAttribute('fill')).toBe('none');
    });
});

describe('adapting to a dark theme', () => {

    beforeEach(() => adaptToDarkTheme(svg));

    // The reported bug. Every light thing drawn over this panel — the label of any unfilled node,
    // and the edges and arrowheads already re-pointed at the editor foreground — was light on
    // pale yellow.
    test('the pale panel becomes a wash the theme shows through', () => {
        const opacity = backdrop().getAttribute('fill-opacity');
        // Asserted present before it is compared: absent reads as `Number(null) === 0`, which
        // would satisfy the bound below while the panel stayed fully opaque.
        expect(opacity, 'the backdrop should carry an explicit opacity').not.toBeNull();
        expect(Number(opacity)).toBeGreaterThan(0);
        expect(Number(opacity)).toBeLessThanOrEqual(0.15);
    });

    // Made translucent rather than repainted, so the tint stays the compiler's own colour rather
    // than one invented here — and the region still reads as a region.
    test('it keeps its colour and its edge', () => {
        expect(backdrop().getAttribute('fill')).toBe('lightyellow');
        expect(backdrop().getAttribute('stroke')).toBe('grey');
    });

    test('a sub-conclusion inside it takes the foreground colour, as it did before', () => {
        const text = node('refined:base:sc').querySelector('text')!;
        expect(text.getAttribute('fill')).toBe('currentColor');
    });

    // The rule is by backdrop, not by element type: a filled node still paints something light
    // for its own label to sit on, panel or no panel.
    test('a filled node inside it keeps its black label', () => {
        const text = node('refined:base:s').querySelector('text')!;
        expect(text.getAttribute('fill')).toBeNull();
    });

    test('the white canvas is still removed', () => {
        const canvas = Array.from(svg.querySelectorAll('polygon'))
            .filter(p => p.getAttribute('fill') === 'white' && p.getAttribute('stroke') === 'none');
        expect(canvas).toEqual([]);
    });

    // A cluster's own caption sits directly on the panel, so it was unreadable for the same
    // reason and is readable again for the same one.
    test('the region keeps its caption', () => {
        expect(svg.querySelector('g.cluster text')?.textContent).toContain('base');
    });

    test('edges are re-pointed at the foreground', () => {
        const black = svg.querySelectorAll('g.edge [stroke="black"], g.edge [fill="black"]');
        expect(black).toHaveLength(0);
    });
});
