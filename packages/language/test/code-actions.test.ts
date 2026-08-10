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
import { JpipeIssue } from 'jpipe-language';
import { actionTitles, applyCodeAction, expectFixResolves, listCodeActions, listWithRegistry } from './code-action-helper.js';

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

    test('offers nothing on a model with no problems', async () => {
        expect(await actionTitles(`justification J {
    conclusion c is "A claim"
    strategy s is "A strategy"
    evidence e is "Some evidence"
    e supports s
    s supports c
}`)).toEqual([]);
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
        expect(await actionTitles(wrongType('strategy'))).toEqual([
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
        expect(await actionTitles(wrongType('conclusion'))).toEqual([
            "Change 'conclusion' to 'evidence'",
            "Change 'conclusion' to 'sub-conclusion'"
        ]);
    });

    test('is not offered where the override is already well typed', async () => {
        expect(await actionTitles(
            `${TEMPLATE}\njustification J implements T { evidence T:a is "A" sub-conclusion T:b is "B" }`
        )).toEqual([]);
    });
});

describe('add-support-override', () => {

    const missing = (body: string) => `${TEMPLATE}\njustification J implements T {\n${body}\n}`;
    const SKELETON = '    conclusion own is "Own claim"\n    strategy st is "Own strategy"\n    st supports own';

    test('offers both keywords that may refine an @support, plus a fix-all', async () => {
        expect(await actionTitles(missing(SKELETON))).toEqual([
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
        const titles = await actionTitles(missing(`    evidence T:a is "An abstract support"\n${SKELETON}`));
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
        expect(await actionTitles(composed('assmble'))).toEqual([
            "Change to 'assemble'",
            "Change to 'refine'"
        ]);
    });

    test('ranks by edit distance rather than declaration order', async () => {
        expect((await actionTitles(composed('refin')))[0]).toBe("Change to 'refine'");
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
        expect(await actionTitles(composed('assemble'))).toEqual([]);
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
        expect(after).toContain('is assemble(A) { conclusionLabel: "" strategyLabel: "" }');
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
        expect(await actionTitles(withKey('unifyBu'))).toEqual([
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
        expect(await actionTitles(withKey('zzzzzzzzzzzz'))).toEqual(["Remove config key 'zzzzzzzzzzzz'"]);
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
        expect(await actionTitles('justification J {\n    conclusion c is "C"\n    strategy s is "S"\n    s supports c\n}'))
            .toEqual([]);
    });
});
