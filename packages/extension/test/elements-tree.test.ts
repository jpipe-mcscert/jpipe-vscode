import { describe, expect, test } from 'vitest';
import manifest from '../package.json' with { type: 'json' };
import {
    ELEMENT_COLORS,
    ELEMENT_ICONS,
    elementAt,
    elementLabel,
    elementsOf,
    emptyMessage,
    fetchElements,
    type WireDocumentSymbol
} from '../src/extension/models-view/elements-tree.js';
import { keyOf, type Model, type WireTypeHierarchyItem } from '../src/extension/models-view/models-tree.js';

/**
 * The jPipe Outline, minus the editor: which of a file's symbols are the selected model's own
 * elements, which inherited ones follow them, and how they read. Listing a loaded model's
 * elements as the model's, or an overridden element beside its override, are the failures that
 * matter.
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

    test('leave out the inherited symbols the server places on the model itself', () => {
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

describe('what the model inherits', () => {

    const LIB = 'file:///w/lib.jd';
    const file = (...models: WireDocumentSymbol[]): WireDocumentSymbol[] =>
        [{ name: '(default)', kind: 2, range: span(0, 40), selectionRange: span(0, 40), children: models }];
    const decl = (name: string, kind: number, from: number, children: WireDocumentSymbol[]): WireDocumentSymbol =>
        ({ name, kind, range: span(from, from + 8), selectionRange: span(from, from + 8), children });
    const item = (name: string, uri: string, line: number): WireTypeHierarchyItem =>
        ({ name, kind: 11, uri, range: span(line, line + 8), selectionRange: r(line, 9, 9 + name.length) });

    /**
     * `Release` (app.jd) implements `Signoff` (lib.jd, line 0), which implements `Base` (lib.jd,
     * line 10). `Release` overrides `Signoff:slot`; `Signoff` overrides `Base:x`.
     */
    const FILES: Record<string, WireDocumentSymbol[]> = {
        [APP]: file(decl('Release', 5, 2, [el('e1', 8, 3, 'Tests pass'), el('Signoff:slot', 8, 4, 'Filled')])),
        [LIB]: file(
            decl('Signoff', 11, 0, [el('slot', 26, 1, 'A slot'), el('s', 6, 2, 'Sign'), el('Base:x', 8, 3, 'X, refined')]),
            decl('Base', 11, 10, [el('x', 26, 11, 'X'), el('c', 9, 12, 'Done')]))
    };
    const PARENTS: Record<string, WireTypeHierarchyItem> = {
        Release: item('Signoff', LIB, 0),
        Signoff: item('Base', LIB, 10)
    };
    const request = (parents = PARENTS) => async (method: string, params: unknown): Promise<unknown> => {
        if (method === 'textDocument/documentSymbol') return FILES[(params as { textDocument: { uri: string } }).textDocument.uri];
        const parent = parents[(params as { item: WireTypeHierarchyItem }).item.name];
        return parent ? [parent] : null;
    };

    test('follows its own elements, nearest template first, under qualified ids', async () => {
        const elements = (await fetchElements(request(), model('Release', 2)))!;
        expect(elements.map(e => e.id)).toEqual(['e1', 'Signoff:slot', 'Signoff:s', 'Signoff:Base:x', 'Base:c']);
    });

    test('is not listed once overridden, by the model or by a template in between', async () => {
        const elements = (await fetchElements(request(), model('Release', 2)))!;
        // `Signoff:slot` is the model's own row, and `Base:x` is `Signoff`'s `Base:x`.
        expect(elements.filter(e => e.id === 'Signoff:slot').map(e => e.inheritedFrom)).toEqual([undefined]);
        expect(elements.map(e => e.id)).not.toContain('Base:x');
    });

    test('says which template declares it, and is placed in that template\'s file', async () => {
        const elements = (await fetchElements(request(), model('Release', 2)))!;
        const sign = elements.find(e => e.id === 'Signoff:s')!;
        expect(sign.inheritedFrom).toEqual({ template: 'Signoff', uri: LIB });
        expect(sign.range.start.line).toBe(2);
        expect(elements.find(e => e.id === 'e1')!.inheritedFrom).toBeUndefined();
    });

    test('carries the alias its template is loaded under, and is still hidden by an override', async () => {
        // `load "lib.jd" as lib`: the model writes `lib:Signoff:slot`, and so must the rows.
        const aliased: Record<string, WireDocumentSymbol[]> = {
            ...FILES,
            [APP]: [
                ...file(decl('Release', 5, 2, [el('e1', 8, 3, 'Tests pass'), el('lib:Signoff:slot', 8, 4, 'Filled')])),
                { name: 'lib', kind: 2, range: r(0), selectionRange: r(0), children: [decl('Signoff', 11, 0, []), decl('Base', 11, 0, [])] }
            ]
        };
        const ask = async (method: string, params: unknown) => method === 'textDocument/documentSymbol'
            ? aliased[(params as { textDocument: { uri: string } }).textDocument.uri]
            : request()(method, params);
        const elements = (await fetchElements(ask, model('Release', 2)))!;
        expect(elements.map(e => e.id)).toEqual(['e1', 'lib:Signoff:slot', 'lib:Signoff:s', 'lib:Signoff:Base:x', 'lib:Base:c']);
    });

    test('is never the element the cursor is in', async () => {
        const elements = (await fetchElements(request(), model('Release', 2)))!;
        // Line 12 of lib.jd is `Base:c`; in app.jd, the file being shown, it is nothing.
        expect(elementAt(elements, { line: 12, character: 10 })).toBeUndefined();
    });

    test('stops at a cycle rather than looping', async () => {
        const cyclic = { ...PARENTS, Base: item('Signoff', LIB, 0) };
        const elements = (await fetchElements(request(cyclic), model('Release', 2)))!;
        expect(elements.map(e => e.id)).toEqual(['e1', 'Signoff:slot', 'Signoff:s', 'Signoff:Base:x', 'Base:c']);
    });

    test('keeps what it found when a template cannot be read', async () => {
        const failing = async (method: string, params: unknown) => {
            if (method === 'typeHierarchy/supertypes') throw new Error('server went away');
            return request()(method, params);
        };
        expect((await fetchElements(failing, model('Release', 2)))!.map(e => e.id)).toEqual(['e1', 'Signoff:slot']);
    });

    test('is unknown when the model itself is gone', async () => {
        expect(await fetchElements(request(), model('Gone', 2))).toBeUndefined();
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
        ['a model with no elements', model('Release', 2), [], 'has no elements']
    ])('%s', (_case, m, elements, message) => {
        expect(emptyMessage(m, elements)).toContain(message);
    });

    test('and says nothing when there are rows', () => {
        expect(emptyMessage(model('Release', 2), elementsOf(SYMBOLS, model('Release', 2)))).toBeUndefined();
    });
});
