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
