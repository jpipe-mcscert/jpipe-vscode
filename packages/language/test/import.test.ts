import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, URI, type LangiumDocument } from 'langium';
import { clearDocuments, parseHelper } from 'langium/test';
import { Diagnostic, type LocationLink } from 'vscode-languageserver-types';
import type { Unit } from 'jpipe-language';
import { createJpipeServices, isUnit, isJustification, isTemplate } from 'jpipe-language';
import { fsPathOf } from '../src/jpipe-utils.js';

let services: ReturnType<typeof createJpipeServices>;
let parse: ReturnType<typeof parseHelper<Unit>>;
let document: LangiumDocument<Unit> | undefined;

beforeAll(async () => {
    services = createJpipeServices(EmptyFileSystem);
    parse = parseHelper<Unit>(services.Jpipe);
});

function diagnosticMessages(doc: LangiumDocument): string[] {
    return (doc.diagnostics ?? []).map((d: Diagnostic) => Diagnostic.getMessageString(d));
}

afterEach(async () => {
    if (document) await clearDocuments(services.shared, [document]);
    document = undefined;
});

// ---------------------------------------------------------------------------
// A loaded file that is not open is parsed from disk. Every lookup must get the
// same parse, or the nodes of one are not found among the nodes of another and
// references through a `load … as` alias stop resolving (#37). Only the loading
// file is built here, which is the configuration the bug needed.
// ---------------------------------------------------------------------------

describe('A loaded file that is not open', () => {

    const LIBRARY = `template T {
 @support a is "A"
 strategy s is "S"
 conclusion c is "C"
 a supports s
 s supports c
}`;

    test('resolves references through its alias into an inherited template', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-import-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'library.jd'), LIBRARY);
            document = await parse(`load "./library.jd" as lib

justification J implements lib:T {
 evidence lib:T:a is "Signed off"
 lib:T:a supports lib:T:s
}`, { documentUri: pathToFileURL(path.join(tmpDir, 'user.jd')).toString(), validation: true });

            expect(diagnosticMessages(document)).toEqual([]);
            const relation = document.parseResult.value.body.find(isJustification)?.contents?.rels[0];
            expect(relation?.to?.ref?.$type).toBe('Strategy');
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });

    // A closed file between the loading file and the template it implements: its own references
    // must follow the template when it changes, while its nodes stay the ones others point at.
    test('follows a change to the file it loads in turn', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-import-'));
        try {
            const basePath = path.join(tmpDir, 'base.jd');
            fs.writeFileSync(basePath, 'template B {\n conclusion c is "C"\n strategy s is "S"\n @support a is "A"\n a supports s\n s supports c\n}');
            fs.writeFileSync(path.join(tmpDir, 'middle.jd'), 'load "./base.jd"\ntemplate M implements B { @support m is "M" }');
            document = await parse('load "./middle.jd"\njustification J implements M { evidence B:a is "A" evidence M:m is "M" }',
                { documentUri: pathToFileURL(path.join(tmpDir, 'user.jd')).toString() });
            const middle = document.parseResult.value.body.find(isJustification)?.parent?.ref;
            const idsOfBase = () => (middle?.parent?.ref?.contents?.body ?? []).map(e => e.id?.parts.join(':'));
            expect(idsOfBase()).toEqual(['c', 's', 'a']);

            fs.writeFileSync(basePath, 'template B {\n conclusion c is "C"\n strategy s is "S"\n @support a is "A"\n @support extra is "X"\n a supports s\n extra supports s\n s supports c\n}');
            const later = new Date(Date.now() + 10_000);
            fs.utimesSync(basePath, later, later);
            await services.shared.workspace.DocumentBuilder.update([], []);

            // The same middle node, now pointing at the base as it is on disk.
            expect(document.parseResult.value.body.find(isJustification)?.parent?.ref).toBe(middle);
            expect(idsOfBase()).toEqual(['c', 's', 'a', 'extra']);
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });

    test('is parsed once for each version of it on disk', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-import-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'library.jd'), LIBRARY);
            document = await parse('load "./library.jd"\njustification J implements T { evidence T:a is "A" }',
                { documentUri: pathToFileURL(path.join(tmpDir, 'user.jd')).toString() });
            const importService = services.Jpipe.references.JpipeImportService;

            const first = importService.parseDocumentFromPath('./library.jd', document);
            expect(importService.parseDocumentFromPath('./library.jd', document)).toBe(first);

            // An edit elsewhere in the workspace leaves the parse alone: documents that are not
            // relinked still hold references into it.
            importService.invalidateGlobCache();
            expect(importService.parseDocumentFromPath('./library.jd', document)).toBe(first);

            // A change on disk, made outside the editor, is read.
            const libraryPath = path.join(tmpDir, 'library.jd');
            fs.writeFileSync(libraryPath, LIBRARY.replace('"S"', '"Changed"'));
            const later = new Date(Date.now() + 10_000);
            fs.utimesSync(libraryPath, later, later);
            const reread = importService.parseDocumentFromPath('./library.jd', document);
            expect(reread).toBeDefined();
            expect(reread).not.toBe(first);
            expect(reread!.textDocument.getText()).toContain('"Changed"');
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });
});

// ---------------------------------------------------------------------------
// Relative import resolution — exercises the `relativeToDoc` branch of
// JpipeImportService.parseDocumentFromPath, the exact code path that was
// malformed on Windows. Runs green on POSIX before and after the fix, so it
// doubles as a no-regression guard for the whole `load` mechanism.
// ---------------------------------------------------------------------------

describe('Relative import resolution', () => {

    test('resolves a sibling file loaded with a relative path and links across files', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-import-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'base.jd'), `
                template T {
                    conclusion c is "Claim"
                    @support abs is "Abstract"
                    abs supports c
                }
            `);
            const rootPath = path.join(tmpDir, 'root.jd');
            document = await parse(`
                load "./base.jd"
                justification J implements T {
                    conclusion c is "Claim"
                    evidence abs is "Concrete"
                    abs supports c
                }
            `, { documentUri: pathToFileURL(rootPath).toString() });

            // Direct test of the relative-resolution branch (the Windows bug site):
            // resolve "./base.jd" relative to the root document's own URI.
            const importService = services.Jpipe.references.JpipeImportService;
            const baseDoc = importService.parseDocumentFromPath('./base.jd', document);
            expect(baseDoc).toBeDefined();
            expect(baseDoc!.parseResult.parserErrors).toHaveLength(0);
            const baseUnit = baseDoc!.parseResult.value as Unit;
            expect(isUnit(baseUnit)).toBe(true);
            expect(baseUnit.body.some(b => isTemplate(b) && b.id === 'T')).toBe(true);

            // End-to-end: the cross-file `implements` reference actually links.
            const j = document.parseResult.value?.body.find(isJustification);
            expect(j).toBeDefined();
            expect(j!.parent?.ref?.id).toBe('T');
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });
});

// ---------------------------------------------------------------------------
// fsPathOf — locks in the URI.path -> URI.fsPath fix. Node's `path` defaults to
// the host OS, so we assert against path.win32 explicitly to model Windows
// behaviour on any platform.
// ---------------------------------------------------------------------------

describe('fsPathOf (Windows path safety)', () => {

    const winUri = 'file:///c:/proj/model.jd';

    test('drops the leading-slash-before-drive that URI.path keeps', () => {
        // The bug: URI.path yields "/c:/proj/model.jd" (leading slash + drive letter).
        expect(URI.parse(winUri).path).toBe('/c:/proj/model.jd');
        // The fix: URI.fsPath yields a native, drive-rooted path (no leading slash).
        const p = fsPathOf(winUri).replaceAll('\\', '/');
        expect(/^\/[a-zA-Z]:/.test(p)).toBe(false);
        expect(p).toBe('c:/proj/model.jd');
    });

    test('win32 path resolution is broken from URI.path but valid from fsPath', () => {
        // This is precisely what parseDocumentFromPath does on Windows.
        const fromPath = URI.parse(winUri).path;            // buggy input
        const fromFsPath = fsPathOf(winUri).replaceAll('\\', '/'); // fixed input

        // From the buggy value, resolution produces a bogus root-relative path
        // (leading backslash, no drive), so fs.existsSync fails -> "import not found".
        expect(path.win32.resolve(path.win32.dirname(fromPath), './base.jd'))
            .toBe('\\c:\\proj\\base.jd');
        // From the fixed value, resolution produces a valid drive-rooted path.
        expect(path.win32.resolve(path.win32.dirname(fromFsPath), './base.jd'))
            .toBe('c:\\proj\\base.jd');
    });

    test('preserves POSIX-style URI paths (modulo separators) and accepts URI objects', () => {
        // A drive-letter-free URI has no leading-slash quirk to strip; fsPath keeps
        // the same segments. Normalize separators so this holds on Windows too
        // (where fsPath uses backslashes).
        const posixUri = 'file:///home/foo/model.jd';
        const norm = (p: string) => p.replaceAll('\\', '/');
        expect(norm(fsPathOf(posixUri))).toBe('/home/foo/model.jd');
        expect(norm(fsPathOf(URI.parse(posixUri)))).toBe('/home/foo/model.jd');
    });
});

// ---------------------------------------------------------------------------
// Load-path validation — a `load` pointing at a missing file must surface a
// diagnostic instead of failing silently (only a server-log warning before).
// ---------------------------------------------------------------------------

describe('Load path validation', () => {

    const parseWithValidation = (text: string, documentUri: string) =>
        parseHelper<Unit>(services.Jpipe)(text, { validation: true, documentUri });

    test('unresolvable load path reports an error diagnostic', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-import-'));
        try {
            const rootUri = pathToFileURL(path.join(tmpDir, 'root.jd')).toString();
            document = await parseWithValidation(`
                load "./does-not-exist.jd"
                justification J {
                    conclusion c is "Claim"
                    strategy s is "Strategy"
                    evidence e is "Evidence"
                    e supports s
                    s supports c
                }
            `, rootUri);
            expect(diagnosticMessages(document).some(m => m.includes('Cannot resolve load path'))).toBe(true);
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });

    test('resolvable load path produces no load diagnostic', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-import-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'base.jd'), `
                template T {
                    conclusion c is "Claim"
                    @support abs is "Abstract"
                    abs supports c
                }
            `);
            const rootUri = pathToFileURL(path.join(tmpDir, 'root.jd')).toString();
            document = await parseWithValidation(`
                load "./base.jd"
                justification J implements T {
                    conclusion c is "Claim"
                    evidence abs is "Concrete"
                    abs supports c
                }
            `, rootUri);
            expect(diagnosticMessages(document).some(m => m.includes('Cannot resolve load path'))).toBe(false);
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });
});

// ---------------------------------------------------------------------------
// Go-to-definition on a `load` path — the cursor on the path string should
// navigate to the loaded file.
// ---------------------------------------------------------------------------

describe('Go-to-definition on load path', () => {

    test('navigates from a load path to the loaded document', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-import-'));
        try {
            const basePath = path.join(tmpDir, 'base.jd');
            fs.writeFileSync(basePath, `
                template T {
                    conclusion c is "Claim"
                    @support abs is "Abstract"
                    abs supports c
                }
            `);
            const rootUri = pathToFileURL(path.join(tmpDir, 'root.jd')).toString();
            const text = `load "./base.jd"\njustification J implements T {\n    conclusion c is "Claim"\n    evidence abs is "Concrete"\n    abs supports c\n}`;
            document = await parse(text, { documentUri: rootUri });

            // Cursor inside the "./base.jd" string on line 0.
            const character = text.indexOf('base.jd');
            const defProvider = services.Jpipe.lsp.DefinitionProvider!;
            const result = await defProvider.getDefinition(document, {
                textDocument: { uri: rootUri },
                position: { line: 0, character }
            });

            expect(result).toBeDefined();
            expect(result!.length).toBeGreaterThan(0);
            const targetUri = (result![0] as LocationLink).targetUri;
            const norm = (p: string) => fsPathOf(p).replaceAll('\\', '/');
            expect(norm(targetUri)).toBe(norm(pathToFileURL(basePath).toString()));
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });
});

// ---------------------------------------------------------------------------
// #122. The compiler compares the models of every file it reads to build one, in the order it
// reads them: a loaded file's models count where its `load` is. Each expectation is what
// jpipe-compiler 4.0.0 printed for the same files.
// ---------------------------------------------------------------------------

describe('A model named like one in a loaded file', () => {

    const J = (name: string) => `justification ${name} { conclusion c is "C" strategy s is "S" evidence e is "E" s supports c e supports s }`;
    const T = 'template T { conclusion c is "C" strategy s is "S" @support e is "E" s supports c e supports s }';

    let tmpDir: string;

    const build = async (files: Record<string, string>, main: string) => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-duplicates-'));
        for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(tmpDir, name), text);
        document = await parse(main, { documentUri: pathToFileURL(path.join(tmpDir, 'main.jd')).toString(), validation: true });
        return (document.diagnostics ?? [])
            .filter(d => (d.data as { code?: string } | undefined)?.code === 'duplicate-model')
            .map(d => ({ line: d.range.start.line, message: Diagnostic.getMessageString(d) }));
    };

    afterEach(() => {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('is flagged after the load, pointing at the loaded one', async () => {
        expect(await build({ 'lib.jd': `\n${T}` }, `load "lib.jd"\n${J('T')}`))
            .toEqual([{ line: 1, message: "Model 'T' is already declared at lib.jd:2" }]);
    });

    test('is flagged through a file the loaded one loads', async () => {
        const files = { 'lib.jd': `\n${T}`, 'mid.jd': `load "lib.jd"\n${J('M')}` };
        expect(await build(files, `load "mid.jd"\n${J('T')}`))
            .toEqual([{ line: 1, message: "Model 'T' is already declared at lib.jd:2" }]);
    });

    // The compiler underlines the loaded file; this file's build fails because of it.
    test('declared before the load, it is the loaded one that is flagged, on the load', async () => {
        expect(await build({ 'lib.jd': `\n${T}` }, `${J('T')}\nload "lib.jd"`))
            .toEqual([{ line: 1, message: "Model 'T' in lib.jd:2 is already declared at main.jd:1" }]);
    });

    test('in two loaded files, the later one is flagged on its load', async () => {
        expect(await build({ 'lib.jd': `\n${T}`, 'lib2.jd': T }, `load "lib.jd"\nload "lib2.jd"\n${J('K')}`))
            .toEqual([{ line: 1, message: "Model 'T' in lib2.jd:1 is already declared at lib.jd:2" }]);
    });

    test('loaded under a namespace, it has another name', async () => {
        expect(await build({ 'lib.jd': `\n${T}` }, `load "lib.jd" as x\n${J('T')}`)).toEqual([]);
    });

    test('under one namespace twice, including through a file loaded under it, it clashes', async () => {
        const files = { 'lib.jd': `\n${T}`, 'lib2.jd': T, 'mid.jd': `load "lib.jd"\n${J('Q')}` };
        expect(await build(files, `load "mid.jd" as m\nload "lib2.jd" as m\n${J('K')}`))
            .toEqual([{ line: 1, message: "Model 'm:T' in lib2.jd:1 is already declared at lib.jd:2" }]);
    });

    // compiler 4.0.0 reads a file again under another namespace: lib.jd, flat here, is read once
    // more inside `m` through mid.jd, and its `m:T` clashes with lib2.jd's.
    test('in a file read again under another namespace, it clashes there', async () => {
        const files = { 'lib.jd': `\n${T}`, 'lib2.jd': T, 'mid.jd': `load "lib.jd"\n${J('Q')}` };
        expect(await build(files, `load "lib.jd"\nload "mid.jd" as m\nload "lib2.jd" as m\n${J('K')}`))
            .toEqual([{ line: 2, message: "Model 'm:T' in lib2.jd:1 is already declared at lib.jd:2" }]);
    });

    test('a file reached through a link is the same file', async () => {
        const files = { 'lib.jd': `\n${T}` };
        const main = `load "lib.jd"\nload "link/lib.jd"\n${J('K')}`;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-duplicates-'));
        for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(tmpDir, name), text);
        try {
            fs.symlinkSync(tmpDir, path.join(tmpDir, 'link'), 'dir');
        } catch {
            return; // a platform that refuses links without privileges, such as Windows
        }
        document = await parse(main, { documentUri: pathToFileURL(path.join(tmpDir, 'main.jd')).toString(), validation: true });
        expect((document.diagnostics ?? []).filter(d => (d.data as { code?: string } | undefined)?.code === 'duplicate-model')).toEqual([]);
    });

    // Two models from one declaration, through two namespaces: not one model given twice.
    test('two namespaces over one file give an operator two distinct sources', async () => {
        await build({ 'lib.jd': J('b') }, 'load "lib.jd" as x\nload "lib.jd" as y\ntemplate j is assemble(x:b, y:b) { conclusionLabel: "X" strategyLabel: "Y" }');
        expect((document?.diagnostics ?? []).filter(d => (d.data as { code?: string } | undefined)?.code === 'duplicate-source')).toEqual([]);
    });

    // Langium checks an unchanged document again only when a reference reaches into a changed
    // one, and a `load` is a path: what the loaded files declare would otherwise go stale.
    test('the loading file is checked again when a file it loads changes', async () => {
        const files = { 'lib.jd': `\n${T}`, 'mid.jd': `load "lib.jd"\n${J('M')}`, 'other.jd': J('O') };
        await build(files, `load "mid.jd"\n${J('K')}`);
        const builder = services.shared.workspace.DocumentBuilder as unknown as {
            shouldRelink(document: LangiumDocument, changed: Set<string>): boolean
        };
        const uriOf = (name: string) => URI.file(path.join(tmpDir, name)).toString();
        expect(builder.shouldRelink(document!, new Set([uriOf('lib.jd')]))).toBe(true);
        expect(builder.shouldRelink(document!, new Set([uriOf('other.jd')]))).toBe(false);
    });

    // a.jd loads b.jd as x, which loads a.jd as y: a new namespace at each turn.
    test('a cyclic load under namespaces ends', async () => {
        const files = { 'a.jd': `load "b.jd" as x\n${J('A')}`, 'b.jd': `load "a.jd" as y\n${J('B')}` };
        expect(await build(files, `load "a.jd"\n${J('K')}`)).toEqual([]);
        // Without a stop, the walk read a.jd and b.jd again under x:y, x:y:x, … until the stack
        // overflowed inside load resolution, which swallows it.
        const names = services.Jpipe.references.JpipeImportService
            .modelDeclarations(document!.parseResult.value, document!).map(declaration => declaration.name);
        expect(names).toEqual(['x:B', 'A', 'K']);
    });

    test('the loading file is checked again when a file it loads is deleted, or one its pattern matches is added', async () => {
        const files = { 'lib.jd': `\n${T}`, 'mid.jd': `load "lib.jd"\n${J('M')}`, 'models/a.jd': J('A') };
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-duplicates-'));
        fs.mkdirSync(path.join(tmpDir, 'models'));
        for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(tmpDir, name), text);
        document = await parse(`load "mid.jd"\nload "models/*.jd"\n${J('K')}`,
            { documentUri: pathToFileURL(path.join(tmpDir, 'main.jd')).toString() });
        const builder = services.shared.workspace.DocumentBuilder as unknown as {
            shouldRelink(document: LangiumDocument, changed: Set<string>): boolean
        };
        const uriOf = (name: string) => URI.file(path.join(tmpDir, name)).toString();
        fs.rmSync(path.join(tmpDir, 'lib.jd'));
        expect(builder.shouldRelink(document, new Set([uriOf('lib.jd')]))).toBe(true);
        expect(builder.shouldRelink(document, new Set([uriOf('models/new.jd')]))).toBe(true);
        expect(builder.shouldRelink(document, new Set([uriOf('elsewhere/new.jd')]))).toBe(false);
    });

    // While a header is being typed, the model has no name yet.
    test('two models with no name yet do not clash', async () => {
        expect(await build({ 'lib.jd': 'justification ' }, 'load "lib.jd"\ntemplate ')).toEqual([]);
    });

    // A case-insensitive disk: the load says `Lib.jd`, the deleted file is reported as `lib.jd`.
    test.runIf(process.platform === 'darwin' || process.platform === 'win32')(
        'the loading file is checked again when a file it loads under another case is deleted', async () => {
            await build({ 'lib.jd': `\n${T}` }, `load "Lib.jd"\n${J('K')}`);
            const builder = services.shared.workspace.DocumentBuilder as unknown as {
                shouldRelink(document: LangiumDocument, changed: Set<string>): boolean
            };
            fs.rmSync(path.join(tmpDir, 'lib.jd'));
            expect(builder.shouldRelink(document!, new Set([URI.file(path.join(tmpDir, 'lib.jd')).toString()]))).toBe(true);
        });

    test('in a file two others load, it is read once', async () => {
        const files = { 'lib.jd': `\n${T}`, 'a.jd': `load "lib.jd"\n${J('A')}`, 'b.jd': `load "lib.jd"\n${J('B')}` };
        expect(await build(files, `load "a.jd"\nload "b.jd"\n${J('K')}`)).toEqual([]);
    });
});
