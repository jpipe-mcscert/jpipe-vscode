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
