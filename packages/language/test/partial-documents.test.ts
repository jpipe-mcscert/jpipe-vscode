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

describe('the outline never emits a nameless symbol', () => {

    /** Every symbol in the tree, flattened. */
    function flatten(symbols: readonly { name: string; children?: readonly unknown[] }[]): { name: string }[] {
        return symbols.flatMap(s => [s, ...flatten((s.children ?? []) as never[])]);
    }

    // The client rejects a symbol whose name is empty with "name must not be falsy" and discards
    // the entire response, so one half-typed line emptied the outline and raised a notification
    // on every keystroke. Guarding our own code against throwing was not enough — what we hand
    // back has to be valid too.
    const NAMELESS: ReadonlyArray<readonly [string, string]> = [
        ['a model with no name', 'justification '],
        ['a model with no name and a body', 'justification  {\n    conclusion c is "C"\n}'],
        ['a template with no name', 'template '],
        ['both a nameless model and a nameless element', 'justification  {\n    evidence \n}']
    ];

    test.each([...MID_KEYSTROKE, ...NAMELESS])('%s yields no empty name', async (_label, source) => {
        const document = await parse(source);
        const symbols = await services.Jpipe.lsp.DocumentSymbolProvider!.getSymbols(
            document, { textDocument: { uri: document.uri.toString() } }
        );
        const empty = flatten(symbols as never[]).filter(s => !s.name);
        expect(empty).toEqual([]);
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

    /**
     * The same fault as the outline's, in the scope provider: Langium refuses to describe a node
     * with no name and *throws*, so one element being typed took down the scope every relation in
     * the model resolves through. It surfaced as a linking failure on each of them — "An error
     * occurred while resolving reference to 's'" — rather than as anything about the element the
     * author was actually writing.
     */
    test('does not break the scope the relations around it resolve through', async () => {
        const document = await parse(
            'justification J {\n'
            + '    evidence  is "Being typed"\n'
            + '    evidence e2 is "E2"\n'
            + '    strategy s is "S"\n'
            + '    conclusion c is "C"\n'
            + '    e2 supports s\n'
            + '    s supports c\n'
            + '}');
        const messages = (document.diagnostics ?? []).map(d => Diagnostic.getMessageString(d));
        expect(messages.filter(m => m.includes('An error occurred'))).toEqual([]);

        const relations = document.parseResult.value.body[0].contents?.rels ?? [];
        expect(relations.length, 'fixture should contain relations').toBe(2);
        for (const relation of relations) {
            expect(relation.from.ref, `'${relation.from.$refText}' should still resolve`).toBeDefined();
            expect(relation.to.ref, `'${relation.to.$refText}' should still resolve`).toBeDefined();
        }
    });
});

describe('no action edits outside the document', () => {

    /**
     * An edit naming a line the document does not have is rejected by the editor with a popup,
     * not ignored — so an action that anchors to "the line after the last one" breaks on exactly
     * the files where the last line is the last thing typed. These shapes all end without the
     * tidy trailing newline a finished file has.
     */
    const RAGGED: ReadonlyArray<readonly [string, string]> = [
        ['relation sharing the closing line',
         'justification J {\n    conclusion c is "C"\n    strategy s is "S"\n    s supports c }'],
        ['the whole model on one line',
         'justification J { conclusion c is "C" strategy s is "S" s supports c }'],
        ['declaration sharing the closing line',
         'justification J {\n    conclusion c is "C" }'],
        ['relations written before declarations',
         'justification J {\n    s supports c\n    conclusion c is "C"\n    strategy s is "S"\n}'],
        ['no trailing newline after the brace',
         'justification J {\n    conclusion c is "C"\n    strategy s is "S"\n    s supports c\n}'],
        ['a template ending raggedly',
         'template T {\n    @support a is "A"\n    conclusion c is "C"\n    a supports c }'],
        ['a composition with no config',
         'justification A { conclusion c is "C" }\njustification B is assemble(A)'],
        ['an unresolvable load and nothing else',
         'load "nowhere.jd"'],
        ['a model with an empty body',
         'template T {\n    @support a is "A"\n    conclusion c is "C"\n    a supports c\n}\njustification J implements T {}']
    ];

    test.each(RAGGED)('%s', async (_label, source) => {
        const document = await parse(source);
        const uri = document.uri.toString();
        const lineCount = source.split('\n').length;
        const lastLineLength = source.split('\n')[lineCount - 1].length;

        const produced = await services.Jpipe.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri },
            range: {
                start: document.textDocument.positionAt(0),
                end: document.textDocument.positionAt(source.length)
            },
            context: { diagnostics: document.diagnostics ?? [] }
        });

        const offences: string[] = [];
        for (const action of produced ?? []) {
            if (!('title' in action) || !('edit' in action)) continue;
            for (const edit of action.edit?.changes?.[uri] ?? []) {
                for (const [which, position] of [['start', edit.range.start], ['end', edit.range.end]] as const) {
                    if (position.line >= lineCount) {
                        offences.push(`'${action.title}' ${which} line ${position.line}, document has ${lineCount}`);
                    } else if (position.line === lineCount - 1 && position.character > lastLineLength) {
                        offences.push(`'${action.title}' ${which} character ${position.character} past the last line`);
                    }
                }
            }
        }
        expect(offences).toEqual([]);
    });
});
