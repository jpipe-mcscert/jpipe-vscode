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
 *
 * A second fixture is the same diagram with the one attribute Graphviz 5.0.1 changed, standing
 * for every older release. Nothing here may assume which of the two drew a file: that assumption
 * is the bug the pair exists to keep out.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test } from 'vitest';
import { adaptToDarkTheme } from '../src/webview/highlight.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Put a fixture in the page and hand back its root, past a prolog the HTML parser has no use for.
 *
 * Both steps are asserted, because neither fails loudly on its own: a missing `<svg` makes
 * `indexOf` return -1, which `slice` reads as "from the last character", and a root the parser
 * then declines to build is cast to a type it does not have. What reaches the first test is a
 * null dereference several frames away from the fixture that caused it.
 */
function install(fixture: string): SVGSVGElement {
    const text = readFileSync(join(here, 'fixtures', 'svg', fixture), 'utf8');
    const start = text.indexOf('<svg');
    expect(start, `${fixture} should contain an <svg> element`).toBeGreaterThanOrEqual(0);
    document.body.innerHTML = text.slice(start);
    const svg = document.querySelector('svg');
    expect(svg, `${fixture} should parse to an <svg> root`).not.toBeNull();
    return svg as unknown as SVGSVGElement;
}

let svg: SVGSVGElement;

beforeEach(() => {
    svg = install('template-with-cluster.svg');
});

/** The node `dot` drew for an element, found by the id the exporter gave it. */
function node(id: string): Element {
    const found = Array.from(svg.querySelectorAll('g.node')).find(g => g.getAttribute('id') === id);
    expect(found, `fixture has no node '${id}'`).toBeDefined();
    return found!;
}

const backdrop = () => svg.querySelector('g.cluster polygon') as Element;

/**
 * The white sheet `dot` paints across the page.
 *
 * Found by where it sits rather than by what it says: it is the only polygon drawn directly
 * under `g.graph`, everything else being nested in a cluster, a node or an edge. Naming it by
 * its attributes is what the code used to do, and is the mistake this file has to be able to
 * catch — a check written the same way would agree with a broken implementation that the canvas
 * it failed to find was not there.
 */
const canvas = () => svg.querySelector('g.graph > polygon');

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

    /**
     * An `@support` is a dotted rectangle and a label, and nothing else — no fill, no colour of
     * its own. Its outline was left in the compiler's default black, which on a dark ground meant
     * black on black: the label floated with no box around it at all.
     */
    test('an unfilled outline takes the foreground colour', () => {
        // Selected by the dashes rather than by id: an override and the `@support` it refines
        // share one id, so the dotted outline is what identifies an `@support` here — which is
        // also what it is for a reader.
        const dotted = Array.from(svg.querySelectorAll('g.node [stroke-dasharray]'));
        expect(dotted.length, 'fixture should contain @support elements').toBeGreaterThanOrEqual(2);
        for (const shape of dotted) {
            expect(shape.getAttribute('stroke')).toBe('currentColor');
        }
    });

    // A filled node's outline traces the edge of something light and reads against it.
    test('a filled node keeps its black outline', () => {
        expect(node('refined:base:s').querySelector('polygon')!.getAttribute('stroke')).toBe('black');
    });

    // Blue is a colour the compiler chose, not a default it fell back to, and it reads on either
    // ground — so it is not ours to redirect.
    test('a sub-conclusion keeps the colour the compiler gave it', () => {
        expect(node('refined:base:sc').querySelector('polygon')!.getAttribute('stroke')).toBe('#0072b2');
    });

    test('the white canvas is still removed', () => {
        expect(canvas()).toBeNull();
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

/**
 * The same diagram as drawn by a Graphviz older than 5.0.1.
 *
 * That release stopped writing `transparent` into SVG — a keyword SVG 1.1 does not define — and
 * started writing `none`. The canvas is the one shape in the picture the change reaches, and
 * matching the newer spelling alone meant the sheet stayed put: the diagram sat on white in a
 * dark theme, on every machine whose `dot` predated August 2022.
 *
 * Which is not an exotic machine. Debian stable and every Ubuntu LTS before 26.04 still package
 * 2.42, so `apt install graphviz` is the affected case rather than the unlucky one — and the
 * version is the host compiler's, not ours, so no amount of updating the extension moved it.
 */
describe('a diagram from a Graphviz older than 5.0.1', () => {

    beforeEach(() => {
        svg = install('template-with-cluster-legacy.svg');
    });

    test('spells the canvas the old way, which is the point of the fixture', () => {
        expect(canvas()?.getAttribute('stroke')).toBe('transparent');
        expect(canvas()?.getAttribute('fill')).toBe('white');
    });

    describe('once adapted', () => {

        beforeEach(() => adaptToDarkTheme(svg));

        test('loses its canvas too', () => {
            expect(canvas()).toBeNull();
        });

        // The canvas is identified by position, so what stops that from taking the next polygon
        // with it is the stroke guard. These two are the shapes it protects: both are drawn
        // deeper in the tree, and both carry a stroke that means something.
        test('and keeps the shapes that carry an outline', () => {
            expect(backdrop().getAttribute('stroke')).toBe('grey');
            expect(node('refined:base:s').querySelector('polygon')!.getAttribute('stroke')).toBe('black');
        });

        test('and is otherwise adapted as any other diagram is', () => {
            expect(node('refined:base:sc').querySelector('text')!.getAttribute('fill')).toBe('currentColor');
            expect(svg.querySelectorAll('g.edge [stroke="black"], g.edge [fill="black"]')).toHaveLength(0);
        });
    });
});
