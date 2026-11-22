/**
 * The `implements` relation as a type hierarchy, and models as workspace symbols.
 *
 * These are what the Models view is built from, so the cases that matter are the ones that put
 * a model in the wrong place in that tree: a template and a justification reported with the same
 * kind, an implementer in another file missed, a composition operand mistaken for an implementer,
 * or an item pointing at the file that asked rather than the file that declares.
 *
 * The fixtures are real files and every one of them is built, for the reason given in
 * `renaming-multifile.test.ts`: `load` reads through `node:fs`, and the reference index only
 * knows about documents that went through the builder.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { URI, type LangiumDocument } from 'langium';
import { SymbolKind, type TypeHierarchyItem } from 'vscode-languageserver';
import { createJpipeServices, type Unit } from 'jpipe-language';

let workspace: string;
let services: ReturnType<typeof createJpipeServices>;

beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-hierarchy-'));
    services = createJpipeServices(NodeFileSystem);
});

afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
});

function uriOf(relative: string): string {
    return URI.parse(pathToFileURL(path.join(workspace, relative)).toString()).toString();
}

/** Writes each file, then opens and builds them all together. */
async function build(files: Record<string, string>): Promise<Record<string, LangiumDocument<Unit>>> {
    for (const [relative, content] of Object.entries(files)) {
        const full = path.join(workspace, relative);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    const documents: Record<string, LangiumDocument<Unit>> = {};
    for (const relative of Object.keys(files)) {
        documents[relative] = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
            URI.parse(uriOf(relative))) as LangiumDocument<Unit>;
    }
    await services.shared.workspace.DocumentBuilder.build(Object.values(documents), { validation: true });
    return documents;
}

/** Prepares a hierarchy on whatever `needle` (offset by `column`) sits on. */
async function prepare(
    document: LangiumDocument<Unit>,
    needle: string,
    column = 0
): Promise<TypeHierarchyItem[] | undefined> {
    const index = document.textDocument.getText().indexOf(needle);
    expect(index, `fixture does not contain '${needle}'`).toBeGreaterThanOrEqual(0);
    return services.Jpipe.lsp.TypeHierarchyProvider!.prepareTypeHierarchy(document, {
        textDocument: { uri: document.uri.toString() },
        position: document.textDocument.positionAt(index + column)
    });
}

async function only(document: LangiumDocument<Unit>, needle: string, column = 0): Promise<TypeHierarchyItem> {
    const items = await prepare(document, needle, column);
    expect(items).toHaveLength(1);
    return items![0];
}

const names = (items: TypeHierarchyItem[] | undefined) => (items ?? []).map(i => i.name).sort();

const LIBRARY = `
template Signoff {
    @support review is "Reviewed"
    strategy s is "Check"
    conclusion c is "Approved"
    review supports s
    s supports c
}
template Strict implements Signoff {
    evidence audit is "Audited"
}
`;

describe('workspace symbols', () => {

    test('list every model, with its kind, and nothing else', async () => {
        await build({
            'lib.jd': LIBRARY,
            'app.jd': `load "lib.jd"\njustification Release implements Signoff {\n    evidence review is "Done"\n}\n`
        });
        const symbols = await services.shared.lsp.WorkspaceSymbolProvider!.getSymbols({ query: '' });
        const byName = Object.fromEntries(symbols.map(s => [s.name, s]));

        // No elements, no loads: only what the index exports, which is the models.
        expect(Object.keys(byName).sort()).toEqual(['Release', 'Signoff', 'Strict']);
        expect(byName['Signoff'].kind).toBe(SymbolKind.Interface);
        expect(byName['Strict'].kind).toBe(SymbolKind.Interface);
        expect(byName['Release'].kind).toBe(SymbolKind.Class);
        expect((byName['Release'].location as { uri: string }).uri).toBe(uriOf('app.jd'));
    });
});

describe('preparing a type hierarchy', () => {

    test('on a model name yields that model', async () => {
        const docs = await build({ 'lib.jd': LIBRARY });
        const item = await only(docs['lib.jd'], 'Strict implements');
        expect(item.name).toBe('Strict');
        expect(item.kind).toBe(SymbolKind.Interface);
        expect(item.uri).toBe(uriOf('lib.jd'));
    });

    test('on an element yields nothing — elements are not types', async () => {
        const docs = await build({ 'lib.jd': LIBRARY });
        expect(await prepare(docs['lib.jd'], 'audit is') ?? []).toEqual([]);
    });

    test('on `implements T` points at the file declaring T, not the one asking', async () => {
        const docs = await build({
            'lib.jd': LIBRARY,
            'app.jd': `load "lib.jd"\njustification Release implements Signoff {\n    evidence review is "Done"\n}\n`
        });
        const item = await only(docs['app.jd'], 'Signoff {', 0);
        expect(item.name).toBe('Signoff');
        expect(item.uri).toBe(uriOf('lib.jd'));
    });
});

describe('supertypes', () => {

    test('of a justification are the template it implements, in its own file', async () => {
        const docs = await build({
            'lib.jd': LIBRARY,
            'app.jd': `load "lib.jd"\njustification Release implements Strict {\n    evidence review is "Done"\n}\n`
        });
        const release = await only(docs['app.jd'], 'Release');
        const parents = await services.Jpipe.lsp.TypeHierarchyProvider!.supertypes({ item: release });
        expect(names(parents)).toEqual(['Strict']);
        expect(parents![0].uri).toBe(uriOf('lib.jd'));
    });

    test('resolve through an aliased load', async () => {
        const docs = await build({
            'lib.jd': LIBRARY,
            'app.jd': `load "lib.jd" as lib\njustification Release implements lib:Signoff {\n    evidence lib:Signoff:review is "Done"\n}\n`
        });
        const release = await only(docs['app.jd'], 'Release');
        const parents = await services.Jpipe.lsp.TypeHierarchyProvider!.supertypes({ item: release });
        expect(names(parents)).toEqual(['Signoff']);
    });

    test('of a model implementing nothing are none', async () => {
        const docs = await build({ 'lib.jd': LIBRARY });
        const signoff = await only(docs['lib.jd'], 'Signoff {');
        expect(await services.Jpipe.lsp.TypeHierarchyProvider!.supertypes({ item: signoff })).toBeUndefined();
    });
});

describe('subtypes', () => {

    test('of a template are its implementers across the workspace, templates included', async () => {
        const docs = await build({
            'lib.jd': LIBRARY,
            'a.jd': `load "lib.jd"\njustification Release implements Signoff {\n    evidence review is "Done"\n}\n`,
            'nested/b.jd': `load "../lib.jd" as lib\njustification Hotfix implements lib:Signoff {\n    evidence lib:Signoff:review is "Done"\n}\n`
        });
        const signoff = await only(docs['lib.jd'], 'Signoff {');
        const children = await services.Jpipe.lsp.TypeHierarchyProvider!.subtypes({ item: signoff });
        expect(names(children)).toEqual(['Hotfix', 'Release', 'Strict']);
        expect(children!.find(c => c.name === 'Hotfix')!.uri).toBe(uriOf('nested/b.jd'));
        expect(children!.find(c => c.name === 'Release')!.kind).toBe(SymbolKind.Class);
    });

    test('leave out models that merely use the template as a composition operand', async () => {
        const docs = await build({
            'lib.jd': LIBRARY,
            'app.jd': `load "lib.jd"\ntemplate Bundle is assemble(Signoff, Strict)\n`
        });
        const signoff = await only(docs['lib.jd'], 'Signoff {');
        const children = await services.Jpipe.lsp.TypeHierarchyProvider!.subtypes({ item: signoff });
        expect(names(children)).toEqual(['Strict']);
    });

    test('of a justification are none — nothing can implement one', async () => {
        const docs = await build({
            'lib.jd': LIBRARY,
            'app.jd': `load "lib.jd"\njustification Release implements Signoff {\n    evidence review is "Done"\n}\n`
        });
        const release = await only(docs['app.jd'], 'Release');
        expect(await services.Jpipe.lsp.TypeHierarchyProvider!.subtypes({ item: release })).toBeUndefined();
    });
});

describe('the type hierarchy capability', () => {

    test('is advertised', async () => {
        const result = await services.shared.lsp.LanguageServer.initialize({
            processId: null,
            rootUri: null,
            capabilities: {},
            workspaceFolders: null
        });
        expect(result.capabilities.typeHierarchyProvider).toBeTruthy();
        expect(result.capabilities.workspaceSymbolProvider).toBeTruthy();
    });
});
