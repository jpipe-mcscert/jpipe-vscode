/**
 * "Auto-indent and align" — the layout, and everything it must not disturb.
 *
 * A formatter is invoked on a whole file and its result is rarely read line by line, so what it
 * *leaves alone* is as much a part of the behaviour as what it rewrites. Roughly half of these
 * cases pin something the action must not touch: a comment's place, a blank line, the interior of
 * a block comment, the exact literal an author quoted, a model written on one line.
 *
 * Two whole-file properties carry the rest. The layout must be **idempotent** — running it twice
 * changes nothing the second time, which is what makes it safe to bind to a key — and it must be
 * **meaning-preserving**, checked by validating the result rather than by reading it.
 */
import { describe, expect, test } from 'vitest';

import { Diagnostic } from 'vscode-languageserver';
import { AUTO_INDENT_KIND } from 'jpipe-language';
import { actionTitles, applyCodeAction, parseValidated } from './code-action-helper.js';

const ONLY = AUTO_INDENT_KIND;
const TITLE = 'Auto-indent and align';

/** The file as it stands once the action is accepted. */
function laidOut(source: string): Promise<string> {
    return applyCodeAction(source, { title: TITLE, only: ONLY });
}

/** Whether the action is offered at all — it is not, on a file that already reads correctly. */
async function isOffered(source: string): Promise<boolean> {
    return (await actionTitles(source, ONLY)).includes(TITLE);
}

async function errorsIn(source: string): Promise<string[]> {
    const document = await parseValidated(source);
    return (document.diagnostics ?? [])
        .filter(diagnostic => diagnostic.severity === 1)
        .map(diagnostic => Diagnostic.getMessageString(diagnostic));
}

/** The convention, as the compiler's examples write it. */
const CANONICAL = `template a_template {
    conclusion c   is "A conclusion"
    strategy   s   is "A strategy"
    @support   abs is "An abstract support"

    abs supports s
    s   supports c
}`;

describe('columns', () => {

    test('a run of declarations lines up its ids and its `is` keywords', async () => {
        const cramped = `template a_template {
conclusion c is "A conclusion"
strategy s is "A strategy"
@support abs is "An abstract support"

abs supports s
s supports c
}`;
        expect(await laidOut(cramped)).toBe(CANONICAL);
    });

    test('a run of relations lines up its supporters', async () => {
        const after = await laidOut(`justification J {
    conclusion c is "C"
    strategy long_strategy is "S"
    evidence e is "E"
    e supports long_strategy
    long_strategy supports c
}`);
        expect(after).toContain('    e             supports long_strategy\n');
        expect(after).toContain('    long_strategy supports c\n');
    });

    // Alignment is local, so one long id in another part of the body does not push a whole
    // model's labels across the screen — and each sub-argument reads as its own block.
    test('a blank line starts a new set of columns', async () => {
        const after = await laidOut(`justification J {
    conclusion c is "C"
    strategy s is "S"

    evidence a_much_longer_id is "E"
    conclusion c2 is "C2"
}`);
        expect(after).toContain('    conclusion c is "C"\n');
        expect(after).toContain('    strategy   s is "S"\n');
        expect(after).toContain('    evidence   a_much_longer_id is "E"\n');
    });

    test('a comment between two declarations starts a new set too', async () => {
        const after = await laidOut(`justification J {
    conclusion c is "C"
    // a note
    strategy a_much_longer_id is "S"
    evidence e is "E"
}`);
        expect(after).toContain('    conclusion c is "C"\n');
        expect(after).toContain('    strategy a_much_longer_id is "S"\n');
        expect(after).toContain('    evidence e                is "E"\n');
    });

    // Elements and relations are different shapes; sharing a column between them would align
    // `supports` under `is` and read as neither.
    test('elements and relations do not share columns even when adjacent', async () => {
        const after = await laidOut(`justification J {
    conclusion c is "C"
    strategy sss is "S"
    sss supports c
}`);
        expect(after).toContain('    conclusion c   is "C"\n');
        expect(after).toContain('    strategy   sss is "S"\n');
        expect(after).toContain('    sss supports c\n');
    });

    /**
     * The consequence of the rule above, and the reason it is worth having. A relation between two
     * runs of declarations keeps them apart, so one long evidence id at the bottom of a body does
     * not push the labels of the conclusion at the top halfway across the screen.
     */
    test('a relation separates the runs of declarations on either side of it', async () => {
        const after = await laidOut(`justification J {
    conclusion c is "C"
    strategy sss is "S"
    sss supports c
    evidence a_very_long_evidence_id is "E"
    a_very_long_evidence_id supports sss
}`);
        expect(after).toContain('    conclusion c   is "C"\n');
        expect(after).toContain('    evidence a_very_long_evidence_id is "E"\n');
    });

    // Not asked for, but a config block is the same shape as everything else here and leaving one
    // construct untidied in an action named for tidying reads as an oversight.
    test('a config block lines up its values', async () => {
        const after = await laidOut(`justification A { conclusion c is "C" }
justification B is assemble(A) {
conclusionLabel: "A conclusion"
strategyLabel: "A strategy"
}`);
        expect(after).toContain('    conclusionLabel: "A conclusion"\n');
        expect(after).toContain('    strategyLabel:   "A strategy"\n');
    });
});

describe('nesting', () => {

    test('braces set the depth, and the closing brace comes back out', async () => {
        expect(await laidOut(`justification J {
        conclusion c is "C"
            strategy s is "S"
  s supports c
      }`)).toBe(`justification J {
    conclusion c is "C"
    strategy   s is "S"
    s supports c
}`);
    });

    // A label is a string and a string may hold a brace. Counting braces in the text rather than
    // in the tokens would indent everything after this line one level too deep, for ever.
    test('a brace inside a label does not open a level', async () => {
        const after = await laidOut(`justification J {
conclusion c is "A conclusion with a { in it"
strategy s is "S"
}`);
        expect(after).toContain('    strategy   s is "S"\n');
        expect(after.endsWith('\n}')).toBe(true);
    });

    test('a comment is indented with the code it introduces', async () => {
        expect(await laidOut(`justification J {
// about the conclusion
conclusion c is "C"
}`)).toBe(`justification J {
    // about the conclusion
    conclusion c is "C"
}`);
    });
});

describe('what it leaves alone', () => {

    test('a trailing comment keeps its place beside the declaration', async () => {
        const after = await laidOut(`justification J {
conclusion c is "C"   // the claim
strategy s is "S"
}`);
        expect(after).toContain('    conclusion c is "C"   // the claim\n');
    });

    // Shifting the continuation lines would break the `*` column the author aligned by hand, and
    // there is no indent level that is "the" right one for the inside of a comment.
    test('the interior of a block comment is untouched', async () => {
        const banner = `/*********************************
 * jPipe  -  Reference Examples  *
 *********************************/`;
        const after = await laidOut(`${banner}\njustification J {\nconclusion c is "C"\n}`);
        expect(after.startsWith(banner)).toBe(true);
    });

    // The hard case for that rule: code following the comment's closing marker, on the same line.
    // A token *does* begin there, so the line looks like one whose indent is ours to choose — and
    // re-indenting it would cut into the comment that owns the first half of it.
    test('a line where a block comment ends is left alone even when code follows', async () => {
        const source = `/* a comment\n   that ends here */ justification J {\nconclusion c is "C"\n}`;
        const after = await laidOut(source);
        expect(after).toContain('   that ends here */ justification J {\n');
        expect(after).toContain('    conclusion c is "C"\n');
    });

    /**
     * A declaration split across two lines has no single line to align, and its parts are not all
     * on the line the rewrite would replace. Re-spacing it would swallow the second line.
     */
    test('a declaration split across two lines keeps both of them', async () => {
        const after = await laidOut(`justification J {
evidence e
    is "E"
conclusion c is "C"
}`);
        expect(after).toContain('    evidence e\n');
        expect(after).toContain('is "E"\n');
        expect(after).toContain('    conclusion c is "C"\n');
    });

    // Blank lines are how a body is divided into sub-arguments — the sort-elements action puts
    // them there on purpose — so a formatter that normalises them destroys structure.
    test('blank lines are kept exactly as they are', async () => {
        const after = await laidOut(`justification J {
conclusion c is "C"


strategy s is "S"
}`);
        expect(after).toContain('"C"\n\n\n    strategy');
    });

    test('the label is left as the author quoted it', async () => {
        const after = await laidOut(`justification J {\nconclusion c is 'single quoted'\n}`);
        expect(after).toContain(`conclusion c is 'single quoted'`);
    });

    /**
     * Splitting a line is a different operation from indenting one. A model written on one line
     * comes back on one line — correctly indented, and no more rearranged than that.
     */
    test('a model written on one line is not taken apart', async () => {
        const after = await laidOut(`  justification J { conclusion c is "C" strategy s is "S" }`);
        expect(after).toBe(`justification J { conclusion c is "C" strategy s is "S" }`);
    });
});

describe('whole-file properties', () => {

    const MESSY = `load "b.jd"
// a note
justification J {
        conclusion c is "C"
   strategy long_name is "S"
  evidence e is "E"

  e supports long_name
      long_name supports c
}
template T implements T2 {
@support abs is "A"
}`;

    // The property that makes it safe to invoke without reading the result: a second run is a
    // no-op, so the file has a fixed point rather than drifting on each use.
    test('running it twice changes nothing the second time', async () => {
        const once = await laidOut(MESSY);
        expect(await isOffered(once)).toBe(false);
    });

    test('it is not offered on a file that already reads correctly', async () => {
        expect(await isOffered(CANONICAL)).toBe(false);
    });

    // Every other assertion here could pass on a file that no longer means what it did.
    test('the model still says what it said', async () => {
        const source = `justification J {
conclusion c is "C"
strategy s is "S"
evidence e is "E"
e supports s
s supports c
}`;
        expect(await errorsIn(source)).toEqual([]);
        expect(await errorsIn(await laidOut(source))).toEqual([]);
    });

    test('trailing whitespace goes', async () => {
        const after = await laidOut('justification J {   \nconclusion c is "C"  \n}  ');
        expect(after).toBe('justification J {\n    conclusion c is "C"\n}');
    });

    // Depth and columns are both read off the tree. On a file the tree does not describe, the
    // action would indent the part it understood and leave the rest where it fell.
    test('it is not offered on a file that does not parse', async () => {
        expect(await isOffered('justification J {\n  conclusion c is\n')).toBe(false);
    });

    test('a qualified id is written in its canonical spelling', async () => {
        const after = await laidOut(`template T { @support a is "A" }
justification J implements T {
evidence T : a is "E"
}`);
        expect(after).toContain('    evidence T:a is "E"\n');
    });

    // Every line of a document with Windows endings would otherwise differ from itself, and the
    // action would offer to rewrite every file on the platform.
    test('carriage returns survive, and do not make every line look wrong', async () => {
        expect(await isOffered('justification J {\r\n    conclusion c is "C"\r\n}')).toBe(false);
        expect(await laidOut('justification J {\r\nconclusion c is "C"\r\n}'))
            .toBe('justification J {\r\n    conclusion c is "C"\r\n}');
    });
});
