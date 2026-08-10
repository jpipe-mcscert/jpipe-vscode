/**
 * Renaming a model that is loaded from another file, under an alias.
 *
 * Two failures live only here. `implements lib:T` is a *single* cross-reference whose text is
 * `lib:T`, so a rename that replaces the reference wholesale writes `implements Signoff` and
 * unresolves the very link it was asked to preserve. And the override in the loading file is
 * spelled `lib:T:a` — three segments, only the middle one being the template's name.
 *
 * `JpipeImportService` reads through `node:fs` rather than Langium's `FileSystemProvider`, so
 * `EmptyFileSystem` does not intercept it and the fixtures have to be real files. They also have
 * to be *built*: the rename walks the open documents, and a file that was never opened is a file
 * whose overrides nobody rewrites.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { URI, type LangiumDocument } from 'langium';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Diagnostic, type TextEdit } from 'vscode-languageserver';
import { createJpipeServices, type Unit } from 'jpipe-language';

let workspace: string;
let services: ReturnType<typeof createJpipeServices>;

beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-rename-'));
    services = createJpipeServices(NodeFileSystem);
});

afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
});

function write(relative: string, content: string): void {
    const full = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

function uriOf(relative: string): string {
    return URI.parse(pathToFileURL(path.join(workspace, relative)).toString()).toString();
}

/** Opens every written file and builds it, so the rename sees the workspace the user sees. */
async function build(...relatives: string[]): Promise<LangiumDocument<Unit>[]> {
    const documents = await Promise.all(relatives.map(async relative =>
        await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
            URI.parse(uriOf(relative))) as LangiumDocument<Unit>));
    await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
    return documents;
}

/** Renames whatever `needle` (offset by `column`) sits on, and returns every file's new text. */
async function renameAcross(
    documents: LangiumDocument<Unit>[],
    inFile: LangiumDocument<Unit>,
    needle: string,
    column: number,
    newName: string
): Promise<Record<string, string>> {
    const index = inFile.textDocument.getText().indexOf(needle);
    expect(index, `fixture does not contain '${needle}'`).toBeGreaterThanOrEqual(0);
    const edit = await services.Jpipe.lsp.RenameProvider!.rename(inFile, {
        textDocument: { uri: inFile.uri.toString() },
        position: inFile.textDocument.positionAt(index + column),
        newName
    });

    const result: Record<string, string> = {};
    for (const document of documents) {
        const uri = document.uri.toString();
        const edits: TextEdit[] = edit?.changes?.[uri] ?? [];
        result[uri] = TextDocument.applyEdits(
            TextDocument.create(uri, 'jpipe', 0, document.textDocument.getText()), edits);
    }
    return result;
}

function errorsIn(document: LangiumDocument<Unit>): string[] {
    return (document.diagnostics ?? [])
        .filter(diagnostic => diagnostic.severity === 1)
        .map(diagnostic => Diagnostic.getMessageString(diagnostic));
}

const LIBRARY = `template T {
 @support a is "A"
 strategy s is "S"
 conclusion c is "C"
 a supports s
 s supports c
}`;

const USER = `load "./library.jd" as lib

justification J implements lib:T {
 evidence lib:T:a is "Signed off"
 lib:T:a supports lib:T:s
}`;

describe('renaming a template loaded under an alias', () => {

    test('the fixture is a pair of models with nothing wrong with them', async () => {
        write('library.jd', LIBRARY);
        write('user.jd', USER);
        const [, user] = await build('library.jd', 'user.jd');
        expect(errorsIn(user)).toEqual([]);
    });

    test('the alias survives and only the template segment changes', async () => {
        write('library.jd', LIBRARY);
        write('user.jd', USER);
        const documents = await build('library.jd', 'user.jd');
        const after = await renameAcross(documents, documents[0], 'template T', 'template '.length, 'Signoff');

        expect(after[uriOf('library.jd')]).toContain('template Signoff {');
        expect(after[uriOf('user.jd')]).toContain('load "./library.jd" as lib');
        expect(after[uriOf('user.jd')]).toContain('implements lib:Signoff {');
        expect(after[uriOf('user.jd')]).toContain('evidence lib:Signoff:a is "Signed off"');
        expect(after[uriOf('user.jd')]).toContain('lib:Signoff:a supports lib:Signoff:s');
    });

    test('the renamed pair still validates', async () => {
        write('library.jd', LIBRARY);
        write('user.jd', USER);
        const documents = await build('library.jd', 'user.jd');
        const after = await renameAcross(documents, documents[0], 'template T', 'template '.length, 'Signoff');

        // A fresh workspace, so the rebuild reads the renamed text rather than the fixture.
        services = createJpipeServices(NodeFileSystem);
        write('library.jd', after[uriOf('library.jd')]);
        write('user.jd', after[uriOf('user.jd')]);
        const [, user] = await build('library.jd', 'user.jd');
        expect(errorsIn(user)).toEqual([]);
    });

    test('renaming from the loading file reaches the declaration in the other one', async () => {
        write('library.jd', LIBRARY);
        write('user.jd', USER);
        const documents = await build('library.jd', 'user.jd');
        const after = await renameAcross(documents, documents[1], 'implements lib:T', 'implements lib:'.length, 'Signoff');

        expect(after[uriOf('library.jd')]).toContain('template Signoff {');
        expect(after[uriOf('user.jd')]).toContain('implements lib:Signoff {');
    });

    // The alias is not a linked name — nothing in the index connects `lib` to the load that
    // declared it — so a cursor there is asking for a rename this provider cannot perform.
    test('rename is declined on the alias segment', async () => {
        write('library.jd', LIBRARY);
        write('user.jd', USER);
        const documents = await build('library.jd', 'user.jd');
        const user = documents[1];
        const index = user.textDocument.getText().indexOf('implements lib:T') + 'implements '.length;
        const params = {
            textDocument: { uri: user.uri.toString() },
            position: user.textDocument.positionAt(index)
        };
        expect(await services.Jpipe.lsp.RenameProvider!.prepareRename!(user, params)).toBeUndefined();
        expect(await services.Jpipe.lsp.RenameProvider!.rename(user, { ...params, newName: 'other' })).toBeUndefined();
    });

    // The other half of the same problem: an `@support` names what implementers must restate, and
    // in another file they restate it through the alias.
    test('renaming the @support carries into the loading file, alias and all', async () => {
        write('library.jd', LIBRARY);
        write('user.jd', USER);
        const documents = await build('library.jd', 'user.jd');
        const after = await renameAcross(documents, documents[0], '@support a', '@support '.length, 'signoff');

        expect(after[uriOf('library.jd')]).toContain('@support signoff is "A"');
        expect(after[uriOf('library.jd')]).toContain('signoff supports s');
        expect(after[uriOf('user.jd')]).toContain('evidence lib:T:signoff is "Signed off"');
        expect(after[uriOf('user.jd')]).toContain('lib:T:signoff supports lib:T:s');
    });

    test('the pair still validates once the @support is renamed', async () => {
        write('library.jd', LIBRARY);
        write('user.jd', USER);
        const documents = await build('library.jd', 'user.jd');
        const after = await renameAcross(documents, documents[0], '@support a', '@support '.length, 'signoff');

        services = createJpipeServices(NodeFileSystem);
        write('library.jd', after[uriOf('library.jd')]);
        write('user.jd', after[uriOf('user.jd')]);
        const [, user] = await build('library.jd', 'user.jd');
        expect(errorsIn(user)).toEqual([]);
    });

    // Renaming it where it is restated would have to rename the template's declaration and every
    // sibling restatement, from a line that reads like a local edit.
    test('rename is declined at the override, naming the template it came from', async () => {
        write('library.jd', LIBRARY);
        write('user.jd', USER);
        const documents = await build('library.jd', 'user.jd');
        const user = documents[1];
        const index = user.textDocument.getText().indexOf('lib:T:a is') + 'lib:T:'.length;
        const params = {
            textDocument: { uri: user.uri.toString() },
            position: user.textDocument.positionAt(index)
        };
        // `prepareRename` declines synchronously and `rename` from a promise; the LSP handler
        // wraps both, so the test does too rather than picking one shape.
        let message: string | undefined;
        try {
            await services.Jpipe.lsp.RenameProvider!.prepareRename!(user, params);
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toContain(`'lib:T:a' restates '@support a' in template 'T'`);
    });

    // A file that never loads the library cannot be talking about its template, however much its
    // own names look alike.
    test('a same-named template in an unrelated file is untouched', async () => {
        write('library.jd', LIBRARY);
        write('user.jd', USER);
        write('stranger.jd', 'template T { @support a is "A" }');
        const documents = await build('library.jd', 'user.jd', 'stranger.jd');
        const after = await renameAcross(documents, documents[0], 'template T', 'template '.length, 'Signoff');

        expect(after[uriOf('stranger.jd')]).toBe('template T { @support a is "A" }');
    });
});
