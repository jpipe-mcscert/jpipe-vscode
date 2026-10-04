import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { SymbolKind, type DocumentSymbol } from 'vscode-languageserver-types';
import type { Unit } from 'jpipe-language';
import { createJpipeServices } from 'jpipe-language';

let services: ReturnType<typeof createJpipeServices>;
let parse: ReturnType<typeof parseHelper<Unit>>;

beforeAll(async () => {
    services = createJpipeServices(EmptyFileSystem);
    parse = parseHelper<Unit>(services.Jpipe);
});

async function getSymbols(input: string): Promise<DocumentSymbol[]> {
    const doc = await parse(input);
    return services.Jpipe.lsp.DocumentSymbolProvider!.getSymbols(
        doc,
        { textDocument: { uri: doc.uri.toString() } }
    ) as Promise<DocumentSymbol[]>;
}

describe('Document symbol provider (outline)', () => {

    test('local justification appears under (default) namespace', async () => {
        const symbols = await getSymbols(`
            justification J {
                conclusion c is "Claim"
            }
        `);
        expect(symbols).toHaveLength(1);
        expect(symbols[0].name).toBe('(default)');
        expect(symbols[0].kind).toBe(SymbolKind.Module);
        expect(symbols[0].children?.map(c => c.name)).toContain('J');
        expect(symbols[0].children?.find(c => c.name === 'J')?.kind).toBe(SymbolKind.Class);
    });

    test('local template appears under (default) namespace', async () => {
        const symbols = await getSymbols(`
            template T {
                @support abs is "Abstract"
            }
        `);
        const def = symbols[0];
        expect(def.name).toBe('(default)');
        const t = def.children?.find(c => c.name === 'T');
        expect(t).toBeDefined();
        expect(t?.kind).toBe(SymbolKind.Interface);
    });

    test('local elements shown with their qualified name', async () => {
        const symbols = await getSymbols(`
            justification J {
                evidence e is "Evidence"
                strategy s is "Strategy"
                conclusion c is "Claim"
                e supports s
                s supports c
            }
        `);
        const j = symbols[0].children!.find(c => c.name === 'J')!;
        const names = j.children!.map(c => c.name);
        expect(names).toContain('e');
        expect(names).toContain('s');
        expect(names).toContain('c');
    });

    test('inherited elements labeled as (inherited) templateId:elementId', async () => {
        const symbols = await getSymbols(`
            template T {
                @support abs is "Abstract"
            }
            justification J implements T {
                conclusion c is "Claim"
            }
        `);
        const j = symbols[0].children!.find(c => c.name === 'J')!;
        const names = j.children!.map(c => c.name);
        expect(names).toContain('c');
        expect(names).toContain('(inherited) T:abs');
    });

    test('local elements and inherited elements are both shown under model', async () => {
        const symbols = await getSymbols(`
            template Base {
                @support b:x is "X"
            }
            justification J implements Base {
                evidence e is "Evidence"
                conclusion c is "Claim"
                e supports c
            }
        `);
        const j = symbols[0].children!.find(c => c.name === 'J')!;
        const names = j.children!.map(c => c.name);
        expect(names).toContain('e');
        expect(names).toContain('c');
        expect(names).toContain('(inherited) Base:b:x');
    });

    test('(default) is omitted when there are no local models', async () => {
        // A file with only a named load and no local models produces no (default) group.
        // We can't test real file loads with EmptyFileSystem, so we verify the inverse:
        // a file with at least one local model always produces a (default) group.
        const symbols = await getSymbols(`
            justification J {
                conclusion c is "Claim"
            }
        `);
        expect(symbols.some(s => s.name === '(default)')).toBe(true);
    });

    test('element symbol kinds match node types', async () => {
        const symbols = await getSymbols(`
            template T {
                @support abs is "Abs"
            }
            justification J implements T {
                evidence e is "E"
                strategy s is "S"
                sub-conclusion sc is "SC"
                conclusion c is "C"
                e supports s
                s supports sc
                sc supports c
            }
        `);
        const j = symbols[0].children!.find(c => c.name === 'J')!;
        const byName = Object.fromEntries(j.children!.map(c => [c.name, c.kind]));
        expect(byName['e']).toBe(SymbolKind.Field);
        expect(byName['s']).toBe(SymbolKind.Method);
        expect(byName['sc']).toBe(SymbolKind.Variable);
        expect(byName['c']).toBe(SymbolKind.Constructor);
        expect(byName['(inherited) T:abs']).toBe(SymbolKind.TypeParameter);
    });
});

/**
 * The outline's other half: everything a `load` brings in.
 *
 * None of it was covered, because none of it can be reached without files on disk —
 * `JpipeImportService` reads through `node:fs` rather than Langium's `FileSystemProvider`, so
 * `EmptyFileSystem` does not intercept it and a fixture written as a string is invisible to it.
 * That is the same reason `import.test.ts` and `glob-load.test.ts` write real files, and this
 * follows them.
 *
 * What it protects is the shape of the tree rather than any one symbol: an unnamespaced load
 * folds its models in beside the local ones, an aliased load gets a node of its own named after
 * the alias, and a load matching several files puts all of them under that one node. Each is a
 * separate branch, and a regression in any of them shows up as an outline that is merely
 * *arranged* wrongly — still populated, still plausible, and easy to miss.
 */
describe('Document symbol provider (loaded models)', () => {

    let tmpDir: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-symbols-'));
        fs.writeFileSync(path.join(tmpDir, 'lib.jd'),
            'template T {\n conclusion c is "C"\n @support a is "A"\n a supports c\n}');
        fs.writeFileSync(path.join(tmpDir, 'more.jd'),
            'justification M {\n conclusion mc is "MC"\n}');
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    let roots = 0;

    /**
     * Symbols for a document that really sits in the temp directory, so its loads resolve.
     *
     * Each call gets its own filename: the documents live in one shared workspace for the whole
     * file, and re-registering a URI is an error rather than a replacement.
     */
    async function symbolsOfFile(source: string): Promise<DocumentSymbol[]> {
        const uri = pathToFileURL(path.join(tmpDir, `root${roots++}.jd`)).toString();
        const doc = await parse(source, { documentUri: uri });
        return services.Jpipe.lsp.DocumentSymbolProvider!.getSymbols(
            doc, { textDocument: { uri } }) as Promise<DocumentSymbol[]>;
    }

    const nameOf = (symbols: DocumentSymbol[] | undefined) => (symbols ?? []).map(s => s.name);

    test('an unnamespaced load contributes its models to (default)', async () => {
        const symbols = await symbolsOfFile('load "./lib.jd"\njustification J { conclusion c is "C" }');
        expect(nameOf(symbols)).toEqual(['(default)']);
        expect(nameOf(symbols[0].children)).toEqual(['J', 'T']);
    });

    test('a loaded model brings its own elements with it', async () => {
        const symbols = await symbolsOfFile('load "./lib.jd"\njustification J { conclusion c is "C" }');
        const template = symbols[0].children?.find(child => child.name === 'T');
        expect(template?.kind).toBe(SymbolKind.Interface);
        expect(nameOf(template?.children)).toEqual(['c', 'a']);
    });

    test('an aliased load gets a namespace node of its own', async () => {
        const symbols = await symbolsOfFile('load "./lib.jd" as lib\njustification J { conclusion c is "C" }');
        expect(nameOf(symbols)).toEqual(['(default)', 'lib']);
        expect(nameOf(symbols[0].children)).toEqual(['J']);
        const namespace = symbols[1];
        expect(namespace.kind).toBe(SymbolKind.Module);
        expect(nameOf(namespace.children)).toEqual(['T']);
    });

    // A file with nothing but an aliased load has no (default) node at all, which is the branch
    // that decides whether the outline opens with one.
    test('a namespace node stands alone when nothing is declared locally', async () => {
        const symbols = await symbolsOfFile('load "./lib.jd" as lib');
        expect(nameOf(symbols)).toEqual(['lib']);
    });

    test('a globbed load puts every file it matched under the one namespace', async () => {
        const symbols = await symbolsOfFile('load "./*.jd" as all');
        expect(nameOf(symbols)).toEqual(['all']);
        expect(nameOf(symbols[0].children)).toEqual(['T', 'M']);
    });

    test('a load that resolves to nothing contributes no symbols', async () => {
        const symbols = await symbolsOfFile('load "./nowhere.jd" as gone\njustification J { conclusion c is "C" }');
        expect(nameOf(symbols)).toEqual(['(default)', 'gone']);
        expect(symbols[1].children).toBeUndefined();
    });
});
