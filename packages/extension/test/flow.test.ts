/**
 * @vitest-environment happy-dom
 */

import { describe, expect, test } from 'vitest';
import { installSvg } from '../src/webview/canvas.js';
import { applyFocus, downstream, nameOf, nodeNamed } from '../src/webview/flow.js';

/**
 * What follows a node in the run panel's dataflow, read from the SVG as Graphviz writes it: node
 * names in `<title>`, edges as `tail->head` with `-` and `>` escaped as entities.
 *
 *     artifact log ──▶ e1 ──▶ s ──▶ c          e1 ──▶ variable n ──▶ s2 ──▶ c
 *                     e2 ──▶ s
 */
const node = (name: string) => `<g id="${name.startsWith('release:') ? name : 'node' + name.length}" class="node"><title>${name}</title><polygon points="0,0"/></g>`;
const edge = (tail: string, head: string) => `<g class="edge"><title>${tail}&#45;&gt;${head}</title><path d="M0,0"/></g>`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g class="graph"><title>release (dataflow)</title>
${['release:c', 'release:s', 'release:s2', 'release:e1', 'release:e2', 'artifact build/tests.log', 'variable n'].map(node).join('')}
${edge('artifact build/tests.log', 'release:e1')}
${edge('release:e1', 'release:s')}
${edge('release:e2', 'release:s')}
${edge('release:s', 'release:c')}
${edge('release:e1', 'variable n')}
${edge('variable n', 'release:s2')}
${edge('release:s2', 'release:c')}
</g></svg>`;

const svg = () => installSvg(document.createElement('div'), SVG)!;
const names = (groups: Iterable<Element>) => Array.from(groups).map(nameOf).sort();

describe('what follows a node', () => {

    test('is every node its arrows lead to, and the edges between them', () => {
        const drawing = svg();
        const reached = downstream(drawing, nodeNamed(drawing, 'artifact build/tests.log')!);
        expect(names(reached)).toEqual([
            'artifact build/tests.log', 'artifact build/tests.log->release:e1',
            'release:c', 'release:e1', 'release:e1->release:s', 'release:e1->variable n',
            'release:s', 'release:s->release:c', 'release:s2', 'release:s2->release:c',
            'variable n', 'variable n->release:s2'
        ]);
    });

    test('is never what comes before it, nor a sibling', () => {
        const drawing = svg();
        const reached = names(downstream(drawing, nodeNamed(drawing, 'release:e2')!));
        expect(reached).toEqual(['release:c', 'release:e2', 'release:e2->release:s', 'release:s', 'release:s->release:c']);
    });

    test('is the node alone, for the conclusion', () => {
        const drawing = svg();
        expect(names(downstream(drawing, nodeNamed(drawing, 'release:c')!))).toEqual(['release:c']);
    });

    test('walks a cycle once', () => {
        const drawing = installSvg(document.createElement('div'),
            `<svg xmlns="http://www.w3.org/2000/svg">${node('release:a')}${node('release:b')}${edge('release:a', 'release:b')}${edge('release:b', 'release:a')}<g class="edge"><title>no arrow</title></g></svg>`)!;
        expect(names(downstream(drawing, nodeNamed(drawing, 'release:a')!))).toEqual([
            'release:a', 'release:a->release:b', 'release:b', 'release:b->release:a'
        ]);
    });

    test('a name the drawing does not have is no node', () => {
        expect(nodeNamed(svg(), 'release:missing')).toBeNull();
        expect(nameOf(document.createElement('g'))).toBe('');
    });
});

describe('lighting it', () => {

    test('dims the rest and outlines where it starts; no focus dims nothing', () => {
        const drawing = svg();
        const start = nodeNamed(drawing, 'release:e2')!;
        applyFocus(drawing, downstream(drawing, start), start);
        const dimmed = () => names(drawing.querySelectorAll('.jpipe-dimmed'));
        expect(dimmed()).not.toContain('release:c');
        expect(dimmed()).toContain('release:e1');
        expect(names(drawing.querySelectorAll('.jpipe-origin'))).toEqual(['release:e2']);

        applyFocus(drawing, null, null);
        expect(dimmed()).toEqual([]);
        expect(drawing.querySelectorAll('.jpipe-origin')).toHaveLength(0);
    });
});
