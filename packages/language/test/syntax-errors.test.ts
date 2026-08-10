/**
 * What a syntax error says, and where it points.
 *
 * An unfinished declaration is reported twice wrongly by default. `evidence` alone on a line
 * parses on into the *next* line — because the word starting that line is a perfectly good name
 * for it — and fails a token later, so the marker lands on a line the author had already
 * finished. And the message, `Expecting token of type 'is' but found 'c'`, describes the parser's
 * predicament rather than the author's mistake.
 *
 * Neither is fixable by parsing differently: the input really is ambiguous until it fails. So the
 * cases here are about the account given of it — which line carries the marker, and whether the
 * text names the construct and says what it still needs.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument } from 'langium';
import { parseHelper } from 'langium/test';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-types';
import { createJpipeServices, type Unit } from 'jpipe-language';

let parse: (input: string) => Promise<LangiumDocument<Unit>>;

beforeAll(() => {
    const services = createJpipeServices(EmptyFileSystem);
    const doParse = parseHelper<Unit>(services.Jpipe);
    parse = (input) => doParse(input, { validation: true });
});

/** The syntax errors, as `{ line, message }` against the source's own lines. */
async function syntaxErrors(source: string) {
    const document = await parse(source);
    return (document.diagnostics ?? [])
        .filter(d => d.severity === DiagnosticSeverity.Error)
        .map(d => ({
            line: d.range.start.line,
            text: source.split('\n')[d.range.start.line],
            message: Diagnostic.getMessageString(d)
        }));
}

describe('an unfinished declaration', () => {

    // The reported bug: the marker used to sit on the *following* line.
    test('is marked on its own line, not the next one', async () => {
        const [first] = await syntaxErrors(
            'justification J {\n    evidence\n    conclusion c is "C"\n    strategy s is "S"\n    s supports c\n}'
        );
        expect(first.text.trim()).toBe('evidence');
    });

    test('is marked at the end of what was written, where the missing part belongs', async () => {
        const document = await parse('justification J {\n    evidence\n    conclusion c is "C"\n}');
        const [first] = (document.diagnostics ?? []).filter(d => d.severity === DiagnosticSeverity.Error);
        // `    evidence` is twelve characters; the marker sits just past it.
        expect(first.range.start).toEqual({ line: 1, character: 12 });
    });

    test.each([
        ['evidence', 'justification J {\n    evidence\n    conclusion c is "C"\n}'],
        ['strategy', 'justification J {\n    strategy\n    conclusion c is "C"\n}'],
        ['conclusion', 'justification J {\n    conclusion\n    strategy s is "S"\n}'],
        ['sub-conclusion', 'justification J {\n    sub-conclusion\n    conclusion c is "C"\n}'],
        ['@support', 'template T {\n    @support\n    conclusion c is "C"\n}']
    ])('names the construct being written — %s', async (keyword, source) => {
        const [first] = await syntaxErrors(source);
        expect(first.message).toContain(`Unfinished ${keyword}`);
        expect(first.message).toContain(`${keyword} <name> is "<label>"`);
    });

    test('says what is still missing when the name is there but the rest is not', async () => {
        const [first] = await syntaxErrors('justification J {\n    evidence e\n    conclusion c is "C"\n}');
        expect(first.message).toContain("expected 'is' after 'e'");
        expect(first.text.trim()).toBe('evidence e');
    });

    // Nothing follows to be blamed instead, but the message still has to be about the
    // declaration rather than about the brace.
    test('reads the same when the file ends right after it', async () => {
        const [first] = await syntaxErrors('justification J {\n    conclusion c is "C"\n    evidence\n}');
        expect(first.message).toContain('Unfinished evidence');
        expect(first.text.trim()).toBe('evidence');
    });
});

describe('a construct that cannot be empty', () => {

    // `(body+=… | rels+=Relation)+` and `entries+=KeyValDecl+` are one-or-more, and the default
    // account of that is a wall of token sequences.
    test('a model says so in its own terms', async () => {
        const [first] = await syntaxErrors('justification J {\n}');
        expect(first.message).toBe('A model cannot be empty: it needs at least one element or relation.');
    });

    test('a config block says so in its own terms', async () => {
        const errors = await syntaxErrors('justification A { conclusion c is "C" }\njustification B is assemble(A) {}');
        expect(errors.some(e => e.message.startsWith('A config block cannot be empty'))).toBe(true);
    });
});

describe('a finished model', () => {

    test('reports no syntax error at all', async () => {
        expect(await syntaxErrors(
            'justification J {\n    conclusion c is "C"\n    strategy s is "S"\n    evidence e is "E"\n    e supports s\n    s supports c\n}'
        )).toEqual([]);
    });
});
