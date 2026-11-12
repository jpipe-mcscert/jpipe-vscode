/**
 * Compositions as a call hierarchy: a composed model calls its operands.
 *
 * The cases that matter are the ones that would put the wrong models in the Models view's
 * Compositions group: a written model mistaken for a composition, an operand in another file
 * missed, operands out of order, or `implements` mistaken for a call.
 *
 * Real files, all built, for the reason given in `renaming-multifile.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { URI, type LangiumDocument } from 'langium';
import { SymbolKind, type CallHierarchyItem } from 'vscode-languageserver';
import { createJpipeServices, type Unit } from 'jpipe-language';

let workspace: string;
let services: ReturnType<typeof createJpipeServices>;

beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-calls-'));
    services = createJpipeServices(NodeFileSystem);
});

afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
});

function uriOf(relative: string): string {
    return URI.parse(pathToFileURL(path.join(workspace, relative)).toString()).toString();
}

async function build(files: Record<string, string>): Promise<Record<string, LangiumDocument<Unit>>> {
    for (const [relative, content] of Object.entries(files)) {
        const full = path.join(workspace, relative);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    const documents: Record<string, LangiumDocument<Unit>> = {};
    for (const relative of Object.keys(files)) {
        documents[relative] = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
            URI.parse(uriOf(relative))) as LangiumDocument<Unit>;
    }
    await services.shared.workspace.DocumentBuilder.build(Object.values(documents), { validation: true });
    return documents;
}

const provider = () => services.Jpipe.lsp.CallHierarchyProvider!;

async function only(document: LangiumDocument<Unit>, needle: string): Promise<CallHierarchyItem> {
    const index = document.textDocument.getText().indexOf(needle);
    expect(index, `fixture does not contain '${needle}'`).toBeGreaterThanOrEqual(0);
    const items = await provider().prepareCallHierarchy(document, {
        textDocument: { uri: document.uri.toString() },
        position: document.textDocument.positionAt(index)
    });
    expect(items).toHaveLength(1);
    return items![0];
}

const PARTS = `
justification Build {
    evidence e is "Compiled"
    strategy s is "Check"
    conclusion c is "Builds"
    e supports s
    s supports c
}
justification Tests {
    evidence e is "Green"
    strategy s is "Check"
    conclusion c is "Tested"
    e supports s
    s supports c
}
template Signoff {
    @support review is "Reviewed"
    strategy s is "Check"
    conclusion c is "Approved"
    review supports s
    s supports c
}
`;

describe('preparing', () => {

    test('a composition carries its operator as detail', async () => {
        const docs = await build({
            'parts.jd': PARTS,
            'app.jd': 'load "parts.jd"\njustification Release is assemble(Tests, Build) { conclusionLabel: "Ready" strategyLabel: "All" }\n'
        });
        const release = await only(docs['app.jd'], 'Release');
        expect(release.detail).toBe('assemble');
        expect(release.kind).toBe(SymbolKind.Class);
    });

    test('a written model has no detail', async () => {
        const docs = await build({ 'parts.jd': PARTS });
        expect((await only(docs['parts.jd'], 'Build {')).detail).toBeUndefined();
    });

    test('an element is not part of the hierarchy', async () => {
        const docs = await build({ 'parts.jd': PARTS });
        const index = docs['parts.jd'].textDocument.getText().indexOf('review is');
        const items = await provider().prepareCallHierarchy(docs['parts.jd'], {
            textDocument: { uri: docs['parts.jd'].uri.toString() },
            position: docs['parts.jd'].textDocument.positionAt(index)
        });
        expect(items ?? []).toEqual([]);
    });
});

describe('outgoing calls', () => {

    test('are the operands, in the order written, from their own files', async () => {
        const docs = await build({
            'parts.jd': PARTS,
            'app.jd': 'load "parts.jd"\njustification Release is assemble(Tests, Build) { conclusionLabel: "Ready" strategyLabel: "All" }\n'
        });
        const calls = await provider().outgoingCalls({ item: await only(docs['app.jd'], 'Release') });
        expect(calls!.map(c => c.to.name)).toEqual(['Tests', 'Build']);
        expect(calls![0].to.uri).toBe(uriOf('parts.jd'));
    });

    test('list an operand used twice once, with both places', async () => {
        const docs = await build({
            'parts.jd': PARTS,
            'app.jd': 'load "parts.jd"\njustification Twice is refine(Build, Build) { hook: "e" }\n'
        });
        const calls = await provider().outgoingCalls({ item: await only(docs['app.jd'], 'Twice') });
        expect(calls).toHaveLength(1);
        expect(calls![0].fromRanges).toHaveLength(2);
    });

    test('carry an operand\'s own operator, so nested compositions can be told apart', async () => {
        const docs = await build({
            'parts.jd': PARTS,
            'app.jd': 'load "parts.jd"\njustification Inner is assemble(Build, Tests) { conclusionLabel: "A" strategyLabel: "B" }\njustification Outer is refine(Inner, Build) { hook: "c" }\n'
        });
        const calls = await provider().outgoingCalls({ item: await only(docs['app.jd'], 'Outer') });
        expect(calls!.map(c => [c.to.name, c.to.detail])).toEqual([['Inner', 'assemble'], ['Build', undefined]]);
    });

    test('of a written model are none', async () => {
        const docs = await build({ 'parts.jd': PARTS });
        expect(await provider().outgoingCalls({ item: await only(docs['parts.jd'], 'Build {') })).toBeUndefined();
    });
});

describe('incoming calls', () => {

    test('are the compositions using the model, and not what implements it', async () => {
        const docs = await build({
            'parts.jd': PARTS,
            'app.jd': 'load "parts.jd"\njustification Release is assemble(Tests, Build) { conclusionLabel: "Ready" strategyLabel: "All" }\n',
            'impl.jd': 'load "parts.jd"\njustification Done implements Signoff {\n    evidence Signoff:review is "Done"\n}\ntemplate Bundle is assemble(Signoff, Build) { conclusionLabel: "A" strategyLabel: "B" }\n'
        });
        const build_ = await provider().incomingCalls({ item: await only(docs['parts.jd'], 'Build {') });
        expect(build_!.map(c => c.from.name).sort()).toEqual(['Bundle', 'Release']);
        const signoff = await provider().incomingCalls({ item: await only(docs['parts.jd'], 'Signoff {') });
        expect(signoff!.map(c => c.from.name)).toEqual(['Bundle']);
    });
});

test('the call hierarchy capability is advertised', async () => {
    const result = await services.shared.lsp.LanguageServer.initialize({
        processId: null, rootUri: null, capabilities: {}, workspaceFolders: null
    });
    expect(result.capabilities.callHierarchyProvider).toBeTruthy();
});
