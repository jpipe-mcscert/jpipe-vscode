import { describe, expect, test } from 'vitest';
import manifest from '../package.json' with { type: 'json' };
import {
    ELEMENT_COLORS,
    ELEMENT_ICONS,
    elementAt,
    elementLabel,
    elementsOf,
    emptyMessage,
    type WireDocumentSymbol
} from '../src/extension/models-view/elements-tree.js';
import { keyOf, type Model } from '../src/extension/models-view/models-tree.js';

/**
 * The jPipe Outline, minus the editor: which of a file's symbols are the selected model's own
 * elements, and how they read. Listing a loaded model's elements, or an inherited one, as if the
 * model declared it is the failure that matters.
 */

const APP = 'file:///w/app.jd';

const r = (line: number, from = 0, to = 40) => ({ start: { line, character: from }, end: { line, character: to } });
const span = (from: number, to: number) => ({ start: { line: from, character: 0 }, end: { line: to, character: 1 } });

function el(name: string, kind: number, line: number, detail?: string): WireDocumentSymbol {
    return { name, kind, range: r(line, 4), selectionRange: r(line, 13, 15), ...(detail !== undefined ? { detail } : {}) };
}

function model(name: string, line: number, extra: Partial<Model> = {}): Model {
    return { key: keyOf(APP, name), name, kind: 'justification', uri: APP, selection: r(line, 14, 14 + name.length), ...extra };
}

/** `app.jd`: loads a file declaring another `Release`, then declares `Release` (lines 2–8) and `Other`. */
const SYMBOLS: WireDocumentSymbol[] = [{
    name: '(default)', kind: 2, range: span(0, 20), selectionRange: span(0, 20),
    children: [
        {
            // A loaded model of the same name: its range is the `load` line.
            name: 'Release', kind: 5, range: r(0), selectionRange: r(0),
            children: [el('stranger', 8, 0, 'Not ours')]
        },
        {
            name: 'Release', kind: 5, range: span(2, 8), selectionRange: span(2, 8),
            children: [
                el('e1', 8, 3, 'Tests pass'),
                el('s', 6, 4, 'Check'),
                el('c', 9, 5, 'Ready'),
                el('sub', 13, 6, ''),
                el('(inherited) Signoff:x', 8, 2, 'Inherited')
            ]
        },
        { name: 'Other', kind: 5, range: span(10, 12), selectionRange: span(10, 12), children: [el('o', 8, 11, 'O')] }
    ]
}];

describe('the model\'s elements', () => {

    test('are its own, in the order written, with their kinds and labels', () => {
        const elements = elementsOf(SYMBOLS, model('Release', 2))!;
        expect(elements.map(e => [e.id, e.kind, e.label])).toEqual([
            ['e1', 'evidence', 'Tests pass'],
            ['s', 'strategy', 'Check'],
            ['c', 'conclusion', 'Ready'],
            ['sub', 'sub-conclusion', '']
        ]);
    });

    test('come from the model declared here, not a loaded one with the same name', () => {
        const ids = elementsOf(SYMBOLS, model('Release', 2))!.map(e => e.id);
        expect(ids).not.toContain('stranger');
    });

    test('leave out what the model inherits', () => {
        expect(elementsOf(SYMBOLS, model('Release', 2))!.some(e => e.id.includes('inherited'))).toBe(false);
    });

    test('of an @support are recognised as such', () => {
        const symbols: WireDocumentSymbol[] = [{
            name: '(default)', kind: 2, range: span(0, 5), selectionRange: span(0, 5),
            children: [{ name: 'T', kind: 11, range: span(0, 5), selectionRange: span(0, 5), children: [el('slot', 26, 1, 'S')] }]
        }];
        expect(elementsOf(symbols, model('T', 0, { kind: 'template' }))!.map(e => e.kind)).toEqual(['support']);
    });

    test('are unknown when the model is not in the file any more', () => {
        expect(elementsOf(SYMBOLS, model('Gone', 2))).toBeUndefined();
    });
});

describe('a row', () => {

    test('reads id • label', () => {
        expect(elementLabel({ id: 'e1', label: 'Tests pass', kind: 'evidence', range: r(0), selection: r(0) }))
            .toBe('e1 • Tests pass');
    });

    test('is just the id while the label is empty', () => {
        expect(elementLabel({ id: 'sub', label: '', kind: 'sub-conclusion', range: r(0), selection: r(0) })).toBe('sub');
    });

    test('has a colour for every kind, each one contributed by the manifest', () => {
        // A colour id nobody contributes resolves to nothing, and the icon silently loses its colour.
        const contributed = manifest.contributes.colors.map(c => c.id);
        expect(Object.keys(ELEMENT_COLORS).sort()).toEqual(Object.keys(ELEMENT_ICONS).sort());
        for (const id of Object.values(ELEMENT_COLORS)) expect(contributed).toContain(id);
    });

    test('has an icon for every kind', () => {
        expect(Object.keys(ELEMENT_ICONS).sort())
            .toEqual(['conclusion', 'evidence', 'strategy', 'sub-conclusion', 'support']);
    });
});

describe('following the cursor', () => {

    test('finds the element the cursor is in, and none between elements', () => {
        const elements = elementsOf(SYMBOLS, model('Release', 2))!;
        expect(elementAt(elements, { line: 4, character: 10 })?.id).toBe('s');
        expect(elementAt(elements, { line: 2, character: 0 })).toBeUndefined();
    });
});

describe('an empty view says why', () => {

    test.each([
        ['nothing selected', undefined, undefined, 'Select a model'],
        ['a composition', model('Release', 2, { operator: 'assemble' }), [], 'composed by assemble'],
        ['a model gone from its file', model('Gone', 2), undefined, 'could not be found'],
        ['a model with no elements', model('Release', 2), [], 'no elements of its own']
    ])('%s', (_case, m, elements, message) => {
        expect(emptyMessage(m, elements)).toContain(message);
    });

    test('and says nothing when there are rows', () => {
        expect(emptyMessage(model('Release', 2), elementsOf(SYMBOLS, model('Release', 2)))).toBeUndefined();
    });
});
