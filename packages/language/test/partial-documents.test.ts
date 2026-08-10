/**
 * What the language server does with a file that is mid-keystroke.
 *
 * Every model passes through these shapes on the way to being written: `e supports ` with no
 * target yet, `evidence ` with no name yet. They are not edge cases, they are what typing looks
 * like — and both used to throw. The validator's crash surfaced as red underlines reading "An
 * error occurred during validation", and the outline's surfaced as a "Request
 * textDocument/documentSymbol failed" popup, once per keystroke.
 *
 * The assertions are deliberately about the *absence* of internal failure rather than about what
 * is reported, because a half-written model has no single right set of findings — but it must
 * never produce a message about our own internals.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument } from 'langium';
import { parseHelper } from 'langium/test';
import { Diagnostic } from 'vscode-languageserver-types';
import { createJpipeServices, type Unit } from 'jpipe-language';

let services: ReturnType<typeof createJpipeServices>;
let parse: (input: string) => Promise<LangiumDocument<Unit>>;

beforeAll(() => {
    services = createJpipeServices(EmptyFileSystem);
    const doParse = parseHelper<Unit>(services.Jpipe);
    parse = (input) => doParse(input, { validation: true });
});

/** The shapes a file passes through while a relation or a declaration is being typed. */
const MID_KEYSTROKE: ReadonlyArray<readonly [string, string]> = [
    ['a relation with no target yet',
     'justification J {\n    conclusion c is "C"\n    strategy s is "S"\n    evidence e is "E"\n    e supports\n}'],
    ['a relation whose target is still blank',
     'justification J {\n    conclusion c is "C"\n    strategy s is "S"\n    e supports \n    s supports c\n}'],
    ['an element with no name yet',
     'justification J {\n    conclusion c is "C"\n    evidence \n}'],
    ['nothing but a keyword',
     'justification J {\n    evidence\n}'],
    ['a template mid-declaration',
     'template T {\n    @support\n}'],
    ['a relation in a template with no target',
     'template T {\n    @support a is "A"\n    conclusion c is "C"\n    a supports\n}']
];

describe('validation', () => {

    test.each(MID_KEYSTROKE)('%s does not fail internally', async (_label, source) => {
        const document = await parse(source);
        const internal = (document.diagnostics ?? [])
            .map(d => Diagnostic.getMessageString(d))
            .filter(m => m.includes('An error occurred during validation'));
        expect(internal).toEqual([]);
    });
});

describe('the outline', () => {

    test.each(MID_KEYSTROKE)('%s does not throw', async (_label, source) => {
        const document = await parse(source);
        // `getSymbols` returns `MaybePromise`, so this normalises before asserting.
        await expect(Promise.resolve(
            services.Jpipe.lsp.DocumentSymbolProvider!.getSymbols(
                document,
                { textDocument: { uri: document.uri.toString() } }
            )
        )).resolves.toBeDefined();
    });
});

describe('code actions', () => {

    // A lightbulb request arrives on every cursor move, including into a half-written line.
    test.each(MID_KEYSTROKE)('%s does not throw', async (_label, source) => {
        const document = await parse(source);
        await expect(Promise.resolve(
            services.Jpipe.lsp.CodeActionProvider!.getCodeActions(document, {
                textDocument: { uri: document.uri.toString() },
                range: {
                    start: document.textDocument.positionAt(0),
                    end: document.textDocument.positionAt(document.textDocument.getText().length)
                },
                context: { diagnostics: document.diagnostics ?? [] }
            })
        )).resolves.toBeDefined();
    });
});

describe('an element with no name', () => {

    // Naming it `''` would put an index entry under the empty string, where every other
    // half-typed element in the workspace would collide with it.
    test('is not indexed under an empty name', async () => {
        const document = await parse('justification J {\n    conclusion c is "C"\n    evidence \n}');
        const unit = document.parseResult.value;
        const model = unit.body[0];
        const nameless = (model.contents?.body ?? []).find(element => element.id === undefined);
        expect(nameless, 'fixture should contain an element with no id').toBeDefined();
        expect(services.Jpipe.references.NameProvider.getName(nameless!)).toBeUndefined();
    });
});
