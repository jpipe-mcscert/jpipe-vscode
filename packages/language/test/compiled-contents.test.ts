import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EmptyFileSystem, URI, type LangiumDocument } from 'langium';
import { clearDocuments, parseHelper } from 'langium/test';
import { Diagnostic } from 'vscode-languageserver-types';
import type { Justification, Template, Unit } from 'jpipe-language';
import { createJpipeServices, readReport } from 'jpipe-language';
import { listedIn } from '../src/jpipe-model-contents.js';

/**
 * Contents of models built on a composition, read from the compiler's report (jpipe-vscode
 * ADR-VSC-0034, #132), and the checks they bring back (#127).
 *
 * The reports under `fixtures/compiled/` are real: `jpipe --headless diagnostic -f json -i <file>`,
 * run by jPipe 4.1.0 in that folder, with the folder's own path removed from `main.report.json`
 * so that it names `lib.jd` relatively. Their models are jpipe-compiler's examples 028 and 035,
 * with a few additions marked as such, and variations on 035 (`hooks.jd`, `recovered.jd`).
 */

const fixtures = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'fixtures', 'compiled');

let services: ReturnType<typeof createJpipeServices>;
let documents: LangiumDocument<Unit>[] = [];
let asked: string[] = [];

/**
 * What the client answers: the captured report of the file, or `null` when there is none. Not
 * before the check that asked has ended, as a compiler's run does not: these checks are built
 * outside the workspace lock, which keeps a check and the one its report brings apart.
 */
async function fromFixtures(uri: string): Promise<unknown> {
    const name = path.basename(URI.parse(uri).fsPath);
    asked.push(name);
    await new Promise(resolve => setTimeout(resolve, 0));
    const report = path.join(fixtures, name.replace(/\.jd$/, '.report.json'));
    return fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null;
}

beforeEach(() => {
    services = createJpipeServices(EmptyFileSystem);
    services.Jpipe.references.CompilerReports.connect(fromFixtures);
    asked = [];
});

afterEach(async () => {
    await services.Jpipe.references.CompilerReports.idle();
    await clearDocuments(services.shared, documents);
    documents = [];
    vi.restoreAllMocks();
});

/**
 * `name` opened and checked, as saved unless `text` says otherwise, and checked again once its
 * report has arrived, unless `waiting` says not to wait for it.
 */
async function open(name: string, { text, waiting = true }: { text?: string; waiting?: boolean } = {}): Promise<LangiumDocument<Unit>> {
    const file = path.join(fixtures, name);
    const document = await parseHelper<Unit>(services.Jpipe)(text ?? fs.readFileSync(file, 'utf8'), {
        documentUri: url.pathToFileURL(file).toString(),
        validation: true
    });
    documents.push(document);
    if (waiting) await services.Jpipe.references.CompilerReports.idle();
    return document;
}

const saved = (name: string): string => fs.readFileSync(path.join(fixtures, name), 'utf8');

/** Each error as `line:code`, lines 1-based as the compiler counts them. */
const errors = (document: LangiumDocument) => (document.diagnostics ?? [])
    .filter(d => d.severity === 1)
    .map(d => `${d.range.start.line + 1}:${d.code ?? (d.data as { code?: string } | undefined)?.code}`);

const messages = (document: LangiumDocument, code: string) => (document.diagnostics ?? [])
    .filter(d => d.code === code).map(d => Diagnostic.getMessageString(d));

const modelNamed = (document: LangiumDocument<Unit>, name: string): Justification | Template =>
    document.parseResult.value.body.find(model => model.id === name)!;

/** The ids the compiler gives `name`'s elements, in its own report of `file`. */
function compilerIds(file: string, name: string): string[] {
    const report = readReport(JSON.parse(fs.readFileSync(path.join(fixtures, file.replace(/\.jd$/, '.report.json')), 'utf8')))!;
    return report.models.find(model => model.name === name)!.symbols.map(symbol => symbol.id).sort();
}

async function editorIds(document: LangiumDocument<Unit>, name: string): Promise<string[]> {
    const contents = await services.Jpipe.references.ModelContents.contentsOf(modelNamed(document, name));
    expect(contents.kind, name).toBe('elements');
    return listedIn(contents).map(entry => entry.id).sort();
}

describe('a model built on a composition', () => {

    // The bodies below the composed template are read on top of what the compiler built for it.
    test.each([
        ['refine.jd', 'ready'],
        ['refine.jd', 'unready'],
        ['refine.jd', 'by_suffix'],
        ['main.jd', 'done'],
        ['main.jd', 'short'],
        ['main.jd', 'missing']
    ])('in %s, %s has the elements the compiler gives it', async (file, name) => {
        const document = await open(file);
        expect(await editorIds(document, name)).toEqual(compilerIds(file, name));
    });

    test('is checked as the compiler checks it', async () => {
        const document = await open('refine.jd');
        // Example 028 is clean. A hook into a composed base, through its aliases or its unified
        // ids, names an element; one that names nothing is reported, as an override left out is.
        expect(errors(document)).toEqual(['115:no-abstract-support', '129:unknown-hook']);
        expect(messages(document, 'unknown-hook')).toEqual(["Hook element 'nope' not found in base model 'all'"]);
        expect(messages(document, 'no-abstract-support')[0]).toContain("Expected element with id 'pattern:abs2'");
    });

    test('under a template of a file loaded under a namespace, as the compiler names it there', async () => {
        const document = await open('main.jd');
        // An override written by its suffix overrides, as it does in the compiler.
        expect(errors(document)).toEqual(['12:no-abstract-support']);
        expect(messages(document, 'no-abstract-support')[0]).toContain("Expected element with id 'lib:pattern:abs2'");
    });

    // #127
    test('is told an override names several @support elements, in the compiler\'s words', async () => {
        const document = await open('ambiguous.jd');
        expect(errors(document).filter(error => !error.endsWith('linking-error'))).toEqual([
            '56:ambiguous-id', '63:ambiguous-id', '69:no-abstract-support'
        ]);
        expect(messages(document, 'ambiguous-id')).toEqual([
            "ambiguous id 'top:h' in model 'twice': it names 'l:top:h', 'r:top:h'; write the qualified id",
            "ambiguous id 'top:h' in model 'once': it names 'l:top:h', 'r:top:h'; write the qualified id"
        ]);
        // Below the failed override, only the @support it did not name is missing.
        expect(messages(document, 'no-abstract-support')).toHaveLength(1);
        expect(messages(document, 'no-abstract-support')[0]).toContain("Expected element with id 'once:u'");
    });

    test('cannot tell when the compiler did not build it whole', async () => {
        const document = await open('unbuilt.jd');
        // `r` is assembled from `a`, whose relation names nothing: what the compiler built of `r`
        // is not all of it, so a hook into it is not judged.
        expect(errors(document)).toEqual(['9:linking-error']);
        const contents = await services.Jpipe.references.ModelContents.contentsOf(modelNamed(document, 'r'));
        expect(contents.kind).toBe('cannot-tell');
    });

    test('is not judged on a template whose source the compiler recovered from', async () => {
        const document = await open('recovered.jd');
        // 'l' declares a conclusion it inherits: an error, but 'l' and 'both' are built whole.
        const k = document.textDocument.getText().split('\n').findIndex(line => line.startsWith('justification k')) + 1;
        expect(errors(document)).toEqual(['14:inherited-conclusion', `${k}:no-abstract-support`, `${k}:no-abstract-support`]);
        expect(document.diagnostics!.filter(d => d.code === 'no-abstract-support').map(d => (d.data as { expectedKey: string }).expectedKey))
            .toEqual(['l:top:h', 'r:top:h']);
    });

    test('is told a hook names several elements, or an override is none, as the compiler tells it', async () => {
        const document = await open('hooks.jd');
        const twice = document.textDocument.getText().split('\n').findIndex(line => line.startsWith('justification twice')) + 1;
        expect(errors(document)).toEqual(['34:ambiguous-hook', `${twice}:no-abstract-support`, `${twice}:no-abstract-support`, '42:strategy-supported']);
        expect(messages(document, 'ambiguous-hook')).toEqual([
            "ambiguous hook 'top:h' in 'both': it names 'l:top:h', 'r:top:h'; write the qualified id"
        ]);
    });

    test('cannot tell while a file it is built from reads otherwise than saved, before it', async () => {
        const above = await open('refine.jd', { text: `// not saved\n${saved('refine.jd')}` });
        expect(errors(above)).toEqual([]);
        expect((await services.Jpipe.references.ModelContents.contentsOf(modelNamed(above, 'ready'))).kind).toBe('cannot-tell');
        await clearDocuments(services.shared, documents);
        documents = [];
        // Past the last model it is built from, an edit moves nothing the report places.
        const below = await open('refine.jd', { text: `${saved('refine.jd')}\n// not saved\n` });
        expect(errors(below)).toEqual(['115:no-abstract-support', '129:unknown-hook']);
    });

    test('does not wait for its report, and is checked again once it arrives', async () => {
        let deliver!: () => void;
        const arrived = new Promise<void>(resolve => { deliver = resolve; });
        services.Jpipe.references.CompilerReports.connect(async uri => {
            await arrived;
            return fromFixtures(uri);
        });
        const document = await open('refine.jd', { waiting: false });
        expect(errors(document)).toEqual([]);
        deliver();
        await services.Jpipe.references.CompilerReports.idle();
        expect(errors(document)).toEqual(['115:no-abstract-support', '129:unknown-hook']);
    });

    test('is judged as before when there is no compiler', async () => {
        services.Jpipe.references.CompilerReports.connect(undefined);
        expect(errors(await open('ambiguous.jd')).filter(error => !error.endsWith('linking-error'))).toEqual(['69:no-abstract-support']);
        expect(errors(await open('refine.jd'))).toEqual([]);
        expect(asked).toEqual([]);
    });
});

describe('completion on a model built on a composition', () => {

    /** The labels completion offers at `offset` in `document`. */
    async function labelsAt(document: LangiumDocument<Unit>, offset: number): Promise<string[]> {
        const position = document.textDocument.positionAt(offset);
        const list = await services.Jpipe.lsp.CompletionProvider!.getCompletion(document, {
            textDocument: { uri: document.uri.toString() }, position
        });
        return list?.items.map(item => item.label) ?? [];
    }

    test('offers the evidence the operator built as a hook', async () => {
        const document = await open('refine.jd');
        const text = document.textDocument.getText();
        // Inside `hook: "a:e"` of `through_alias`, which refines `both`, just after the quote.
        const labels = await labelsAt(document, text.indexOf('"a:e"') + 1);
        expect(labels).toContain('unified_0');
    });

    test('offers to override the @support a composed template keeps', async () => {
        const document = await open('refine.jd');
        const text = document.textDocument.getText();
        // After `unready`'s one declaration, which overrides nothing, where the next one goes.
        const labels = await labelsAt(document, text.indexOf('}', text.indexOf('evidence other is')));
        expect(labels).toContain('evidence pattern:abs2');
    });
});

describe('the compiler\'s reports', () => {

    test('are asked once for a file, however many models ask', async () => {
        const document = await open('refine.jd');
        await services.shared.workspace.DocumentBuilder.build([document], { validation: true });
        expect(asked).toEqual(['refine.jd']);
    });

    test('are asked again once a file they read is saved, and only those', async () => {
        const main = await open('main.jd');
        const refine = await open('refine.jd');
        const reports = services.Jpipe.references.CompilerReports;
        const lib = url.pathToFileURL(path.join(fixtures, 'lib.jd')).toString();
        // main.jd loads lib.jd; refine.jd does not.
        expect(reports.forget(new Set([lib]))).toEqual([main.uri.toString()]);
        reports.reportOf(main);
        reports.reportOf(refine);
        await reports.idle();
        expect(asked).toEqual(['main.jd', 'refine.jd', 'main.jd']);
        expect(reports.forget(new Set())).toEqual(expect.arrayContaining([main.uri.toString(), refine.uri.toString()]));
    });

    test('are asked again a minute after there was none', async () => {
        const reports = services.Jpipe.references.CompilerReports;
        reports.connect(async uri => {
            asked.push(path.basename(URI.parse(uri).fsPath));
            return null;
        });
        const document = await open('refine.jd');
        reports.reportOf(document);
        await reports.idle();
        expect(asked).toEqual(['refine.jd']);
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
        reports.reportOf(document);
        await reports.idle();
        expect(asked).toEqual(['refine.jd', 'refine.jd']);
    });

    test('are read whole, in the version this release knows, or not at all', () => {
        const report = JSON.parse(fs.readFileSync(path.join(fixtures, 'refine.report.json'), 'utf8'));
        expect(readReport(report)?.models.length).toBe(report.models.length);
        expect(readReport({ ...report, schemaVersion: 2 })).toBeUndefined();
        expect(readReport({ ...report, models: undefined })).toBeUndefined();
        const odd = structuredClone(report);
        odd.models[0].symbols[0].kind = 'axiom';
        expect(readReport(odd)).toBeUndefined();
        expect(readReport(null)).toBeUndefined();
    });
});
