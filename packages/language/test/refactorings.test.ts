/**
 * The actions offered for where the cursor is rather than for a reported problem.
 *
 * The cases that matter most here are the refusals. A refactoring is invoked deliberately and
 * applied without being read, and `Organize loads` may be bound to save — so what it declines to
 * do is as much a part of its behaviour as what it does. Each block therefore pins both: the
 * rewrite, and the shapes it must leave alone.
 */
import { describe, expect, test } from 'vitest';
import { CodeActionKind } from 'vscode-languageserver';
import { CURSOR, actionTitles, applyCodeAction } from './code-action-helper.js';

const ORGANIZE = 'source.organizeImports';

describe('organize-loads', () => {

    const withLoads = (block: string) => `${block}\njustification J {\n    conclusion c is "C"\n}`;

    test('sorts, de-duplicates and normalizes in one edit', async () => {
        const after = await applyCodeAction(
            withLoads('load "b.jd"\nload "./a.jd"\nload "b.jd"'),
            { title: 'Organize loads', only: ORGANIZE }
        );
        expect(after.startsWith('load "./a.jd"\nload "./b.jd"\njustification J')).toBe(true);
    });

    test('keeps namespaced loads and their aliases', async () => {
        const after = await applyCodeAction(
            withLoads('load "b.jd" as second\nload "a.jd" as first'),
            { title: 'Organize loads', only: ORGANIZE }
        );
        expect(after.startsWith('load "./a.jd" as first\nload "./b.jd" as second')).toBe(true);
    });

    test('two aliases of one file are two bindings, not a repetition', async () => {
        const after = await applyCodeAction(
            withLoads('load "a.jd" as second\nload "a.jd" as first'),
            { title: 'Organize loads', only: ORGANIZE }
        );
        expect(after.startsWith('load "./a.jd" as first\nload "./a.jd" as second')).toBe(true);
    });

    test('sorts paths that climb out of the directory below local ones', async () => {
        const after = await applyCodeAction(
            withLoads('load "../shared/base.jd"\nload "./local.jd"'),
            { title: 'Organize loads', only: ORGANIZE }
        );
        expect(after.startsWith('load "./local.jd"\nload "../shared/base.jd"')).toBe(true);
    });

    test('is not offered when the block is already canonical', async () => {
        expect(await actionTitles(withLoads('load "./a.jd"\nload "./b.jd"'), ORGANIZE)).toEqual([]);
    });

    // A comment above a load is about that load; reordering would leave it describing whatever
    // moved into its place, with nothing on screen to say so.
    test('refuses when a comment sits inside the block', async () => {
        expect(await actionTitles(
            withLoads('load "b.jd"\n// the base model\nload "a.jd"'),
            ORGANIZE
        )).toEqual([]);
    });

    // Halfway through typing a path is exactly when a file has a broken load in it.
    test('keeps a load whose path resolves to nothing', async () => {
        const after = await applyCodeAction(
            withLoads('load "z.jd"\nload "a.jd"'),
            { title: 'Organize loads', only: ORGANIZE }
        );
        expect(after).toContain('load "./z.jd"');
        expect(after).toContain('load "./a.jd"');
    });
});

describe('convert-model-kind', () => {

    test('turns a justification into a template', async () => {
        const after = await applyCodeAction(
            `justification ${CURSOR}J {\n    conclusion c is "C"\n}`,
            { title: 'Convert to template' }
        );
        expect(after.startsWith('template J {')).toBe(true);
    });

    test('turns a template with no @support into a justification, silently', async () => {
        expect(await actionTitles(`template ${CURSOR}T {\n    conclusion c is "C"\n}`, CodeActionKind.Refactor))
            .toContain('Convert to justification');
    });

    // The count is in the title because the alternative is an action that reads as a rename and
    // turns out to be a deletion.
    test('says how many @support elements a conversion would drop', async () => {
        const titles = await actionTitles(
            `template ${CURSOR}T {\n    @support a is "A"\n    @support b is "B"\n    conclusion c is "C"\n    strategy s is "S"\n    a supports s\n    b supports s\n    s supports c\n}`,
            CodeActionKind.Refactor
        );
        expect(titles).toContain('Convert to justification (drops 2 @support elements)');
    });

    test('the conversion removes those elements and the relations naming them', async () => {
        const after = await applyCodeAction(
            `template ${CURSOR}T {\n    @support a is "A"\n    conclusion c is "C"\n    strategy s is "S"\n    a supports s\n    s supports c\n}`,
            { title: 'Convert to justification (drops 1 @support element)' }
        );
        expect(after).toBe('justification T {\n    conclusion c is "C"\n    strategy s is "S"\n    s supports c\n}');
    });

    // A composed model's kind follows from its sources, so there is no keyword to switch.
    test('is not offered on a composition', async () => {
        expect(await actionTitles(
            `justification A {\n    conclusion c is "C"\n}\njustification ${CURSOR}B is assemble(A) { conclusionLabel: "C" strategyLabel: "S" }`,
            CodeActionKind.Refactor
        )).not.toContain('Convert to template');
    });

    test('is not offered with the cursor outside any model', async () => {
        expect(await actionTitles(`${CURSOR}\njustification J {\n    conclusion c is "C"\n}`, CodeActionKind.Refactor))
            .toEqual([]);
    });
});

describe('sort-elements', () => {

    test('puts the grounds first and the claim last', async () => {
        const after = await applyCodeAction(
            `justification ${CURSOR}J {\n    conclusion c is "C"\n    evidence e is "E"\n    strategy s is "S"\n    e supports s\n    s supports c\n}`,
            { title: 'Sort elements' }
        );
        expect(after).toBe('justification J {\n    evidence e is "E"\n    strategy s is "S"\n    conclusion c is "C"\n    e supports s\n    s supports c\n}');
    });

    test('leaves the relations where they are', async () => {
        const after = await applyCodeAction(
            `justification ${CURSOR}J {\n    conclusion c is "C"\n    evidence e is "E"\n    strategy s is "S"\n    e supports s\n    s supports c\n}`,
            { title: 'Sort elements' }
        );
        const lines = after.split('\n').map(l => l.trim());
        expect(lines.slice(-3, -1)).toEqual(['e supports s', 's supports c']);
    });

    test('is not offered when the declarations are already in order', async () => {
        expect(await actionTitles(
            `justification ${CURSOR}J {\n    evidence e is "E"\n    strategy s is "S"\n    conclusion c is "C"\n    e supports s\n    s supports c\n}`,
            CodeActionKind.Refactor
        )).not.toContain('Sort elements');
    });

    test('refuses when a comment sits among the declarations', async () => {
        expect(await actionTitles(
            `justification ${CURSOR}J {\n    conclusion c is "C"\n    // the ground\n    evidence e is "E"\n    strategy s is "S"\n    e supports s\n    s supports c\n}`,
            CodeActionKind.Refactor
        )).not.toContain('Sort elements');
    });

    test('keeps the order the author chose within a group', async () => {
        const after = await applyCodeAction(
            `justification ${CURSOR}J {\n    conclusion c is "C"\n    evidence second is "Second"\n    evidence first is "First"\n    strategy s is "S"\n    second supports s\n    s supports c\n}`,
            { title: 'Sort elements' }
        );
        const lines = after.split('\n').map(l => l.trim());
        expect(lines.indexOf('evidence second is "Second"'))
            .toBeLessThan(lines.indexOf('evidence first is "First"'));
    });
});
