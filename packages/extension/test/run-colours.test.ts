/**
 * @vitest-environment happy-dom
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { LiveStatus, ObservedSource } from '../src/shared/run-protocol.js';
import { colourRun, markProgress } from '../src/webview/run-colours.js';

/**
 * Colouring a run's drawing as it goes, held to what jpipe-runner draws (jpipe-vscode
 * ADR-VSC-0033, jpipe-runner ADR-0032).
 *
 * The fixtures are the runner's own drawings of its release example, with the strategy's label
 * long enough to wrap: its dry run, which is the drawing it makes before an execution's first
 * step, and four executions of it, each with the statuses its report gave: one where an evidence
 * fails and another skips on its own account, one where the strategy fails, one where everything
 * passes, and one where a file an evidence observes is missing. Colouring the dry run with an
 * execution's statuses must give that execution's drawing.
 *
 * Within what can be told apart: positions are compared to a tenth of a point, the precision a
 * label's position is printed at, and an edge by its colour alone. A support edge ends at the
 * border of the node it reaches, and a 2-point border moves that end by less than a point; the
 * runner's own drawing replaces the coloured one when the run ends.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(join(here, 'fixtures', 'runner', name), 'utf8');
const DRY = fixture('release-dry.svg');

/** The sources an execution observed, as its events would say, from its report. */
const observedOf = (run: string): ObservedSource[] =>
    (JSON.parse(fixture(`release-${run}.statuses.json`)) as { observed: ObservedSource[] }).observed;

/** An execution's statuses, as its report gave them. */
function statusesOf(run: string): LiveStatus[] {
    const elements = (JSON.parse(fixture(`release-${run}.statuses.json`)) as { statuses: {
        id: string; status: LiveStatus['status']; reason: string | null; blocked_by: string[]; produced: string[]; unreachable: string[];
    }[] }).statuses;
    return elements.map(e => ({
        id: e.id, status: e.status, reason: e.reason, rootCause: e.status === 'skip' && e.blocked_by.length === 0,
        produced: e.produced, unreachable: e.unreachable
    }));
}

const parse = (svg: string): Document => new DOMParser().parseFromString(svg, 'image/svg+xml');

/** What a node or edge draws, as attributes that matter, in order: geometry, paint, symbols, tooltip. */
function drawnBy(group: Element): string[] {
    const numeric = (value: string | null): string | null => value === null ? null : Number.parseFloat(value).toFixed(1);
    const edge = group.getAttribute('class')?.split(' ').includes('edge') ?? false;
    return Array.from(group.querySelectorAll('polygon, polyline, path, ellipse, text, a')).map(el => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return `a title=${el.getAttribute('xlink:title')}`;
        const paint = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'font-size', 'font-family']
            .map(name => `${name}=${el.getAttribute(name)}`);
        const where = tag === 'text'
            ? [`x=${numeric(el.getAttribute('x'))}`, `y=${numeric(el.getAttribute('y'))}`, `"${el.textContent}"`]
            : [`at=${edge ? '(its ends)' : el.getAttribute('points') ?? el.getAttribute('d') ?? ''}`];
        return [tag, ...where, ...paint].join(' ');
    });
}

/** Every node and edge of a drawing, by name. */
function drawing(svg: string): Map<string, string[]> {
    const doc = parse(svg);
    return new Map(Array.from(doc.querySelectorAll('g[class~="node"], g[class~="edge"]')).map(g => {
        const title = Array.from(g.children).find(c => c.tagName.toLowerCase() === 'title')?.textContent ?? '';
        return [title, drawnBy(g)];
    }));
}

describe('a run\'s drawing, coloured as its elements are decided', () => {

    test.each(['mixed', 'strategy', 'pass', 'missing'])('the %s run comes out as the runner drew it', run => {
        const coloured = drawing(colourRun(DRY, statusesOf(run), observedOf(run)));
        const drawn = drawing(fixture(`release-${run}.svg`));
        expect([...coloured.keys()].sort()).toEqual([...drawn.keys()].sort());
        for (const [name, shapes] of drawn) expect(coloured.get(name), name).toEqual(shapes);
    });

    test('the case the fixtures are for: a failure, a skip on its own account, and skips it caused', () => {
        expect(statusesOf('mixed').map(s => [s.id, s.status, s.rootCause])).toEqual([
            ['release:e1', 'fail', false], ['release:e2', 'skip', true], ['release:s', 'skip', false], ['release:c', 'skip', false]
        ]);
    });

    test('an element not decided yet is drawn as before the run', () => {
        const coloured = drawing(colourRun(DRY, statusesOf('mixed').slice(0, 1)));
        const dry = drawing(DRY);
        expect(coloured.get('release:e1')).not.toEqual(dry.get('release:e1'));
        for (const name of ['release:e2', 'release:s', 'release:c', 'release:s->release:c']) expect(coloured.get(name)).toEqual(dry.get(name));
    });

    test('a source is marked ✔ as soon as it is observed, before its element is decided', () => {
        const dry = drawing(DRY);
        const junit = 'artifact mock/junit.xml';
        const observing = drawing(colourRun(DRY, [], [{ source: 'mock/junit.xml', reachable: true }]));
        expect(observing.get(junit)).toEqual(drawing(fixture('release-pass.svg')).get(junit));
        expect(observing.get('release:e1')).toEqual(dry.get('release:e1'));
        expect(observing.get('artifact mock/CHANGELOG.md')).toEqual(dry.get('artifact mock/CHANGELOG.md'));
    });

    test('a source that could not be reached is marked ⚠, in vermillion, as soon as it is observed', () => {
        const changelog = 'artifact mock/CHANGELOG.md';
        const missing = drawing(colourRun(DRY, [], [{ source: 'mock/CHANGELOG.md', reachable: false }]));
        expect(missing.get(changelog)).toEqual(drawing(fixture('release-missing.svg')).get(changelog));
    });

    test('an edge to a file or a variable keeps its colour', () => {
        const coloured = drawing(colourRun(DRY, statusesOf('strategy')));
        const dry = drawing(DRY);
        expect(coloured.get('release:e1->variable tests_pass')).toEqual(dry.get('release:e1->variable tests_pass'));
        expect(coloured.get('artifact mock/junit.xml->release:e1')).toEqual(dry.get('artifact mock/junit.xml->release:e1'));
    });

    test('the node keeps its name first, which is what a click reads', () => {
        const node = parse(colourRun(DRY, statusesOf('pass'))).getElementById('release:e1')!;
        expect(node.children[0].tagName.toLowerCase()).toBe('title');
        expect(node.children[0].textContent).toBe('release:e1');
    });

    test('with nothing decided, or text that is no drawing, nothing changes', () => {
        expect(colourRun(DRY, [])).toBe(DRY);
        expect(colourRun('not a drawing', statusesOf('pass'))).toBe('not a drawing');
    });

    test('a variable is dashed once its producer is decided without it, and not before', () => {
        const [e1] = statusesOf('mixed');
        const dry = drawing(DRY);
        expect(drawing(colourRun(DRY, statusesOf('mixed').slice(1, 2))).get('variable tests_pass')).toEqual(dry.get('variable tests_pass'));
        expect(drawing(colourRun(DRY, [e1])).get('variable tests_pass')).not.toEqual(dry.get('variable tests_pass'));
    });

    test('an id the drawing does not have is ignored', () => {
        const stray: LiveStatus = { id: 'release:gone', status: 'fail', reason: null, rootCause: false, produced: [], unreachable: [] };
        expect(drawing(colourRun(DRY, [stray]))).toEqual(drawing(DRY));
    });
});

describe('the steps under way', () => {

    const show = (svg: string): SVGSVGElement => {
        document.body.innerHTML = svg.slice(svg.indexOf('<svg'));
        return document.querySelector('svg')!;
    };
    const marks = (svg: SVGSVGElement) => Array.from(svg.querySelectorAll('g.jpipe-underway, g.jpipe-pending'))
        .map(mark => [mark.closest('g.node')!.id, mark.getAttribute('class')]).sort();

    test('running and waiting are each marked with a shape, not a colour; decided, with neither', () => {
        const svg = show(DRY);
        markProgress(svg, { underway: ['release:e1'], pending: ['release:e2', 'release:s', 'release:c'] });
        expect(marks(svg)).toEqual([
            ['release:c', 'jpipe-pending'], ['release:e1', 'jpipe-underway'], ['release:e2', 'jpipe-pending'], ['release:s', 'jpipe-pending']
        ]);
        // release:e1 decided, release:e2 started.
        markProgress(svg, { underway: ['release:e2'], pending: ['release:s', 'release:c'] });
        expect(marks(svg)).toEqual([['release:c', 'jpipe-pending'], ['release:e2', 'jpipe-underway'], ['release:s', 'jpipe-pending']]);
        markProgress(svg, { underway: ['release:e2'], pending: ['release:s', 'release:c'] });
        expect(marks(svg)).toHaveLength(3);
        markProgress(svg, { underway: [], pending: [] });
        expect(marks(svg)).toEqual([]);
    });

    test('running is the Results view\'s spinner, a circle with a gap; waiting, its clock', () => {
        const svg = show(DRY);
        markProgress(svg, { underway: ['release:e1'], pending: ['release:e2'] });
        const running = svg.querySelector('g.jpipe-underway')!;
        expect(Array.from(running.children).map(c => c.tagName.toLowerCase())).toEqual(['circle']);
        expect(running.children[0].getAttribute('stroke-dasharray')).toMatch(/^\S+ \S+$/);
        const waiting = svg.querySelector('g.jpipe-pending')!;
        expect(Array.from(waiting.children).map(c => c.tagName.toLowerCase())).toEqual(['circle', 'path']);
    });

    test('a mark sits in the cell the status\'s symbol will take, in the label\'s colour', () => {
        const svg = show(DRY);
        svg.querySelector('g[id="release:s"] text')!.setAttribute('fill', 'currentColor');
        markProgress(svg, { underway: ['release:s'], pending: ['release:e1'] });
        // The runner's symbol, once decided: where it starts, at 20 points, beside the label.
        const decided = parse(fixture('release-mixed.svg')).getElementById('release:s')!.querySelectorAll('text');
        const [symbol, label] = [decided[0], decided[1]].map(t => Number.parseFloat(t.getAttribute('x')!));
        const circle = svg.querySelector('g.jpipe-underway circle')!;
        const [cx, r] = ['cx', 'r'].map(a => Number.parseFloat(circle.getAttribute(a)!));
        expect(cx - r).toBeGreaterThanOrEqual(symbol - 2);
        expect(cx + r).toBeLessThanOrEqual(label - 2);
        expect(circle.getAttribute('stroke')).toBe('currentColor');
        // A label with no colour of its own is black, SVG's default.
        expect(svg.querySelector('g.jpipe-pending circle')!.getAttribute('stroke')).toBe('black');
    });
});
