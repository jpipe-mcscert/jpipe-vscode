import { describe, expect, test } from 'vitest';
import { knownOperatorNames } from 'jpipe-language';
import {
    CALL_HIERARCHY_OUTGOING_REQUEST,
    PREPARE_CALL_HIERARCHY_REQUEST,
    SYMBOL_KIND_CLASS,
    SYMBOL_KIND_INTERFACE,
    TYPE_HIERARCHY_SUBTYPES_REQUEST,
    WORKSPACE_SYMBOL_REQUEST,
    buildTree,
    errorCounts,
    fetchModels,
    OPERATOR_ICONS,
    ambiguousNames,
    cursorAt,
    keyOf,
    modelAtLine,
    modelIcon,
    nodeForModel,
    showsModel,
    treeSignature,
    type Model,
    type ModelNode,
    type ModelStatus,
    type RequestFn,
    type TreeNode,
    type WireTypeHierarchyItem,
    type WireWorkspaceSymbol
} from '../src/extension/models-view/models-tree.js';

/**
 * The Models view, minus the editor: what it asks the language server, and the tree it makes of
 * the answers. A model in the wrong group, missing, or listed under the wrong template is the
 * failure that matters here, and every one of them is decided in this module.
 */

const LIB = 'file:///w/lib.jd';
const APP = 'file:///w/app.jd';

function range(line: number) {
    return { start: { line, character: 9 }, end: { line, character: 15 } };
}

function symbol(name: string, kind: number, uri: string, line = 0): WireWorkspaceSymbol {
    return { name, kind, location: { uri, range: range(line) } };
}

function model(name: string, kind: Model['kind'], uri = LIB, parent?: string, line = 0): Model {
    return {
        key: keyOf(uri, name),
        name,
        kind,
        uri,
        selection: range(line),
        parentKey: parent ? keyOf(LIB, parent) : undefined
    };
}

const asItem = (s: WireWorkspaceSymbol, detail?: string): WireTypeHierarchyItem => ({
    name: s.name, kind: s.kind, uri: s.location.uri,
    range: s.location.range!, selectionRange: s.location.range!,
    ...(detail ? { detail } : {})
});

/**
 * A fake server answering from a symbol list, a template → subtypes table, and a composition
 * table: model name → its operator and operand names, in the order written.
 */
function server(
    symbols: WireWorkspaceSymbol[],
    subtypes: Record<string, WireWorkspaceSymbol[]>,
    compositions: Record<string, { operator: string; operands: string[] }> = {}
) {
    const calls: Array<{ method: string; params: unknown }> = [];
    const byPosition = (uri: string, line: number) =>
        symbols.find(s => s.location.uri === uri && s.location.range!.start.line === line);
    const request: RequestFn = async (method, params) => {
        calls.push({ method, params });
        if (method === WORKSPACE_SYMBOL_REQUEST) return symbols;
        if (method === PREPARE_CALL_HIERARCHY_REQUEST) {
            const { textDocument, position } = params as { textDocument: { uri: string }; position: { line: number } };
            const found = byPosition(textDocument.uri, position.line);
            return found ? [asItem(found, compositions[found.name]?.operator)] : null;
        }
        if (method === CALL_HIERARCHY_OUTGOING_REQUEST) {
            const item = (params as { item: WireTypeHierarchyItem }).item;
            const operands = compositions[item.name]?.operands ?? [];
            // Answered out of order on purpose: the view must sort by where each is written.
            return operands.map((name, i) => ({
                to: asItem(symbols.find(s => s.name === name)!, compositions[name]?.operator),
                fromRanges: [{ start: { line: 9, character: 20 + 10 * i }, end: { line: 9, character: 25 + 10 * i } }]
            })).reverse();
        }
        if (method === TYPE_HIERARCHY_SUBTYPES_REQUEST) {
            const item = (params as { item: WireTypeHierarchyItem }).item;
            if (item.name === 'Broken') throw new Error('no such node');
            return (subtypes[item.name] ?? []).map(s => ({
                name: s.name, kind: s.kind, uri: s.location.uri,
                range: s.location.range!, selectionRange: s.location.range!
            }));
        }
        throw new Error(`unexpected ${method}`);
    };
    return { request, calls };
}

const labels = (nodes: readonly TreeNode[]): unknown[] => nodes.map(n =>
    n.type === 'group'
        ? { [n.label]: labels(n.children) }
        : n.children.length > 0 ? { [n.model.name]: labels(n.children) } : n.model.name);

describe('fetching the models', () => {

    test('asks for every symbol, the subtypes of each template, and whether each model is composed', async () => {
        const { request, calls } = server([
            symbol('Signoff', SYMBOL_KIND_INTERFACE, LIB),
            symbol('Release', SYMBOL_KIND_CLASS, APP)
        ], {});
        await fetchModels(request);
        expect(calls.map(c => c.method)).toEqual([
            WORKSPACE_SYMBOL_REQUEST,
            TYPE_HIERARCHY_SUBTYPES_REQUEST,
            PREPARE_CALL_HIERARCHY_REQUEST,
            PREPARE_CALL_HIERARCHY_REQUEST
        ]);
        expect(calls[0].params).toEqual({ query: '' });
        // The item is built from the symbol: its range is the name, which is where the server
        // looks for the declaration.
        expect((calls[1].params as { item: WireTypeHierarchyItem }).item).toMatchObject({
            name: 'Signoff', uri: LIB, range: range(0), selectionRange: range(0)
        });
    });

    test('links each implementer to its template, across files', async () => {
        const { request } = server([
            symbol('Signoff', SYMBOL_KIND_INTERFACE, LIB),
            symbol('Release', SYMBOL_KIND_CLASS, APP),
            symbol('Loose', SYMBOL_KIND_CLASS, APP, 5)
        ], { Signoff: [symbol('Release', SYMBOL_KIND_CLASS, APP)] });
        const models = await fetchModels(request);
        const byName = Object.fromEntries(models.map(m => [m.name, m]));
        expect(byName['Release'].parentKey).toBe(keyOf(LIB, 'Signoff'));
        expect(byName['Loose'].parentKey).toBeUndefined();
        expect(byName['Signoff'].kind).toBe('template');
        expect(byName['Release'].kind).toBe('justification');
    });

    test('keeps two models of the same name in different files apart', async () => {
        const { request } = server([
            symbol('Signoff', SYMBOL_KIND_INTERFACE, LIB),
            symbol('Release', SYMBOL_KIND_CLASS, APP),
            symbol('Release', SYMBOL_KIND_CLASS, 'file:///w/other.jd')
        ], { Signoff: [symbol('Release', SYMBOL_KIND_CLASS, APP)] });
        const models = await fetchModels(request);
        const releases = models.filter(m => m.name === 'Release');
        expect(releases).toHaveLength(2);
        expect(releases.find(m => m.uri === APP)!.parentKey).toBe(keyOf(LIB, 'Signoff'));
        expect(releases.find(m => m.uri !== APP)!.parentKey).toBeUndefined();
    });

    test('ignores symbols that are not models', async () => {
        const { request } = server([
            symbol('Signoff', SYMBOL_KIND_INTERFACE, LIB),
            symbol('stray', 8 /* Field */, LIB)
        ], {});
        expect((await fetchModels(request)).map(m => m.name)).toEqual(['Signoff']);
    });

    test('a template the server cannot place loses its children, not the view', async () => {
        const { request } = server([
            symbol('Broken', SYMBOL_KIND_INTERFACE, LIB),
            symbol('Release', SYMBOL_KIND_CLASS, APP)
        ], {});
        expect((await fetchModels(request)).map(m => m.name).sort()).toEqual(['Broken', 'Release']);
    });

    test('a server with nothing to say yields no models', async () => {
        expect(await fetchModels(async () => null)).toEqual([]);
    });
});

describe('compositions', () => {

    const symbols = [
        symbol('Build', SYMBOL_KIND_CLASS, LIB, 1),
        symbol('Tests', SYMBOL_KIND_CLASS, LIB, 2),
        symbol('Inner', SYMBOL_KIND_CLASS, APP, 3),
        symbol('Outer', SYMBOL_KIND_CLASS, APP, 4)
    ];
    const table = {
        Inner: { operator: 'assemble', operands: ['Tests', 'Build'] },
        Outer: { operator: 'refine', operands: ['Inner', 'Build'] }
    };

    test('only compositions are asked for their operands', async () => {
        const { request, calls } = server(symbols, {}, table);
        await fetchModels(request);
        const asked = calls.filter(c => c.method === CALL_HIERARCHY_OUTGOING_REQUEST)
            .map(c => (c.params as { item: WireTypeHierarchyItem }).item.name).sort();
        expect(asked).toEqual(['Inner', 'Outer']);
    });

    test('a composition knows its operator and its operands in the order written', async () => {
        const { request } = server(symbols, {}, table);
        const byName = Object.fromEntries((await fetchModels(request)).map(m => [m.name, m]));
        expect(byName['Inner'].operator).toBe('assemble');
        expect(byName['Inner'].operands).toEqual([keyOf(LIB, 'Tests'), keyOf(LIB, 'Build')]);
        expect(byName['Build'].operator).toBeUndefined();
    });

    test('the group lists each composition with its operands, nested compositions expanded', async () => {
        const { request } = server(symbols, {}, table);
        const tree = buildTree(await fetchModels(request));
        expect(labels(tree)).toEqual([
            { Compositions: [
                { Inner: ['Tests', 'Build'] },
                { Outer: [{ Inner: ['Tests', 'Build'] }, 'Build'] }
            ] },
            // Composed justifications are not repeated among the written ones.
            { Justifications: ['Build', 'Tests'] }
        ]);
    });

    test('stays finite when compositions use each other', () => {
        const a = { ...model('A', 'justification'), operator: 'assemble', operands: [keyOf(LIB, 'B')] };
        const b = { ...model('B', 'justification'), operator: 'assemble', operands: [keyOf(LIB, 'A')] };
        expect(labels(buildTree([a, b]))[0]).toEqual({ Compositions: [{ A: ['B'] }, { B: ['A'] }] });
    });

    test('the group sits between Templates and Justifications', () => {
        const tree = buildTree([
            model('Signoff', 'template'),
            model('Written', 'justification', APP),
            { ...model('Release', 'justification', APP), operator: 'assemble', operands: [] }
        ]);
        expect(tree.map(g => g.id)).toEqual(['templates', 'compositions', 'justifications']);
    });

    test('a composed template stays in the Templates forest, where its implementers are', () => {
        const bundle = { ...model('Bundle', 'template'), operator: 'assemble', operands: [] };
        const tree = buildTree([bundle, model('Release', 'justification', APP, 'Bundle')]);
        expect(labels(tree)).toEqual([
            { Templates: [{ Bundle: ['Release'] }] },
            { Compositions: ['Bundle'] },
            { Justifications: ['Release'] }
        ]);
    });

    test('a composed justification is revealed at its own entry, not among another\'s operands', () => {
        const inner = { ...model('Inner', 'justification', APP), operator: 'assemble', operands: [] };
        // `Alpha` sorts first and lists `Inner` among its operands; depth first would stop there.
        const alpha = { ...model('Alpha', 'justification', APP), operator: 'refine', operands: [inner.key] };
        const tree = buildTree([alpha, inner]);
        const node = nodeForModel(tree, inner.key)!;
        expect(node.parent).toBe(tree.find(g => g.id === 'compositions'));
    });

    test.each([
        ['refine', 'arrow-circle-down'],
        ['assemble', 'layers'],
        ['asemble', 'question']
    ])('a %s composition is drawn with %s', (operator, icon) => {
        expect(modelIcon({ ...model('X', 'justification'), operator })).toBe(icon);
    });

    test('a written model is drawn with its kind\'s icon', () => {
        expect(modelIcon(model('T', 'template'))).toBe('book');
        expect(modelIcon(model('J', 'justification'))).toBe('bookmark');
    });

    test('every operator the language server knows has its own icon', () => {
        // A new operator would otherwise be drawn as unknown, which is to say as a mistake.
        expect(Object.keys(OPERATOR_ICONS).sort()).toEqual([...knownOperatorNames()].sort());
    });

    test('an excluded composition is only under Excluded', () => {
        const draft = { ...model('Draft', 'justification', 'file:///w/drafts/d.jd'), operator: 'assemble', operands: [] };
        const tree = buildTree([draft], { isExcluded: uri => uri.includes('drafts'), errorLines: () => [] });
        expect(labels(tree)).toEqual([{ Excluded: ['Draft'] }]);
    });
});

describe('the tree', () => {

    test('nests the implements forest under Templates, and lists justifications flat', () => {
        const tree = buildTree([
            model('Signoff', 'template'),
            model('Strict', 'template', LIB, 'Signoff'),
            model('Release', 'justification', APP, 'Signoff'),
            model('Hotfix', 'justification', APP, 'Strict'),
            model('Loose', 'justification', APP)
        ]);
        expect(labels(tree)).toEqual([
            { Templates: [{ Signoff: [{ Strict: ['Hotfix'] }, 'Release'] }] },
            { Justifications: ['Hotfix', 'Loose', 'Release'] }
        ]);
    });

    test('lists templates before justifications under a template, each alphabetically', () => {
        const tree = buildTree([
            model('Signoff', 'template'),
            model('Zeta', 'template', LIB, 'Signoff'),
            model('Beta', 'justification', APP, 'Signoff'),
            model('Alpha', 'justification', APP, 'Signoff')
        ]);
        expect(labels(tree)[0]).toEqual({ Templates: [{ Signoff: ['Zeta', 'Alpha', 'Beta'] }] });
    });

    test('leaves out an empty group', () => {
        expect(labels(buildTree([model('Release', 'justification', APP)])))
            .toEqual([{ Justifications: ['Release'] }]);
        expect(buildTree([])).toEqual([]);
    });

    test('treats a template whose parent is outside the workspace as a root', () => {
        const orphan = { ...model('Strict', 'template'), parentKey: keyOf('file:///elsewhere.jd', 'Gone') };
        expect(labels(buildTree([orphan]))).toEqual([{ Templates: ['Strict'] }]);
    });

    test('stays finite on an implements cycle, and still shows every template', () => {
        const tree = buildTree([
            model('A', 'template', LIB, 'B'),
            model('B', 'template', LIB, 'A'),
            model('Self', 'template', LIB, 'Self')
        ]);
        expect(labels(tree)).toEqual([{ Templates: [{ A: ['B'] }, 'Self'] }]);
    });

    test('gives every node a distinct id, though a justification appears twice', () => {
        const tree = buildTree([
            model('Signoff', 'template'),
            model('Release', 'justification', APP, 'Signoff')
        ]);
        const ids: string[] = [];
        const walk = (nodes: readonly TreeNode[]) => nodes.forEach(n => { ids.push(n.id); walk(n.children); });
        walk(tree);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('links each node to its parent, which revealing depends on', () => {
        const tree = buildTree([
            model('Signoff', 'template'),
            model('Release', 'justification', APP, 'Signoff')
        ]);
        const signoff = tree[0].children[0];
        expect(signoff.parent).toBe(tree[0]);
        expect(signoff.children[0].parent).toBe(signoff);
        expect(signoff.children[0].parentName).toBe('Signoff');
    });
});

describe('errors and exclusions', () => {

    /** A status where `excluded` files are excluded and `errors` maps a file to its error lines. */
    function status(excluded: string[], errors: Record<string, number[]> = {}): ModelStatus {
        return { isExcluded: uri => excluded.includes(uri), errorLines: uri => errors[uri] ?? [] };
    }

    const DRAFTS = 'file:///w/drafts/old.jd';

    test('an error belongs to the model it falls in', () => {
        const models = [
            model('First', 'justification', APP, undefined, 2),
            model('Second', 'justification', APP, undefined, 10)
        ];
        const counts = errorCounts(models, () => [3, 4, 12]);
        expect(counts.get(keyOf(APP, 'First'))).toBe(2);
        expect(counts.get(keyOf(APP, 'Second'))).toBe(1);
    });

    test('an error above every model — on a load — counts against each of them', () => {
        const models = [
            model('First', 'justification', APP, undefined, 2),
            model('Second', 'justification', APP, undefined, 10)
        ];
        const counts = errorCounts(models, uri => uri === APP ? [0] : []);
        expect(counts.get(keyOf(APP, 'First'))).toBe(1);
        expect(counts.get(keyOf(APP, 'Second'))).toBe(1);
    });

    test('Errors comes first, lists broken models flat with their count, and leaves them in place', () => {
        const tree = buildTree([
            model('Signoff', 'template', LIB, undefined, 1),
            model('Release', 'justification', APP, 'Signoff', 1),
            model('Fine', 'justification', 'file:///w/fine.jd', undefined, 1)
        ], status([], { [APP]: [2, 3], [LIB]: [1] }));
        expect(labels(tree)).toEqual([
            { Errors: ['Signoff', 'Release'] },
            { Templates: [{ Signoff: ['Release'] }] },
            { Justifications: ['Fine', 'Release'] }
        ]);
        expect(tree[0].children.map(n => n.errors)).toEqual([1, 2]);
        // Only the Errors group carries a count.
        expect(tree[2].children.every(n => n.errors === undefined)).toBe(true);
    });

    test('Excluded comes last and takes its models out of the other groups', () => {
        const tree = buildTree([
            model('Signoff', 'template'),
            model('Release', 'justification', APP, 'Signoff'),
            model('Draft', 'justification', DRAFTS, 'Signoff'),
            model('OldTemplate', 'template', DRAFTS)
        ], status([DRAFTS]));
        expect(labels(tree)).toEqual([
            { Templates: [{ Signoff: ['Release'] }] },
            { Justifications: ['Release'] },
            { Excluded: ['OldTemplate', 'Draft'] }
        ]);
        // Still knows what it implements, for its tooltip.
        expect(tree[2].children.find(n => n.model.name === 'Draft')!.parentName).toBe('Signoff');
    });

    test('a template whose parent is excluded becomes a root', () => {
        const tree = buildTree([
            model('Base', 'template', DRAFTS),
            { ...model('Strict', 'template'), parentKey: keyOf(DRAFTS, 'Base') }
        ], status([DRAFTS]));
        expect(labels(tree)).toEqual([{ Templates: ['Strict'] }, { Excluded: ['Base'] }]);
    });

    test('an excluded model is never in Errors', () => {
        const tree = buildTree([model('Draft', 'justification', DRAFTS)], status([DRAFTS], { [DRAFTS]: [0] }));
        expect(labels(tree)).toEqual([{ Excluded: ['Draft'] }]);
    });

    test('node ids stay distinct when a model is in Errors as well as its own group', () => {
        const tree = buildTree([
            model('Signoff', 'template'),
            model('Release', 'justification', APP, 'Signoff')
        ], status([], { [APP]: [0] }));
        const ids: string[] = [];
        const walk = (nodes: readonly TreeNode[]) => nodes.forEach(n => { ids.push(n.id); walk(n.children); });
        walk(tree);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('reveals a model in its own group, not in Errors; an excluded one in Excluded', () => {
        const tree = buildTree([
            model('Release', 'justification', APP),
            model('Draft', 'justification', DRAFTS)
        ], status([DRAFTS], { [APP]: [0] }));
        expect((nodeForModel(tree, keyOf(APP, 'Release'))!.parent as { id: string }).id).toBe('justifications');
        expect((nodeForModel(tree, keyOf(DRAFTS, 'Draft'))!.parent as { id: string }).id).toBe('excluded');
    });
});

describe('which rows show their file', () => {

    test('only models whose name another model shares', () => {
        const names = ambiguousNames([
            model('Release', 'justification', APP),
            model('Release', 'justification', 'file:///w/other.jd'),
            model('Signoff', 'template')
        ]);
        expect([...names]).toEqual(['Release']);
    });
});

describe('clicking a row', () => {

    test('puts the cursor at the start of the name rather than selecting it', () => {
        // A selection would have the editor highlight every occurrence of the same text.
        expect(cursorAt(range(4))).toEqual({ start: { line: 4, character: 9 }, end: { line: 4, character: 9 } });
    });
});

describe('following the cursor', () => {

    const inFile = [
        model('First', 'justification', APP, undefined, 2),
        model('Second', 'template', APP, undefined, 10)
    ];

    test.each([
        [0, undefined],      // among the loads
        [2, 'First'],
        [9, 'First'],
        [10, 'Second'],
        [99, 'Second']
    ])('line %i is in %s', (line, expected) => {
        expect(modelAtLine(inFile, line)?.name).toBe(expected);
    });

    test('a selected row for the same model stays selected, wherever it is in the tree', () => {
        const tree = buildTree([
            model('Signoff', 'template'),
            model('Release', 'justification', APP, 'Signoff')
        ]);
        // Release as a child of its template, not its row in the Justifications list.
        const underTemplate = tree.find(g => g.id === 'templates')!.children[0].children[0];
        expect(underTemplate.model.name).toBe('Release');
        expect(showsModel(underTemplate, keyOf(APP, 'Release'))).toBe(true);
        expect(showsModel(underTemplate, keyOf(LIB, 'Signoff'))).toBe(false);
        expect(showsModel(tree[0], keyOf(APP, 'Release'))).toBe(false);
        expect(showsModel(undefined, keyOf(APP, 'Release'))).toBe(false);
    });

    test('re-publishing the same diagnostics changes nothing worth a refresh', () => {
        const models = [model('Signoff', 'template'), model('Release', 'justification', APP, 'Signoff')];
        const clean = { isExcluded: () => false, errorLines: () => [] };
        const broken = { isExcluded: () => false, errorLines: (uri: string) => uri === APP ? [0] : [] };
        expect(treeSignature(buildTree(models, clean))).toBe(treeSignature(buildTree(models, clean)));
        expect(treeSignature(buildTree(models, broken))).not.toBe(treeSignature(buildTree(models, clean)));
        const twoErrors = { isExcluded: () => false, errorLines: (uri: string) => uri === APP ? [0, 1] : [] };
        expect(treeSignature(buildTree(models, twoErrors))).not.toBe(treeSignature(buildTree(models, broken)));
    });

    test('reveals a justification in the flat list, a template in the forest', () => {
        const tree = buildTree([
            model('Signoff', 'template'),
            model('Release', 'justification', APP, 'Signoff')
        ]);
        const release = nodeForModel(tree, keyOf(APP, 'Release')) as ModelNode;
        expect(release.parent).toBe(tree.find(g => g.id === 'justifications'));
        const signoff = nodeForModel(tree, keyOf(LIB, 'Signoff')) as ModelNode;
        expect(signoff.parent).toBe(tree.find(g => g.id === 'templates'));
        expect(nodeForModel(tree, keyOf(APP, 'Nope'))).toBeUndefined();
    });
});
