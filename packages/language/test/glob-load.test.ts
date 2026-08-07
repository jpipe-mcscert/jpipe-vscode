import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument } from 'langium';
import { clearDocuments, parseHelper } from 'langium/test';
import type { Diagnostic } from 'vscode-languageserver-types';
import type { Unit } from 'jpipe-language';
import { createJpipeServices } from 'jpipe-language';

/**
 * End-to-end coverage for globbed `load` paths, mirroring the compiler's
 * `LoadResolverGlobTest` and its `examples/02*_load_glob_*.jd` fixtures. Real files on disk are
 * required: `JpipeImportService` reads through `node:fs` rather than Langium's FileSystemProvider,
 * so `EmptyFileSystem` does not intercept it.
 */
let services: ReturnType<typeof createJpipeServices>;
let parse: ReturnType<typeof parseHelper<Unit>>;
let document: LangiumDocument<Unit> | undefined;
let tmpDir: string;

beforeAll(() => {
    services = createJpipeServices(EmptyFileSystem);
    parse = parseHelper<Unit>(services.Jpipe);
});

afterEach(async () => {
    if (document) await clearDocuments(services.shared, [document]);
    document = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    // Expansions are memoised per base directory; each test builds a fresh tree.
    services.Jpipe.references.JpipeImportService.invalidateGlobCache();
});

function template(id: string): string {
    return `template ${id} {\n    conclusion c is "Claim"\n    @support abs is "Abstract"\n    abs supports c\n}\n`;
}

/** Builds the compiler's example layout: two top-level models plus one nested. */
function makeWorkspace(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-glob-'));
    fs.mkdirSync(path.join(tmpDir, 'globs', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'globs', 'model_alpha.jd'), template('alpha'));
    fs.writeFileSync(path.join(tmpDir, 'globs', 'model_beta.jd'), template('beta'));
    fs.writeFileSync(path.join(tmpDir, 'globs', 'nested', 'model_gamma.jd'), template('gamma'));
    return tmpDir;
}

function rootUri(dir: string): string {
    return pathToFileURL(path.join(dir, 'root.jd')).toString();
}

async function parseRoot(dir: string, text: string): Promise<LangiumDocument<Unit>> {
    document = await parse(text, { documentUri: rootUri(dir), validation: true });
    return document;
}

function messages(doc: LangiumDocument): string[] {
    return (doc.diagnostics ?? []).map((d: Diagnostic) => d.message);
}

/** Matched paths relative to the workspace root, `/`-separated, for readable assertions. */
function expand(dir: string, pattern: string, doc: LangiumDocument): string[] {
    return services.Jpipe.references.JpipeImportService
        .expandLoadPath(pattern, doc)
        .map(p => path.relative(dir, p).split(path.sep).join('/'));
}

describe('Glob expansion in load', () => {

    test('* matches top-level files only, in sorted order', async () => {
        const dir = makeWorkspace();
        const doc = await parseRoot(dir, 'load "globs/*.jd"\n');

        expect(expand(dir, 'globs/*.jd', doc)).toEqual([
            'globs/model_alpha.jd',
            'globs/model_beta.jd'
        ]);
    });

    test('**/* matches nested files only', async () => {
        const dir = makeWorkspace();
        const doc = await parseRoot(dir, 'load "globs/**/*.jd"\n');

        expect(expand(dir, 'globs/**/*.jd', doc)).toEqual([
            'globs/nested/model_gamma.jd'
        ]);
    });

    test('** matches every depth including the top level', async () => {
        const dir = makeWorkspace();
        const doc = await parseRoot(dir, 'load "globs/**.jd"\n');

        expect(expand(dir, 'globs/**.jd', doc)).toEqual([
            'globs/model_alpha.jd',
            'globs/model_beta.jd',
            'globs/nested/model_gamma.jd'
        ]);
    });

    test('a literal path still resolves to exactly itself', async () => {
        const dir = makeWorkspace();
        const doc = await parseRoot(dir, 'load "globs/model_alpha.jd"\n');

        expect(expand(dir, 'globs/model_alpha.jd', doc)).toEqual(['globs/model_alpha.jd']);
    });

    test('non-.jd files can match, as in the compiler', async () => {
        const dir = makeWorkspace();
        fs.writeFileSync(path.join(dir, 'globs', 'README.md'), '# not a model\n');
        const doc = await parseRoot(dir, 'load "globs/*"\n');

        expect(expand(dir, 'globs/*', doc)).toContain('globs/README.md');
    });
});

describe('Glob load diagnostics', () => {

    test('a valid pattern produces no "cannot resolve" error', async () => {
        const dir = makeWorkspace();
        const doc = await parseRoot(dir, 'load "globs/*.jd"\n');

        expect(messages(doc).some(m => m.includes('Cannot resolve load path'))).toBe(false);
        expect(messages(doc).some(m => m.includes('No file matches'))).toBe(false);
    });

    test('a pattern matching nothing is an error, worded as the compiler words it', async () => {
        const dir = makeWorkspace();
        const doc = await parseRoot(dir, 'load "globs/none_*.jd" as lib\n');

        expect(messages(doc)).toContainEqual("No file matches load pattern 'globs/none_*.jd'");
    });

    test('a malformed pattern is reported, not thrown', async () => {
        const dir = makeWorkspace();
        const doc = await parseRoot(dir, 'load "globs/[.jd" as lib\n');

        expect(messages(doc).some(m => m.startsWith("Invalid glob in load pattern 'globs/[.jd'"))).toBe(true);
    });

    test('a missing literal path keeps its original message', async () => {
        const dir = makeWorkspace();
        const doc = await parseRoot(dir, 'load "./does-not-exist.jd"\n');

        expect(messages(doc).some(m => m.includes("Cannot resolve load path './does-not-exist.jd'"))).toBe(true);
    });
});

describe('Cross-file resolution through a glob', () => {

    test('a template from a globbed file can be implemented', async () => {
        const dir = makeWorkspace();
        const doc = await parseRoot(dir,
            'load "globs/*.jd"\n' +
            'justification j implements alpha {\n    evidence alpha:abs is "Concrete"\n}\n');

        const justification = doc.parseResult.value.body[0];
        expect(justification.$type).toBe('Justification');
        expect((justification as { parent?: { ref?: { id: string } } }).parent?.ref?.id).toBe('alpha');
    });

    test('a namespaced glob puts every matched file under the one alias', async () => {
        const dir = makeWorkspace();
        const doc = await parseRoot(dir,
            'load "globs/**.jd" as lib\n' +
            'justification jg implements lib:gamma {\n    evidence lib:gamma:abs is "Concrete"\n}\n');

        const justification = doc.parseResult.value.body[0];
        expect((justification as { parent?: { ref?: { id: string } } }).parent?.ref?.id).toBe('gamma');
        expect(messages(doc).some(m => m.includes('Could not resolve'))).toBe(false);
    });
});

describe('Hover on a load path', () => {

    async function hoverAt(doc: LangiumDocument<Unit>, text: string, needle: string): Promise<string | undefined> {
        const offset = text.indexOf(needle);
        const position = doc.textDocument.positionAt(offset);
        const hover = await services.Jpipe.lsp.HoverProvider!.getHoverContent(doc, {
            textDocument: { uri: doc.textDocument.uri },
            position
        });
        const contents = hover?.contents as { value?: string } | undefined;
        return contents?.value;
    }

    test('lists every matched file as a link', async () => {
        const dir = makeWorkspace();
        const text = 'load "globs/**.jd" as lib\n';
        const doc = await parseRoot(dir, text);

        const value = await hoverAt(doc, text, '**');
        expect(value).toContain('**3 files** match');
        expect(value).toContain('[globs/model_alpha.jd](file://');
        expect(value).toContain('[globs/model_beta.jd](file://');
        expect(value).toContain('[globs/nested/model_gamma.jd](file://');
    });

    test('distinguishes ** from **/*, proving Java semantics rather than minimatch', async () => {
        const dir = makeWorkspace();
        const text = 'load "globs/**/*.jd" as lib\n';
        const doc = await parseRoot(dir, text);

        const value = await hoverAt(doc, text, '**');
        expect(value).toContain('**1 file** match');
        expect(value).toContain('globs/nested/model_gamma.jd');
        expect(value).not.toContain('model_alpha.jd');
    });

    test('reports a pattern that matches nothing', async () => {
        const dir = makeWorkspace();
        const text = 'load "globs/none_*.jd"\n';
        const doc = await parseRoot(dir, text);

        expect(await hoverAt(doc, text, 'none_')).toBe('No file matches `globs/none_*.jd`');
    });

    test('shows where a literal path resolved', async () => {
        const dir = makeWorkspace();
        const text = 'load "globs/model_alpha.jd"\n';
        const doc = await parseRoot(dir, text);

        const value = await hoverAt(doc, text, 'model_alpha');
        expect(value).toContain('Resolves to [globs/model_alpha.jd](file://');
    });
});

describe('Go-to-definition and globs', () => {

    async function definitionAt(doc: LangiumDocument<Unit>, text: string, needle: string) {
        const offset = text.indexOf(needle);
        return services.Jpipe.lsp.DefinitionProvider!.getDefinition(doc, {
            textDocument: { uri: doc.textDocument.uri },
            position: doc.textDocument.positionAt(offset)
        });
    }

    // Go-to-definition answers "which file is this", which a pattern cannot answer; the hover
    // carries the match list instead. This pairs with the literal-path test below so the
    // asymmetry is deliberate and stays that way.
    test('a glob path offers no definition', async () => {
        const dir = makeWorkspace();
        const text = 'load "globs/*.jd"\n';
        const doc = await parseRoot(dir, text);

        const result = await definitionAt(doc, text, 'globs/*');
        expect(result === undefined || result.length === 0).toBe(true);
    });

    test('a literal path still jumps to its file', async () => {
        const dir = makeWorkspace();
        const text = 'load "globs/model_alpha.jd"\n';
        const doc = await parseRoot(dir, text);

        const result = await definitionAt(doc, text, 'model_alpha');
        expect(result).toHaveLength(1);
    });
});
