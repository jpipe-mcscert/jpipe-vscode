/**
 * Rename is worth testing at the level of the edits it produces, not the range it offers.
 *
 * Langium's rename works by collecting a declaration's references and rewriting each one. The
 * declaration itself only joins that set if `NameProvider.getNameNode` can point at its
 * identifier — and if it cannot, nothing fails and nothing warns: the rename simply comes back
 * one edit short, having renamed every usage and left the declaration behind. That is invisible
 * to any assertion about whether rename was *offered*, so every test here asserts on the change
 * set, and the model-name cases assert the declaration's own line is in it.
 *
 * The qualified-element cases assert a refusal. Those renames are not supported yet, and the
 * distinction that matters is between refusing and doing them wrongly.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import type { TextEdit } from 'vscode-languageserver';
import type { Unit } from 'jpipe-language';
import { createJpipeServices } from 'jpipe-language';

let services: ReturnType<typeof createJpipeServices>;
let parse: ReturnType<typeof parseHelper<Unit>>;

beforeAll(async () => {
    services = createJpipeServices(EmptyFileSystem);
    parse = parseHelper<Unit>(services.Jpipe);
});

/** Positions the cursor at the first occurrence of `needle`, offset `column` into it. */
async function at(source: string, needle: string, column = 0) {
    const document = await parse(source);
    const index = document.textDocument.getText().indexOf(needle);
    expect(index, `fixture does not contain '${needle}'`).toBeGreaterThanOrEqual(0);
    return {
        document,
        params: {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(index + column)
        }
    };
}

async function renameEdits(source: string, needle: string, column = 0, newName = 'NEW'): Promise<TextEdit[]> {
    const { document, params } = await at(source, needle, column);
    const edit = await services.Jpipe.lsp.RenameProvider!.rename(document, { ...params, newName });
    return edit?.changes?.[document.uri.toString()] ?? [];
}

async function isRenameOffered(source: string, needle: string, column = 0): Promise<boolean> {
    const { document, params } = await at(source, needle, column);
    return await services.Jpipe.lsp.RenameProvider!.prepareRename!(document, params) !== undefined;
}

/** The source text each edit replaces, so assertions read as what the user sees. */
function replaced(source: string, edits: TextEdit[]): string[] {
    const lines = source.split('\n');
    return edits.map(e => lines[e.range.start.line].slice(e.range.start.character, e.range.end.character));
}

const TEMPLATE_AND_USER = `template T { @support a is "A" }
justification J implements T { evidence T:a is "A" }`;

const LOCAL_ELEMENTS = `justification J { conclusion c is "C" strategy s is "S" evidence e is "E"
 e supports s
 s supports c }`;

describe('Rename', () => {

    describe('model names', () => {

        // The regression this file exists for: before `getNameNode` handled string ids, this
        // returned a single edit — the `implements T` usage — and silently left `template T`
        // untouched, so accepting the rename produced a justification implementing nothing.
        test('renaming from a reference also rewrites the declaration', async () => {
            const edits = await renameEdits(TEMPLATE_AND_USER, 'implements T', 'implements '.length);
            expect(edits).toHaveLength(2);
            expect(replaced(TEMPLATE_AND_USER, edits)).toEqual(['T', 'T']);
            // Line 0 is `template T` — the declaration.
            expect(edits.some(e => e.range.start.line === 0)).toBe(true);
            expect(edits.every(e => e.newText === 'NEW')).toBe(true);
        });

        test('renaming from the declaration also rewrites the reference', async () => {
            const edits = await renameEdits(TEMPLATE_AND_USER, 'template T', 'template '.length);
            expect(edits).toHaveLength(2);
            expect(edits.some(e => e.range.start.line === 0)).toBe(true);
            expect(edits.some(e => e.range.start.line === 1)).toBe(true);
        });
    });

    describe('unqualified elements', () => {

        test('renaming from a relation rewrites the declaration and the relation', async () => {
            const edits = await renameEdits(LOCAL_ELEMENTS, 'e supports s');
            expect(edits).toHaveLength(2);
            expect(replaced(LOCAL_ELEMENTS, edits)).toEqual(['e', 'e']);
            expect(edits.some(e => e.range.start.line === 0)).toBe(true);
        });
    });

    describe('qualified elements are refused, not mangled', () => {

        // `T:a` is one CST node, so the default provider replaces the whole thing and the element
        // stops overriding `@support a`. Refusing keeps the model intact.
        const QUALIFIED_RELATION = `template T { @support a is "A" }
justification J implements T { evidence T:a is "A" conclusion c is "C" strategy s is "S"
 T:a supports s
 s supports c }`;

        test.each([
            ['the qualifier segment', 0],
            ['the local segment', 2]
        ])('rename is not offered on %s of a qualified reference', async (_label, column) => {
            expect(await isRenameOffered(QUALIFIED_RELATION, 'T:a supports', column)).toBe(false);
            expect(await renameEdits(QUALIFIED_RELATION, 'T:a supports', column)).toHaveLength(0);
        });

        test('rename is not offered on a qualified override declaration', async () => {
            expect(await isRenameOffered(TEMPLATE_AND_USER, 'T:a is')).toBe(false);
            expect(await renameEdits(TEMPLATE_AND_USER, 'T:a is')).toHaveLength(0);
        });

        // The guard keys on the id's shape, not on the presence of a template, so a plain
        // element must stay renameable.
        test('an unqualified element in the same file is still renameable', async () => {
            expect(await isRenameOffered(LOCAL_ELEMENTS, 'e supports s')).toBe(true);
        });
    });
});
