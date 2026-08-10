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
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-types';
import {
    CONVERT_MODEL_KIND,
    EXTRACT_TEMPLATE_KIND,
    ORGANIZE_LOADS_KIND,
    SORT_ELEMENTS_KIND
} from 'jpipe-language';
import { CURSOR, actionTitles, applyCodeAction, parseValidated } from './code-action-helper.js';

const ORGANIZE = ORGANIZE_LOADS_KIND;

describe('organize-loads', () => {

    const withLoads = (block: string) => `${block}\njustification J {\n    conclusion c is "C"\n}`;

    test('sorts and de-duplicates in one edit', async () => {
        const after = await applyCodeAction(
            withLoads('load "b.jd"\nload "./a.jd"\nload "b.jd"'),
            { title: 'Organize loads', only: ORGANIZE }
        );
        expect(after.startsWith('load "./a.jd"\nload "b.jd"\njustification J')).toBe(true);
    });

    // `base.jd` and `./base.jd` mean the same thing, so rewriting one into the other would make
    // this action offer itself on nearly every file that already reads fine.
    test('leaves the path text as the author wrote it', async () => {
        const after = await applyCodeAction(
            withLoads('load "b.jd"\nload "a.jd"'),
            { title: 'Organize loads', only: ORGANIZE }
        );
        expect(after.startsWith('load "a.jd"\nload "b.jd"')).toBe(true);
    });

    test('is not offered merely because a path lacks a ./ prefix', async () => {
        expect(await actionTitles(withLoads('load "a.jd"\nload "b.jd"'), ORGANIZE)).toEqual([]);
    });

    test('keeps namespaced loads and their aliases', async () => {
        const after = await applyCodeAction(
            withLoads('load "b.jd" as second\nload "a.jd" as first'),
            { title: 'Organize loads', only: ORGANIZE }
        );
        expect(after.startsWith('load "a.jd" as first\nload "b.jd" as second')).toBe(true);
    });

    test('two aliases of one file are two bindings, not a repetition', async () => {
        const after = await applyCodeAction(
            withLoads('load "a.jd" as second\nload "a.jd" as first'),
            { title: 'Organize loads', only: ORGANIZE }
        );
        expect(after.startsWith('load "a.jd" as first\nload "a.jd" as second')).toBe(true);
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
        expect(after).toContain('load "z.jd"');
        expect(after).toContain('load "a.jd"');
    });
});

// The lightbulb asks with no filter; Refactor… asks for `refactor`; a command asks for one
// specific kind. All three have to reach these actions or the only way in is a shortcut.
describe('every route to a refactoring', () => {

    const MODEL = `justification ${CURSOR}J {
    conclusion c is "C"
    strategy s is "S"
    evidence e is "E"
    e supports s
    s supports c
}`;

    test.each([
        ['the lightbulb', undefined],
        ['Refactor…', CodeActionKind.Refactor]
    ])('%s offers all of them', async (_label, only) => {
        const titles = await actionTitles(MODEL, only);
        expect(titles).toContain('Convert to template');
        expect(titles).toContain('Sort elements');
        expect(titles).toContain("Extract template from 'J'");
    });

    test.each([
        [CONVERT_MODEL_KIND, 'Convert to template'],
        [SORT_ELEMENTS_KIND, 'Sort elements'],
        [EXTRACT_TEMPLATE_KIND, "Extract template from 'J'"]
    ])('a command asking for %s gets only that one', async (kind, expected) => {
        expect(await actionTitles(MODEL, kind)).toEqual([expected]);
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

describe('extract-template', () => {

    const ARGUMENT = `justification ${CURSOR}Release {
    conclusion ready is "Version 2.0 is ready to ship"
    strategy gates is "All release gates pass"
    evidence tested is "The suite is green"
    evidence documented is "The changelog is written"
    tested supports gates
    documented supports gates
    gates supports ready
}`;

    test('keeps the structure and turns the leaves into slots', async () => {
        const after = await applyCodeAction(ARGUMENT, { title: "Extract template from 'Release'" });
        expect(after).toContain('template ReleaseTemplate {');
        expect(after).toContain('conclusion ready is "Version 2.0 is ready to ship"');
        expect(after).toContain('strategy gates is "All release gates pass"');
        expect(after).toContain('@support tested is "The suite is green"');
        expect(after).toContain('@support documented is "The changelog is written"');
    });

    test('carries the relations into the template unchanged', async () => {
        const after = await applyCodeAction(ARGUMENT, { title: "Extract template from 'Release'" });
        expect(after).toContain('tested supports gates');
        expect(after).toContain('gates supports ready');
    });

    test('rewrites the justification to implement it, requalifying each override', async () => {
        const after = await applyCodeAction(ARGUMENT, { title: "Extract template from 'Release'" });
        expect(after).toContain('justification Release implements ReleaseTemplate {');
        expect(after).toContain('evidence ReleaseTemplate:tested is "The suite is green"');
        expect(after).toContain('evidence ReleaseTemplate:documented is "The changelog is written"');
    });

    // The whole point: the result has to be a model the compiler would accept.
    test('the result parses and reports no errors', async () => {
        const after = await applyCodeAction(ARGUMENT, { title: "Extract template from 'Release'" });
        const reparsed = await parseValidated(after);
        expect(reparsed.parseResult.parserErrors).toEqual([]);
        const errors = (reparsed.diagnostics ?? []).filter(d => d.severity === DiagnosticSeverity.Error);
        expect(errors.map(d => Diagnostic.getMessageString(d))).toEqual([]);
    });

    // Evidence with something under it is part of the structure, not a slot in it — and an
    // @support may only be refined by an evidence or a sub-conclusion, never by a sub-argument.
    test('abstracts only the evidence at the bottom of the argument', async () => {
        const after = await applyCodeAction(
            `justification ${CURSOR}J {
    conclusion c is "C"
    strategy top is "Top"
    sub-conclusion mid is "Mid"
    strategy lower is "Lower"
    evidence leaf is "Leaf"
    leaf supports lower
    lower supports mid
    mid supports top
    top supports c
}`,
            { title: "Extract template from 'J'" }
        );
        expect(after).toContain('@support leaf is "Leaf"');
        expect(after).toContain('sub-conclusion mid is "Mid"');
        expect(after).not.toContain('@support mid');
    });

    test('is not offered where there is no evidence to abstract', async () => {
        expect(await actionTitles(
            `justification ${CURSOR}J {\n    conclusion c is "C"\n    strategy s is "S"\n    s supports c\n}`,
            CodeActionKind.Refactor
        )).not.toContain("Extract template from 'J'");
    });

    test('is not offered on a model that already implements a template', async () => {
        expect(await actionTitles(
            `template T {\n    @support a is "A"\n    conclusion c is "C"\n    strategy s is "S"\n    a supports s\n    s supports c\n}\njustification ${CURSOR}J implements T {\n    evidence T:a is "A"\n}`,
            CodeActionKind.Refactor
        )).not.toContain("Extract template from 'J'");
    });

    test('is not offered on a composition', async () => {
        expect(await actionTitles(
            `justification A {\n    conclusion c is "C"\n}\njustification ${CURSOR}B is assemble(A) { conclusionLabel: "C" strategyLabel: "S" }`,
            CodeActionKind.Refactor
        )).not.toContain("Extract template from 'B'");
    });
});
