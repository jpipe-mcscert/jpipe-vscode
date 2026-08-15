import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import type { LocationLink } from 'vscode-languageserver-types';
import type { Unit } from 'jpipe-language';
import { createJpipeServices } from 'jpipe-language';

/**
 * Go to definition on an *override* declaration.
 *
 * A justification implementing a template redeclares each `@support` as `Template:name`, and F12
 * on that id should open the abstract element being overridden. The provider handles it in
 * `overrideTargetLink`, reached only after ordinary cross-reference navigation finds nothing —
 * an override id is a declaration, not a reference, so nothing links it.
 *
 * That path had no test at all, which is how a change to it came to be flagged as uncovered.
 */

let services: ReturnType<typeof createJpipeServices>;
let parse: ReturnType<typeof parseHelper<Unit>>;

beforeAll(() => {
    services = createJpipeServices(EmptyFileSystem);
    parse = parseHelper<Unit>(services.Jpipe);
});

const MODEL = `
template T {
    conclusion c is "Claim"
    strategy s is "Strategy"
    @support abs is "Abstract"
    abs supports s
    s supports c
}
justification J implements T {
    conclusion c is "Claim"
    strategy s is "Strategy"
    evidence T:abs is "Concrete"
    T:abs supports s
    s supports c
}
`;

/** Definitions for a cursor placed `within` characters into the first `marker` in the text. */
async function definitionsAt(input: string, marker: string, within: number): Promise<LocationLink[]> {
    const document = await parse(input);
    const offset = document.textDocument.getText().indexOf(marker);
    expect(offset, `marker not found: ${marker}`).toBeGreaterThanOrEqual(0);
    const links = await services.Jpipe.lsp.DefinitionProvider!.getDefinition(document, {
        textDocument: { uri: document.uri.toString() },
        position: document.textDocument.positionAt(offset + within)
    });
    return links ?? [];
}

/** The zero-based line holding `marker`. */
function lineOf(input: string, marker: string): number {
    return input.slice(0, input.indexOf(marker)).split('\n').length - 1;
}

describe('go to definition on an override', () => {

    test('navigates from the override to the @support it overrides', async () => {
        // Cursor inside `abs` of `evidence T:abs is …`, three characters past the `T`.
        const links = await definitionsAt(MODEL, 'T:abs is "Concrete"', 3);
        expect(links).toHaveLength(1);
        expect(links[0].targetRange.start.line).toBe(lineOf(MODEL, '@support abs'));
    });

    test('points the source range at the override being navigated from', async () => {
        // The source range is what the editor underlines on ctrl-hover; pointing it at the
        // template's own declaration would highlight the wrong file entirely in the multi-file
        // case, and the wrong line here.
        const links = await definitionsAt(MODEL, 'T:abs is "Concrete"', 3);
        expect(links[0].originSelectionRange?.start.line)
            .toBe(lineOf(MODEL, 'evidence T:abs'));
    });

    test('offers nothing for a plain, unqualified id', async () => {
        // `strategy s` in the justification is a plain name with no template prefix, so there is
        // no override to navigate to — the early return this exercises is the common case.
        const links = await definitionsAt(MODEL, 'strategy s is "Strategy"\n    evidence', 10);
        expect(links).toHaveLength(0);
    });

    test('offers nothing when the named template does not exist', async () => {
        const links = await definitionsAt(`
justification J {
    conclusion c is "Claim"
    evidence Missing:abs is "Concrete"
    Missing:abs supports c
}
`, 'Missing:abs is', 9);
        expect(links).toHaveLength(0);
    });

    test('offers nothing when the template has no such element', async () => {
        // Reaches past `resolveTemplate` and fails on the element lookup — the branch that made
        // `!targetElement?.$cstNode` unreachable for the suite until now.
        const links = await definitionsAt(`
template T {
    conclusion c is "Claim"
    @support abs is "Abstract"
    abs supports c
}
justification J implements T {
    conclusion c is "Claim"
    evidence T:absent is "Concrete"
    T:absent supports c
}
`, 'T:absent is', 4);
        expect(links).toHaveLength(0);
    });
});

/**
 * The same navigation when the template lives in another file.
 *
 * `resolveTemplate` has three branches — a template declared here, one reached through a plain
 * `load`, and one reached through an aliased load, where the override is written `lib:T:abs` and
 * the first segment is the alias rather than the template. Only the local branch had a test, and
 * the other two are the ones that carry the cost of being wrong: F12 silently does nothing, which
 * reads as "there is nothing there" rather than as a bug.
 *
 * They need files on disk for the same reason the outline's loaded-model cases do — the import
 * service reads through `node:fs`, so `EmptyFileSystem` never sees these loads.
 */
describe('go to definition on an override of a loaded template', () => {

    let tmpDir: string;
    let roots = 0;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-definition-'));
        fs.writeFileSync(path.join(tmpDir, 'lib.jd'), `template T {
    conclusion c is "Claim"
    strategy s is "Strategy"
    @support abs is "Abstract"
    abs supports s
    s supports c
}`);
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /** As `definitionsAt`, for a document that really sits beside `lib.jd`. */
    async function definitionsInFile(input: string, marker: string, within: number): Promise<LocationLink[]> {
        const uri = pathToFileURL(path.join(tmpDir, `root${roots++}.jd`)).toString();
        const document = await parse(input, { documentUri: uri });
        const offset = document.textDocument.getText().indexOf(marker);
        expect(offset, `marker not found: ${marker}`).toBeGreaterThanOrEqual(0);
        const links = await services.Jpipe.lsp.DefinitionProvider!.getDefinition(document, {
            textDocument: { uri },
            position: document.textDocument.positionAt(offset + within)
        });
        return links ?? [];
    }

    const IMPLEMENTOR = (prefix: string) => `justification J implements ${prefix}T {
    conclusion c is "Claim"
    strategy s is "Strategy"
    evidence ${prefix}T:abs is "Concrete"
    ${prefix}T:abs supports s
    s supports c
}`;

    test('navigates into the file a plain load brought in', async () => {
        const source = `load "./lib.jd"\n${IMPLEMENTOR('')}`;
        const links = await definitionsInFile(source, 'evidence T:abs', 12);
        expect(links).toHaveLength(1);
        expect(links[0].targetUri).toContain('lib.jd');
        expect(links[0].targetSelectionRange.start.line).toBe(3);
    });

    test('navigates through the alias an aliased load introduced', async () => {
        const source = `load "./lib.jd" as lib\n${IMPLEMENTOR('lib:')}`;
        const links = await definitionsInFile(source, 'evidence lib:T:abs', 16);
        expect(links).toHaveLength(1);
        expect(links[0].targetUri).toContain('lib.jd');
        expect(links[0].targetSelectionRange.start.line).toBe(3);
    });

    // The alias has to be the one that was written: another file's alias for the same template
    // does not make this one resolve.
    test('offers nothing for an alias no load declares', async () => {
        const source = `load "./lib.jd" as lib\n${IMPLEMENTOR('other:')}`;
        expect(await definitionsInFile(source, 'evidence other:T:abs', 18)).toHaveLength(0);
    });

    test('offers nothing when the load resolves to no file', async () => {
        const source = `load "./nowhere.jd"\n${IMPLEMENTOR('')}`;
        expect(await definitionsInFile(source, 'evidence T:abs', 12)).toHaveLength(0);
    });
});
