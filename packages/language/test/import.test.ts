import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, URI, type LangiumDocument } from 'langium';
import { clearDocuments, parseHelper } from 'langium/test';
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

    test('is identity-preserving for POSIX paths and accepts URI objects', () => {
        const posixUri = 'file:///home/foo/model.jd';
        expect(fsPathOf(posixUri)).toBe('/home/foo/model.jd');
        expect(fsPathOf(posixUri)).toBe(URI.parse(posixUri).path);
        expect(fsPathOf(URI.parse(posixUri))).toBe('/home/foo/model.jd');
    });
});
