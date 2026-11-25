import { describe, expect, test } from 'vitest';
import manifest from '../package.json' with { type: 'json' };
import type { ContentsRow, ModelContentsAnswer } from 'jpipe-language';
import {
    ELEMENT_COLORS,
    ELEMENT_ICONS,
    elementAt,
    elementLabel,
    elementOrigin,
    fetchElements,
    templateReach,
    viewMessage,
    type Element,
    type ElementList
} from '../src/extension/models-view/elements-tree.js';
import { keyOf, type Model } from '../src/extension/models-view/models-tree.js';
import { MODEL_CONTENTS } from '../src/shared/lsp-protocol.js';

/**
 * The jPipe Outline, minus the editor: how the server's list of a model's elements becomes rows,
 * how a row reads, which element the cursor is in, and what the view says when it is empty or the
 * list partial. Which elements a model has is the server's to say (jpipe-vscode ADR-VSC-0034), and
 * `contents-request.test.ts` in jpipe-language holds it.
 */

const APP = 'file:///w/app.jd';
const LIB = 'file:///w/lib.jd';

const r = (line: number, from = 0, to = 40) => ({ start: { line, character: from }, end: { line, character: to } });

function model(name: string, line: number, extra: Partial<Model> = {}): Model {
    return { key: keyOf(APP, name), name, kind: 'justification', uri: APP, selection: r(line, 14, 14 + name.length), ...extra };
}

const at = (uri: string, line: number) => ({ uri, range: r(line, 4), selection: r(line, 13, 15) });

/** `Release` in `app.jd`: its own `e1` and `s`, then what it inherits from `Signoff` and its composition made up. */
const ANSWER: ModelContentsAnswer = {
    complete: true,
    elements: [
        { id: 'e1', kind: 'evidence', label: 'Tests pass', location: at(APP, 3) },
        { id: 's', kind: 'strategy', label: 'Check', location: at(APP, 4) },
        { id: 'Signoff:c', kind: 'conclusion', label: 'Signed', location: at(LIB, 1), declaredIn: 'Signoff' },
        { id: 'Signoff:slot', kind: 'abstract-support', label: 'Slot', location: at(LIB, 2), declaredIn: 'Signoff' },
        { id: 'unified_0', kind: 'evidence', label: 'Shared', location: at(LIB, 5), declaredIn: 'a', merged: true },
        { id: 'assembleConclusion', kind: 'conclusion' }
    ] satisfies ContentsRow[]
};

/** A server that answers `answer`, and keeps what it was asked. */
function server(answer: ModelContentsAnswer | null) {
    const asked: Array<{ method: string; params: unknown }> = [];
    return {
        asked,
        request: async (method: string, params: unknown) => {
            asked.push({ method, params });
            return answer;
        }
    };
}

async function listOf(answer: ModelContentsAnswer = ANSWER): Promise<ElementList> {
    return (await fetchElements(server(answer).request, model('Release', 2)))!;
}

describe('the model\'s elements', () => {

    test('are asked of the server by the model\'s file, name, and where its name is', async () => {
        const { asked, request } = server(ANSWER);
        await fetchElements(request, model('Release', 2));
        expect(asked).toEqual([{ method: MODEL_CONTENTS, params: { uri: APP, name: 'Release', position: { line: 2, character: 14 } } }]);
    });

    test('are the server\'s rows, in its order, an @support called one', async () => {
        const list = await listOf();
        expect(list.complete).toBe(true);
        expect(list.elements.map(e => `${e.kind} ${e.id}`)).toEqual([
            'evidence e1', 'strategy s', 'conclusion Signoff:c', 'support Signoff:slot', 'evidence unified_0', 'conclusion assembleConclusion'
        ]);
    });

    test('keep where each is declared, and by which model', async () => {
        const list = await listOf();
        expect(list.elements[0]).toEqual({ id: 'e1', kind: 'evidence', label: 'Tests pass', location: at(APP, 3) });
        expect(list.elements[2]).toMatchObject({ declaredIn: 'Signoff', location: { uri: LIB } });
        expect(list.elements[4].merged).toBe(true);
        expect(list.elements[5].location).toBeUndefined();
    });

    test('say when the server cannot vouch for the list whole', async () => {
        expect((await listOf({ complete: false, elements: [] })).complete).toBe(false);
    });

    test('are unknown when the model is not in its file any more', async () => {
        expect(await fetchElements(server(null).request, model('Gone', 2))).toBeUndefined();
    });
});

describe('a row', () => {

    const row = (extra: Partial<Element> = {}): Element => ({ id: 'e1', label: 'Tests pass', kind: 'evidence', location: at(APP, 0), ...extra });

    test('reads id • label', () => {
        expect(elementLabel(row())).toBe('e1 • Tests pass');
    });

    test('is just the id while the label is empty', () => {
        expect(elementLabel(row({ id: 'sub', label: '' }))).toBe('sub');
        expect(elementLabel(row({ id: 'assembleConclusion', label: undefined }))).toBe('assembleConclusion');
    });

    test('says where an element comes from, unless it is the model\'s own', () => {
        expect(elementOrigin(row())).toBeUndefined();
        expect(elementOrigin(row({ declaredIn: 'Signoff' }))).toBe('Declared in Signoff');
        expect(elementOrigin(row({ declaredIn: 'a', merged: true }))).toContain('Merged by the composition');
        expect(elementOrigin(row({ location: undefined }))).toBe('Made by the composition');
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

    test('finds the model\'s own element the cursor is in, and none between elements', async () => {
        const { elements } = await listOf();
        expect(elementAt(elements, { line: 4, character: 10 })?.id).toBe('s');
        expect(elementAt(elements, { line: 2, character: 0 })).toBeUndefined();
    });

    // `Signoff:c` is on line 1 of lib.jd: the cursor on line 1 of app.jd is not in it.
    test('never lands on an element declared in another model', async () => {
        const { elements } = await listOf();
        expect(elementAt(elements, { line: 1, character: 10 })).toBeUndefined();
    });
});

describe('the view says', () => {

    test.each([
        ['nothing selected', undefined, undefined, 'Select a model'],
        ['a model gone from its file', model('Gone', 2), undefined, 'could not be found'],
        ['a model with no elements', model('Release', 2), { complete: true, elements: [] }, 'has no elements'],
        ['a list it cannot vouch for, even empty', model('Release', 2), { complete: false, elements: [] }, 'may be missing'],
        ['a list it cannot vouch for, above its rows', model('Release', 2), { complete: false, elements: [{ id: 'e1', kind: 'evidence' }] }, 'may be missing']
    ] as Array<[string, Model | undefined, ElementList | undefined, string]>)('why, for %s', (_case, m, list, message) => {
        expect(viewMessage(m, list)).toContain(message);
    });

    test('nothing when its rows are the whole list', async () => {
        expect(viewMessage(model('Release', 2), await listOf())).toBeUndefined();
    });

    // A composed model is listed like any other: there is no message for it as such.
    test('nothing special for a composed model', async () => {
        expect(viewMessage(model('Release', 2, { operator: 'assemble' }), await listOf())).toBeUndefined();
    });
});


// What New Justification Implementing… asks before writing `implements` (#121).
describe('how a file reaches a template', () => {

    const TEMPLATE = 11;
    const JUSTIFICATION = 5;
    const MODULE = 2;
    const symbols = [
        { name: '(default)', kind: MODULE, children: [
            { name: 'Local', kind: TEMPLATE }, { name: 'Plain', kind: TEMPLATE }, { name: 'Signoff', kind: JUSTIFICATION }
        ] },
        { name: 'lib', kind: MODULE, children: [{ name: 'Signoff', kind: TEMPLATE }, { name: 'Plain', kind: TEMPLATE }] }
    ];

    test('declared or loaded without a name, it is reached as it is', () => {
        expect(templateReach(symbols, 'Local', TEMPLATE)).toEqual({});
        expect(templateReach(symbols, 'Plain', TEMPLATE)).toEqual({});
    });

    // A justification of the same name in the file is not the template the alias brings in.
    test('loaded under a name, it is reached through it, whatever justification shares its name', () => {
        expect(templateReach(symbols, 'Signoff', TEMPLATE)).toEqual({ alias: 'lib' });
    });

    test('anywhere else, it is not reached, nor by a file with no symbols yet', () => {
        expect(templateReach(symbols, 'Missing', TEMPLATE)).toBeUndefined();
        expect(templateReach([], 'Signoff', TEMPLATE)).toBeUndefined();
    });
});
