/**
 * The actions that consult the workspace rather than the open file.
 *
 * Two things make these different from the single-file cases. `JpipeImportService` reads through
 * `node:fs` rather than Langium's `FileSystemProvider`, so `EmptyFileSystem` does not intercept it
 * and the fixtures have to be real files on disk. And an action that asks `IndexManager` what the
 * workspace contains needs the workspace **built**, not merely parsed — without the build the
 * index is empty, the action returns nothing, and a test asserting "not offered here" passes for
 * entirely the wrong reason. The first case below pins that, so the harness cannot rot into
 * vacuous success.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { URI, type LangiumDocument } from 'langium';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CodeAction } from 'vscode-languageserver';
import { Justification as JustificationRule, createJpipeServices, type Unit } from 'jpipe-language';

let workspace: string;
let services: ReturnType<typeof createJpipeServices>;

beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-code-actions-'));
    services = createJpipeServices(NodeFileSystem);
});

afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
});

/** Writes a file under the temp workspace, creating directories as needed. */
function write(relative: string, content: string): string {
    const full = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
}

/**
 * Loads every written file into the workspace and builds it, so `IndexManager` is populated and
 * validation has run.
 */
async function build(...relatives: string[]): Promise<LangiumDocument<Unit>[]> {
    const documents = await Promise.all(relatives.map(async relative => {
        const uri = URI.parse(pathToFileURL(path.join(workspace, relative)).toString());
        return await services.shared.workspace.LangiumDocuments.getOrCreateDocument(uri) as LangiumDocument<Unit>;
    }));
    await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
    return documents;
}

async function actionsFor(document: LangiumDocument<Unit>): Promise<CodeAction[]> {
    const produced = await services.Jpipe.lsp.CodeActionProvider!.getCodeActions(document, {
        textDocument: { uri: document.uri.toString() },
        range: {
            start: document.textDocument.positionAt(0),
            end: document.textDocument.positionAt(document.textDocument.getText().length)
        },
        context: { diagnostics: document.diagnostics ?? [] }
    });
    return (produced ?? []).filter((action): action is CodeAction => 'title' in action);
}

async function titlesFor(document: LangiumDocument<Unit>): Promise<string[]> {
    return (await actionsFor(document)).map(action => action.title);
}

/** Applies the single action with the given title and returns the resulting text. */
async function apply(document: LangiumDocument<Unit>, title: string): Promise<string> {
    const actions = await actionsFor(document);
    const found = actions.filter(action => action.title === title);
    if (found.length !== 1) {
        expect.fail(`expected exactly one action titled '${title}'; offered: ${actions.map(a => `'${a.title}'`).join(', ') || '(none)'}`);
    }
    const edits = found[0].edit?.changes?.[document.uri.toString()] ?? [];
    return TextDocument.applyEdits(document.textDocument, edits);
}

const COMPLETE = (id: string) => `justification ${id} {
    conclusion c is "A claim"
    strategy s is "A strategy"
    evidence e is "Some evidence"
    e supports s
    s supports c
}`;

const TEMPLATE = `template Base {
    @support a is "An abstract support"
    conclusion c is "A claim"
    strategy s is "A strategy"
    a supports s
    s supports c
}`;

describe('the multi-file harness itself', () => {

    // If this fails, every "offered" assertion below would still pass while asserting nothing.
    test('building the workspace populates the index the actions read', async () => {
        write('lib/base.jd', COMPLETE('Base'));
        write('main.jd', COMPLETE('Main'));
        await build('lib/base.jd', 'main.jd');

        const names = services.shared.workspace.IndexManager
            .allElements(JustificationRule.$type).toArray().map(d => d.name);
        expect(names).toContain('Base');
        expect(names).toContain('Main');
    });
});

describe('add-missing-load', () => {

    test('offers the file defining a template that is referenced but not loaded', async () => {
        write('lib/base.jd', TEMPLATE);
        write('main.jd', `justification J implements Base {
    evidence Base:a is "An abstract support"
}`);
        const [, main] = await build('lib/base.jd', 'main.jd');

        expect(await titlesFor(main)).toContain("Load './lib/base.jd' and use 'Base'");
    });

    test('inserts the load above the first declaration', async () => {
        write('lib/base.jd', TEMPLATE);
        write('main.jd', `justification J implements Base {
    evidence Base:a is "An abstract support"
}`);
        const [, main] = await build('lib/base.jd', 'main.jd');

        const after = await apply(main, "Load './lib/base.jd' and use 'Base'");
        expect(after.startsWith('load "./lib/base.jd"\n\njustification J')).toBe(true);
    });

    // The banner-comment case, on a real file rather than a synthetic document.
    test('inserts the load below a banner comment', async () => {
        write('lib/base.jd', TEMPLATE);
        write('main.jd', `/*
 * A model with a header.
 */
justification J implements Base {
    evidence Base:a is "An abstract support"
}`);
        const [, main] = await build('lib/base.jd', 'main.jd');

        const after = await apply(main, "Load './lib/base.jd' and use 'Base'");
        expect(after.startsWith('/*\n * A model with a header.\n */\nload "./lib/base.jd"')).toBe(true);
    });

    test('is not offered once the file is loaded', async () => {
        write('lib/base.jd', TEMPLATE);
        write('main.jd', `load "./lib/base.jd"
justification J implements Base {
    evidence Base:a is "An abstract support"
}`);
        const [, main] = await build('lib/base.jd', 'main.jd');

        expect(await titlesFor(main)).not.toContain("Load './lib/base.jd' and use 'Base'");
    });

    test('resolves the reference it was offered for', async () => {
        write('lib/base.jd', TEMPLATE);
        write('main.jd', `justification J implements Base {
    evidence Base:a is "An abstract support"
}`);
        const [, main] = await build('lib/base.jd', 'main.jd');
        const after = await apply(main, "Load './lib/base.jd' and use 'Base'");

        fs.writeFileSync(path.join(workspace, 'main.jd'), after);
        const rebuilt = createJpipeServices(NodeFileSystem);
        const uri = URI.parse(pathToFileURL(path.join(workspace, 'main.jd')).toString());
        const document = await rebuilt.shared.workspace.LangiumDocuments.getOrCreateDocument(uri);
        await rebuilt.shared.workspace.DocumentBuilder.build([document], { validation: true });

        const unresolved = (document.diagnostics ?? [])
            .filter(d => (d.data as { code?: string } | undefined)?.code === 'linking-error');
        expect(unresolved).toEqual([]);
    });

    test('names every file that could supply the reference', async () => {
        write('lib/base.jd', TEMPLATE);
        write('other/base.jd', TEMPLATE);
        write('main.jd', `justification J implements Base {
    evidence Base:a is "An abstract support"
}`);
        const [, , main] = await build('lib/base.jd', 'other/base.jd', 'main.jd');

        const titles = await titlesFor(main);
        expect(titles).toContain("Load './lib/base.jd' and use 'Base'");
        expect(titles).toContain("Load './other/base.jd' and use 'Base'");
    });
});

describe('fix-load-path', () => {

    test('offers the file whose name matches a load that resolves to nothing', async () => {
        write('lib/base.jd', COMPLETE('Base'));
        write('main.jd', `load "base.jd"\n${COMPLETE('Main')}`);
        const [, main] = await build('lib/base.jd', 'main.jd');

        expect(await titlesFor(main)).toContain("Change to './lib/base.jd'");
    });

    test('replaces the path inside its quotes and resolves the load', async () => {
        write('lib/base.jd', COMPLETE('Base'));
        write('main.jd', `load "base.jd"\n${COMPLETE('Main')}`);
        const [, main] = await build('lib/base.jd', 'main.jd');

        const after = await apply(main, "Change to './lib/base.jd'");
        expect(after.startsWith('load "./lib/base.jd"')).toBe(true);
    });

    test('offers a near-miss as well as an exact name', async () => {
        write('lib/quality.jd', COMPLETE('Quality'));
        write('main.jd', `load "qualiti.jd"\n${COMPLETE('Main')}`);
        const [, main] = await build('lib/quality.jd', 'main.jd');

        expect(await titlesFor(main)).toContain("Change to './lib/quality.jd'");
    });

    test('offers nothing resembling the path when no file is close', async () => {
        write('lib/completely-different.jd', COMPLETE('Other'));
        write('main.jd', `load "base.jd"\n${COMPLETE('Main')}`);
        const [, main] = await build('lib/completely-different.jd', 'main.jd');

        expect(await titlesFor(main)).not.toContain("Change to './lib/completely-different.jd'");
    });

    test('still offers removal when nothing can be suggested', async () => {
        write('main.jd', `load "base.jd"\n${COMPLETE('Main')}`);
        const [main] = await build('main.jd');

        expect(await titlesFor(main)).toContain("Remove load 'base.jd'");
    });

    test('does not offer a path the file already loads', async () => {
        write('lib/base.jd', COMPLETE('Base'));
        write('main.jd', `load "./lib/base.jd"\nload "base.jd"\n${COMPLETE('Main')}`);
        const [, main] = await build('lib/base.jd', 'main.jd');

        expect(await titlesFor(main)).not.toContain("Change to './lib/base.jd'");
    });
});
