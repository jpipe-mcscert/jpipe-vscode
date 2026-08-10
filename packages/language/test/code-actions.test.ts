/**
 * One describe per action, plus a first block for the dispatcher itself.
 *
 * The dispatcher cases are worth their own coverage because they encode promises every action
 * relies on and no single action can test: that one module throwing does not take the others down
 * with it, that a fix is offered only against its own diagnostic, and that the same action reached
 * twice appears once.
 */
import { describe, expect, test } from 'vitest';
import { CodeActionKind } from 'vscode-languageserver';
import { JpipeIssue, issueCodeOf } from 'jpipe-language';
import { CURSOR, actionTitles, applyCodeAction, expectFixResolves, listCodeActions, listWithRegistry, parseValidated } from './code-action-helper.js';

/**
 * The titles offered by one action, in order.
 *
 * A fixture that exercises one rule usually trips others in passing — an override written with
 * the wrong keyword is also, incidentally, a strategy nothing supports. Asserting on the whole
 * menu would make every test a test of every action, so each names the repair it is about.
 */
async function titlesMatching(input: string, pattern: RegExp): Promise<string[]> {
    return (await actionTitles(input)).filter(title => pattern.test(title));
}

/** A template with two abstract supports, used wherever an override is under test. */
const TEMPLATE = `template T {
    @support a is "An abstract support"
    @support b is "Another abstract support"
    conclusion c is "A claim"
    strategy s is "A strategy"
    a supports s
    b supports s
    s supports c
}`;

describe('the code action dispatcher', () => {

    test('offers no quick fix on a model with no problems', async () => {
        expect(await actionTitles(`justification J {
    conclusion c is "A claim"
    strategy s is "A strategy"
    evidence e is "Some evidence"
    e supports s
    s supports c
}`, CodeActionKind.QuickFix)).toEqual([]);
    });

    test('marks a quick fix as such, and links it to the diagnostic it repairs', async () => {
        const [action] = await listCodeActions(
            `${TEMPLATE}\njustification J implements T { strategy T:a is "A" evidence T:b is "B" }`
        );
        expect(action.kind).toBe(CodeActionKind.QuickFix);
        expect(action.diagnostics).toHaveLength(1);
        expect(action.diagnostics![0].data).toMatchObject({ code: JpipeIssue.BadSupportOverrideType });
    });

    // The whole point of one-module-per-action is that they fail separately. If a module that
    // throws could blank the menu, a single edge case in one fix would silently disable the rest.
    test('a module that throws does not take the others down with it', async () => {
        const actions = await listWithRegistry(
            `${TEMPLATE}\njustification J implements T { strategy T:a is "A" evidence T:b is "B" }`,
            {
                quickFixes: [
                    {
                        id: 'explodes',
                        codes: [JpipeIssue.BadSupportOverrideType],
                        create() { throw new Error('boom'); }
                    },
                    {
                        id: 'survives',
                        codes: [JpipeIssue.BadSupportOverrideType],
                        create: () => [{ title: 'Still offered' }]
                    }
                ],
                refactorings: []
            }
        );
        expect(actions.map(a => a.title)).toEqual(['Still offered']);
    });

    // The same problem can be reported once per detail, so a fix-all is reached more than once.
    test('an identical action reached twice is offered once', async () => {
        const actions = await listWithRegistry(
            'justification A { conclusion c is "C" }\njustification B is assemble(A)',
            {
                quickFixes: [{
                    id: 'fix-all',
                    codes: [JpipeIssue.MissingConfigKey],
                    create: () => [{ title: 'Add all required keys' }]
                }],
                refactorings: []
            }
        );
        expect(actions.map(a => a.title)).toEqual(['Add all required keys']);
    });

    // A request filtered to source actions must not be answered with quick fixes.
    test('respects the kinds the client asked for', async () => {
        const source = `${TEMPLATE}\njustification J implements T { strategy T:a is "A" evidence T:b is "B" }`;
        expect(await actionTitles(source)).not.toEqual([]);
        expect(await actionTitles(source, 'source.organizeImports')).toEqual([]);
    });
});

describe('fix-override-type', () => {

    const wrongType = (keyword: string) =>
        `${TEMPLATE}\njustification J implements T { ${keyword} T:a is "A" evidence T:b is "B" }`;

    test('offers one action per keyword that may refine an @support', async () => {
        expect(await titlesMatching(wrongType('strategy'), /^Change '/)).toEqual([
            "Change 'strategy' to 'evidence'",
            "Change 'strategy' to 'sub-conclusion'"
        ]);
    });

    test('replaces only the keyword, leaving the id and the label alone', async () => {
        const after = await applyCodeAction(wrongType('strategy'), { title: "Change 'strategy' to 'evidence'" });
        expect(after).toContain('evidence T:a is "A"');
        expect(after).not.toContain('strategy T:a');
    });

    test('resolves the diagnostic it claims to', async () => {
        await expectFixResolves(
            wrongType('strategy'),
            { title: "Change 'strategy' to 'evidence'" },
            JpipeIssue.BadSupportOverrideType
        );
    });

    test('converting to a sub-conclusion resolves it too', async () => {
        const after = await expectFixResolves(
            wrongType('strategy'),
            { title: "Change 'strategy' to 'sub-conclusion'" },
            JpipeIssue.BadSupportOverrideType
        );
        expect(after).toContain('sub-conclusion T:a is "A"');
    });

    // ⌘. then Enter should pick the keyword that needs nothing else added to be valid.
    test('prefers evidence', async () => {
        const [preferred] = await listCodeActions(wrongType('strategy'));
        expect(preferred.title).toBe("Change 'strategy' to 'evidence'");
        expect(preferred.isPreferred).toBe(true);
    });

    test('a conclusion used as an override is offered the same repair', async () => {
        expect(await titlesMatching(wrongType('conclusion'), /^Change '/)).toEqual([
            "Change 'conclusion' to 'evidence'",
            "Change 'conclusion' to 'sub-conclusion'"
        ]);
    });

    test('is not offered where the override is already well typed', async () => {
        expect(await titlesMatching(
            `${TEMPLATE}\njustification J implements T { evidence T:a is "A" sub-conclusion T:b is "B" }`,
            /^Change '/
        )).toEqual([]);
    });
});

describe('add-support-override', () => {

    const missing = (body: string) => `${TEMPLATE}\njustification J implements T {\n${body}\n}`;
    const SKELETON = '    conclusion own is "Own claim"\n    strategy st is "Own strategy"\n    st supports own';

    test('offers both keywords that may refine an @support, plus a fix-all', async () => {
        expect(await titlesMatching(missing(SKELETON), /^Override /)).toEqual([
            "Override '@support a' with evidence",
            "Override '@support a' with sub-conclusion",
            'Override all 2 missing @support elements',
            "Override '@support b' with evidence",
            "Override '@support b' with sub-conclusion"
        ]);
    });

    test('writes the qualified id the template demands and reuses its label', async () => {
        const after = await applyCodeAction(missing(SKELETON), { title: "Override '@support a' with evidence" });
        expect(after).toContain('evidence T:a is "An abstract support"');
    });

    test('inserts among the declarations, above the relations', async () => {
        const after = await applyCodeAction(missing(SKELETON), { title: "Override '@support a' with evidence" });
        const lines = after.split('\n').map(l => l.trim());
        expect(lines.indexOf('evidence T:a is "An abstract support"'))
            .toBeLessThan(lines.indexOf('st supports own'));
    });

    test('matches the indentation of the declarations it joins', async () => {
        const after = await applyCodeAction(missing(SKELETON), { title: "Override '@support a' with evidence" });
        expect(after).toContain('\n    evidence T:a is');
    });

    test('the fix-all closes every gap at once and resolves the diagnostic', async () => {
        const after = await expectFixResolves(
            missing(SKELETON),
            { title: 'Override all 2 missing @support elements' },
            JpipeIssue.MissingSupportOverride
        );
        expect(after).toContain('evidence T:a is "An abstract support"');
        expect(after).toContain('evidence T:b is "Another abstract support"');
    });

    test('an override already written is not offered again, and not counted', async () => {
        const titles = await titlesMatching(missing(`    evidence T:a is "An abstract support"\n${SKELETON}`), /^Override /);
        expect(titles).toContain("Override '@support b' with evidence");
        expect(titles).not.toContain("Override '@support a' with evidence");
        // One gap left, so no fix-all.
        expect(titles.some(t => t.startsWith('Override all'))).toBe(false);
    });
});

describe('fix-operator-name', () => {

    const composed = (operator: string) =>
        `justification A {\n    conclusion c is "C"\n}\njustification B is ${operator}(A) { conclusionLabel: "C" strategyLabel: "S" }`;

    test('offers the known operators, nearest spelling first', async () => {
        expect(await titlesMatching(composed('assmble'), /^Change to /)).toEqual([
            "Change to 'assemble'",
            "Change to 'refine'"
        ]);
    });

    test('ranks by edit distance rather than declaration order', async () => {
        expect((await titlesMatching(composed('refin'), /^Change to /))[0]).toBe("Change to 'refine'");
    });

    test('replaces the operator and resolves the diagnostic', async () => {
        const after = await expectFixResolves(
            composed('assmble'),
            { title: "Change to 'assemble'" },
            JpipeIssue.UnknownOperator
        );
        expect(after).toContain('is assemble(A)');
    });

    test('is not offered for a valid operator', async () => {
        expect(await titlesMatching(composed('assemble'), /^Change to /)).toEqual([]);
    });
});

describe('add-required-config-keys', () => {

    test('adds a single missing key inside the existing block', async () => {
        const after = await expectFixResolves(
            'justification A {\n    conclusion c is "C"\n}\njustification B is assemble(A) { conclusionLabel: "C" }',
            { title: "Add required key 'strategyLabel'" },
            JpipeIssue.MissingConfigKey
        );
        expect(after).toContain('{ conclusionLabel: "C" strategyLabel: "" }');
    });

    // `RuleConfig` is `'{' entries+=KeyValDecl+ '}'`, so writing an empty `{}` would not parse.
    // `expectFixResolves` re-parses, which is what makes this case meaningful.
    test('creates the block and its entries together when there is none', async () => {
        const after = await expectFixResolves(
            'justification A {\n    conclusion c is "C"\n}\njustification B is assemble(A)',
            { title: 'Add all 2 required keys' },
            JpipeIssue.MissingConfigKey
        );
        // Laid out the way every config block in the language's own examples is written.
        expect(after).toContain('justification B is assemble(A) {\n    conclusionLabel: ""\n    strategyLabel: ""\n}');
    });

    test('a created block follows the indentation of the model it belongs to', async () => {
        const after = await expectFixResolves(
            'justification A {\n    conclusion c is "C"\n}\n    justification B is refine(A, A)',
            { title: "Add required key 'hook'" },
            JpipeIssue.MissingConfigKey
        );
        expect(after).toContain('    justification B is refine(A, A) {\n        hook: ""\n    }');
    });

    test('offers a fix-all only when more than one key is missing', async () => {
        const one = await actionTitles('justification A {\n    conclusion c is "C"\n}\njustification B is assemble(A) { conclusionLabel: "C" }');
        expect(one.some(t => t.startsWith('Add all'))).toBe(false);
    });

    test('adds a line to a block already spread over lines', async () => {
        const after = await expectFixResolves(
            'justification A {\n    conclusion c is "C"\n}\njustification B is assemble(A) {\n    conclusionLabel: "C"\n}',
            { title: "Add required key 'strategyLabel'" },
            JpipeIssue.MissingConfigKey
        );
        expect(after).toContain('\n    conclusionLabel: "C"\n    strategyLabel: ""\n');
    });
});

describe('fix-config-key', () => {

    const withKey = (key: string) =>
        `justification A {\n    conclusion c is "C"\n}\njustification B is assemble(A) { conclusionLabel: "C" strategyLabel: "S" ${key}: "X" }`;

    test('suggests the near-matching key and offers removal', async () => {
        expect(await titlesMatching(withKey('unifyBu'), /^(Change to|Remove config key) /)).toEqual([
            "Change to 'unifyBy'",
            "Remove config key 'unifyBu'"
        ]);
    });

    test('renaming resolves the diagnostic', async () => {
        const after = await expectFixResolves(
            withKey('unifyBu'),
            { title: "Change to 'unifyBy'" },
            JpipeIssue.UnknownConfigKey
        );
        expect(after).toContain('unifyBy: "X"');
    });

    test('removal takes the entry without disturbing its siblings on the same line', async () => {
        const after = await expectFixResolves(
            withKey('nonsense'),
            { title: "Remove config key 'nonsense'" },
            JpipeIssue.UnknownConfigKey
        );
        expect(after).toContain('{ conclusionLabel: "C" strategyLabel: "S" }');
    });

    test('offers no rename onto a key the block already sets', async () => {
        const titles = await actionTitles(
            `justification A {\n    conclusion c is "C"\n}\njustification B is assemble(A) { conclusionLabel: "C" strategyLabel: "S" conclusionLabe: "X" }`
        );
        expect(titles).not.toContain("Change to 'conclusionLabel'");
    });

    test('a key nothing resembles is only offered removal', async () => {
        expect(await titlesMatching(withKey('zzzzzzzzzzzz'), /^(Change to|Remove config key) /))
            .toEqual(["Remove config key 'zzzzzzzzzzzz'"]);
    });
});

describe('remove-load', () => {

    const unresolvable = 'load "nowhere.jd"\njustification J {\n    conclusion c is "C"\n    strategy s is "S"\n    s supports c\n}';

    test('offers to remove a load that resolves to nothing', async () => {
        expect(await actionTitles(unresolvable)).toContain("Remove load 'nowhere.jd'");
    });

    test('removal takes the whole line, leaving the rest of the file alone', async () => {
        const after = await expectFixResolves(
            unresolvable,
            { title: "Remove load 'nowhere.jd'" },
            JpipeIssue.LoadUnresolved
        );
        expect(after).toBe('justification J {\n    conclusion c is "C"\n    strategy s is "S"\n    s supports c\n}');
    });

    test('removes only the offending load when several are present', async () => {
        const after = await applyCodeAction(
            'load "nowhere.jd"\nload "elsewhere.jd"\njustification J {\n    conclusion c is "C"\n}',
            { title: "Remove load 'nowhere.jd'" }
        );
        expect(after).toContain('load "elsewhere.jd"');
        expect(after).not.toContain('nowhere.jd');
    });

    test('is not offered for a load that resolves', async () => {
        expect(await titlesMatching(
            'justification J {\n    conclusion c is "C"\n    strategy s is "S"\n    s supports c\n}',
            /^Remove load /
        )).toEqual([]);
    });
});

describe('add-supporter', () => {

    const lonelyConclusion = 'justification J {\n    conclusion c is "A claim"\n}';
    const lonelyStrategy = 'justification J {\n    conclusion c is "A claim"\n    strategy s is "A strategy"\n    s supports c\n}';

    test('a conclusion may only be offered a strategy', async () => {
        expect(await actionTitles(lonelyConclusion, CodeActionKind.QuickFix))
            .toEqual(["Add a strategy supporting 'c'"]);
    });

    test('a strategy is offered evidence or a sub-conclusion', async () => {
        expect(await actionTitles(lonelyStrategy, CodeActionKind.QuickFix)).toEqual([
            "Add some evidence supporting 's'",
            "Add a sub-conclusion supporting 's'"
        ]);
    });

    test('writes both the declaration and the relation, and resolves the diagnostic', async () => {
        const after = await expectFixResolves(
            lonelyConclusion,
            { title: "Add a strategy supporting 'c'" },
            JpipeIssue.ConclusionUnsupported
        );
        expect(after).toContain('strategy s is ""');
        expect(after).toContain('s supports c');
    });

    test('puts the relation below the relations already there', async () => {
        const after = await expectFixResolves(
            lonelyStrategy,
            { title: "Add some evidence supporting 's'" },
            JpipeIssue.StrategyUnsupported
        );
        const lines = after.split('\n').map(l => l.trim());
        expect(lines.indexOf('evidence e is ""')).toBeLessThan(lines.indexOf('s supports c'));
        expect(lines.indexOf('s supports c')).toBeLessThan(lines.indexOf('e supports s'));
    });

    test('picks an id that is not already taken', async () => {
        const after = await applyCodeAction(
            'justification J {\n    conclusion c is "A claim"\n    strategy s is "Taken"\n    evidence e is "E"\n    e supports s\n    s supports c\n}\njustification K {\n    conclusion c2 is "Another"\n}',
            { title: "Add a strategy supporting 'c2'" }
        );
        // `s` belongs to the other model, so the fresh id here may still be `s`.
        expect(after).toContain('strategy s is ""');
        expect(after).toContain('s supports c2');
    });

    test('avoids colliding with an id in the same model', async () => {
        const after = await applyCodeAction(
            'justification J {\n    conclusion c is "A claim"\n    strategy s is "Unrelated"\n    evidence e is "E"\n    e supports s\n}',
            { title: "Add a strategy supporting 'c'" }
        );
        expect(after).toContain('strategy s1 is ""');
        expect(after).toContain('s1 supports c');
    });

    test('is not offered to an element that is already supported', async () => {
        expect(await actionTitles(
            'justification J {\n    conclusion c is "C"\n    strategy s is "S"\n    evidence e is "E"\n    e supports s\n    s supports c\n}',
            CodeActionKind.QuickFix
        )).toEqual([]);
    });
});

describe('remove-load on a broken pattern', () => {

    // A pattern that does not compile cannot have a file suggested for it, so without this the
    // lightbulb offers nothing at all on the one load the user most clearly has to deal with.
    test('offers removal for a malformed glob', async () => {
        const titles = await actionTitles(
            'load "models/[.jd"\njustification J {\n    conclusion c is "C"\n    strategy s is "S"\n    s supports c\n}',
            CodeActionKind.QuickFix
        );
        expect(titles).toContain("Remove load 'models/[.jd'");
    });

    test('removal leaves a parseable file', async () => {
        const after = await applyCodeAction(
            'load "models/[.jd"\njustification J {\n    conclusion c is "C"\n}',
            { title: "Remove load 'models/[.jd'" }
        );
        expect(after).toBe('justification J {\n    conclusion c is "C"\n}');
    });
});

describe('reaching a fix from the line it belongs to', () => {

    // Diagnostics in this language are anchored on an identifier, so the squiggle under
    // `Justification 'j' must override …` is the single character `j`. A client sends only the
    // diagnostics overlapping the caret, so relying on its set alone put the lightbulb on one
    // character of one line and nowhere else — not how quick fixes behave anywhere else.
    const MISSING_OVERRIDE = `${TEMPLATE}
justification J implements T {
    conclusion own is "Own claim"
    strategy st is "Own strategy"
    evidence ev is "Own evidence"
    ev supports st
    st supports own
}`;

    test('the diagnostic itself stays narrow', async () => {
        const document = await parseValidated(MISSING_OVERRIDE);
        const anchored = (document.diagnostics ?? [])
            .filter(d => issueCodeOf(d) === JpipeIssue.MissingSupportOverride);
        expect(anchored.length).toBeGreaterThan(0);
        // One identifier wide — precise, which is what a squiggle should be.
        const [first] = anchored;
        expect(first.range.end.character - first.range.start.character).toBeLessThanOrEqual(2);
    });

    test.each([
        ['at the start of the line', 0],
        ['in the middle of the keyword', 6],
        ['at the end of the line', 28]
    ])('the fix is offered %s', async (_label, column) => {
        // Place the cursor on the header line, away from the identifier itself.
        const lines = MISSING_OVERRIDE.split('\n');
        const headerLine = lines.findIndex(l => l.startsWith('justification J'));
        const before = lines.slice(0, headerLine).join('\n');
        const header = lines[headerLine];
        const at = Math.min(column, header.length);
        const marked = [
            before,
            header.slice(0, at) + CURSOR + header.slice(at),
            ...lines.slice(headerLine + 1)
        ].join('\n');

        const titles = await actionTitles(marked, CodeActionKind.QuickFix);
        expect(titles.some(t => t.startsWith("Override '@support"))).toBe(true);
    });

    // Widening stops at the line: a model-level repair offered from anywhere inside a long
    // justification would put it in front of people who are not looking at it.
    test('the fix is not offered from an unrelated line', async () => {
        const lines = MISSING_OVERRIDE.split('\n');
        const bodyLine = lines.findIndex(l => l.includes('ev supports st'));
        const marked = [
            ...lines.slice(0, bodyLine),
            CURSOR + lines[bodyLine],
            ...lines.slice(bodyLine + 1)
        ].join('\n');

        const titles = await actionTitles(marked, CodeActionKind.QuickFix);
        expect(titles.some(t => t.startsWith("Override '@support"))).toBe(false);
    });
});
