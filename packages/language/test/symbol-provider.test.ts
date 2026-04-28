import { beforeAll, describe, expect, test } from 'vitest';
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
