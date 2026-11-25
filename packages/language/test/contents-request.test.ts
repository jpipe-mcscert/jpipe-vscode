import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EmptyFileSystem, URI, type LangiumDocument } from 'langium';
import { clearDocuments, parseHelper } from 'langium/test';
import type { ContentsRow, ModelContentsAnswer, Unit } from 'jpipe-language';
import { answerModelContents, createJpipeServices, modelContentsIn, readReport } from 'jpipe-language';

/**
 * A model's elements as the client's Outline and Run panel ask for them (jpipe-vscode
 * ADR-VSC-0034): `ModelContents.contentsOf`, answered as rows that say where each element is
 * declared and by which model. Listing an overridden element beside its override, a composed
 * model's elements under other ids than the compiler's, or a partial list as whole, are the
 * failures that matter.
 *
 * The reports under `fixtures/compiled/` are real ones, as `compiled-contents.test.ts` describes.
 */

const fixtures = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'fixtures', 'compiled');

let services: ReturnType<typeof createJpipeServices>;
let documents: LangiumDocument<Unit>[] = [];

async function fromFixtures(uri: string): Promise<unknown> {
    await new Promise(resolve => setTimeout(resolve, 0));
    const report = path.join(fixtures, path.basename(URI.parse(uri).fsPath).replace(/\.jd$/, '.report.json'));
    return fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null;
}

beforeEach(async () => {
    services = createJpipeServices(EmptyFileSystem);
    services.Jpipe.references.CompilerReports.connect(fromFixtures);
    // What the server does once the client says it is initialised; requests wait for it.
    await services.shared.workspace.WorkspaceManager.initializeWorkspace([]);
});

afterEach(async () => {
    await services.Jpipe.references.CompilerReports.idle();
    await clearDocuments(services.shared, documents);
    documents = [];
});

/** `text` as the file `name`, checked, and checked again once its report has arrived. */
async function open(name: string, text?: string): Promise<LangiumDocument<Unit>> {
    const file = path.join(fixtures, name);
    const document = await parseHelper<Unit>(services.Jpipe)(text ?? fs.readFileSync(file, 'utf8'), {
        documentUri: url.pathToFileURL(file).toString(),
        validation: true
    });
    documents.push(document);
    await services.Jpipe.references.CompilerReports.idle();
    return document;
}

async function contents(document: LangiumDocument, name: string): Promise<ModelContentsAnswer> {
    const answer = await modelContentsIn(services.Jpipe, document, { name });
    expect(answer, name).not.toBeNull();
    return answer!;
}

const row = (answer: ModelContentsAnswer, id: string): ContentsRow => answer.elements.find(r => r.id === id)!;

describe('a plain model', () => {

    const TEXT = `template T {
    conclusion c is "C"
    strategy s is "S"
    @support a is "A"
    a supports s
    s supports c
}

justification J implements T {
    evidence T:a is "Done"
}`;

    test('lists its own elements first, then those it inherits, an overridden one only once', async () => {
        const answer = await contents(await open('plain.jd', TEXT), 'J');
        expect(answer.complete).toBe(true);
        expect(answer.elements.map(r => r.id)).toEqual(['T:a', 'T:c', 'T:s']);
    });

    test('says which model declares each element, and where', async () => {
        const answer = await contents(await open('plain.jd', TEXT), 'J');
        expect(row(answer, 'T:a')).toMatchObject({ kind: 'evidence', label: 'Done', location: { selection: { start: { line: 9 } } } });
        expect(row(answer, 'T:a').declaredIn).toBeUndefined();
        expect(row(answer, 'T:c')).toMatchObject({ kind: 'conclusion', label: 'C', declaredIn: 'T', location: { range: { start: { line: 1 } } } });
        expect(row(answer, 'T:c').location!.uri).toBe(url.pathToFileURL(path.join(fixtures, 'plain.jd')).toString());
    });

    test('of a template keeps its @support as such', async () => {
        const answer = await contents(await open('plain.jd', TEXT), 'T');
        expect(answer.elements.map(r => `${r.kind} ${r.id}`)).toEqual(['conclusion c', 'strategy s', 'abstract-support a']);
    });

    test('is told from another model of its name by a position in its declaration', async () => {
        const document = await open('twice.jd', `justification X {
    evidence first is "First"
}
justification X {
    evidence second is "Second"
}`);
        const second = await modelContentsIn(services.Jpipe, document, { name: 'X', position: { line: 3, character: 15 } });
        expect(second!.elements.map(r => r.id)).toEqual(['second']);
        expect((await contents(document, 'X')).elements.map(r => r.id)).toEqual(['first']);
    });
});

describe('a model built on a composition', () => {

    /** The ids the compiler gives `name`'s elements in its report of `file`. */
    function compilerIds(file: string, name: string): string[] {
        const report = readReport(JSON.parse(fs.readFileSync(path.join(fixtures, file.replace(/\.jd$/, '.report.json')), 'utf8')))!;
        return report.models.find(model => model.name === name)!.symbols.map(symbol => symbol.id).sort();
    }

    test.each(['refined_pattern', 'ready', 'both'])('%s lists the elements the compiler builds, under its ids', async name => {
        const answer = await contents(await open('refine.jd'), name);
        expect(answer.complete).toBe(true);
        expect(answer.elements.map(r => r.id).sort()).toEqual(compilerIds('refine.jd', name));
    });

    test('says which model each element was built from', async () => {
        const answer = await contents(await open('refine.jd'), 'refined_pattern');
        expect(row(answer, 'pattern:c')).toMatchObject({ declaredIn: 'pattern', label: 'The system is ready', location: { range: { start: { line: 9 } } } });
        expect(row(answer, 'first_part:e')).toMatchObject({ declaredIn: 'first_part', kind: 'evidence' });
    });

    test('marks what its operator merged, and gives what it made up no declaration', async () => {
        const answer = await contents(await open('refine.jd'), 'both');
        expect(row(answer, 'unified_0')).toMatchObject({ merged: true, declaredIn: 'a' });
        expect(row(answer, 'assembleConclusion').location).toBeUndefined();
        expect(row(answer, 'assembleConclusion').label).toBeUndefined();
    });

    test('below it, still lists its own elements first', async () => {
        const answer = await contents(await open('refine.jd'), 'ready');
        expect(answer.elements[0]).toMatchObject({ id: 'pattern:abs2', kind: 'evidence', label: 'Second part checklist' });
        expect(answer.elements[0].declaredIn).toBeUndefined();
    });

    test('is not vouched for whole while its file reads otherwise than as saved', async () => {
        const answer = await contents(await open('refine.jd', `// edited\n${fs.readFileSync(path.join(fixtures, 'refine.jd'), 'utf8')}`), 'ready');
        expect(answer.complete).toBe(false);
        // What the files declare is still listed.
        expect(answer.elements.map(r => r.id)).toContain('pattern:abs2');
    });
});

describe('the request', () => {

    test('answers as the model\'s document does, once the workspace is ready', async () => {
        const document = await open('refine.jd');
        const answer = await answerModelContents(services.Jpipe, { uri: document.uri.toString(), name: 'both' });
        expect(answer).toEqual(await modelContentsIn(services.Jpipe, document, { name: 'both' }));
    });

    test('answers null for a model or a file that is not there', async () => {
        const document = await open('refine.jd');
        expect(await answerModelContents(services.Jpipe, { uri: document.uri.toString(), name: 'nope' })).toBeNull();
        expect(await answerModelContents(services.Jpipe, { uri: 'file:///nowhere/gone.jd', name: 'both' })).toBeNull();
    });
});
