/**
 * Rename is worth testing at the level of the edits it produces, not the range it offers.
 *
 * Langium's rename works by collecting a declaration's references and rewriting each one. The
 * declaration itself only joins that set if `NameProvider.getNameNode` can point at its
 * identifier — and if it cannot, nothing fails and nothing warns: the rename simply comes back
 * one edit short, having renamed every usage and left the declaration behind. That is invisible
 * to any assertion about whether rename was *offered*, so every test here asserts on the change
 * set, and the model-name cases assert the declaration's own line is in it.
 *
 * The qualified-element cases assert a refusal. Those renames are not supported yet, and the
 * distinction that matters is between refusing and doing them wrongly.
 *
 * Renaming a *model* is asserted a third way, by applying the edits and validating the result.
 * A model's name reaches further than its references — an override says `T:abs` and no
 * cross-reference records that it means template `T` — so the failure to catch is not a missing
 * edit but a file that still parses and no longer means anything.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Diagnostic, type TextEdit } from 'vscode-languageserver';
import type { Unit } from 'jpipe-language';
import { createJpipeServices } from 'jpipe-language';

let services: ReturnType<typeof createJpipeServices>;
let parse: ReturnType<typeof parseHelper<Unit>>;

beforeAll(async () => {
    services = createJpipeServices(EmptyFileSystem);
    parse = parseHelper<Unit>(services.Jpipe);
});

/** Positions the cursor at the first occurrence of `needle`, offset `column` into it. */
async function at(source: string, needle: string, column = 0) {
    const document = await parse(source);
    const index = document.textDocument.getText().indexOf(needle);
    expect(index, `fixture does not contain '${needle}'`).toBeGreaterThanOrEqual(0);
    return {
        document,
        params: {
            textDocument: { uri: document.uri.toString() },
            position: document.textDocument.positionAt(index + column)
        }
    };
}

async function renameEdits(source: string, needle: string, column = 0, newName = 'NEW'): Promise<TextEdit[]> {
    const { document, params } = await at(source, needle, column);
    const edit = await services.Jpipe.lsp.RenameProvider!.rename(document, { ...params, newName });
    return edit?.changes?.[document.uri.toString()] ?? [];
}

async function isRenameOffered(source: string, needle: string, column = 0): Promise<boolean> {
    const { document, params } = await at(source, needle, column);
    return await services.Jpipe.lsp.RenameProvider!.prepareRename!(document, params) !== undefined;
}

/**
 * The message a declined rename puts in front of the user, or `undefined` if it declined silently.
 *
 * Both requests are asked, because a client may send `textDocument/rename` without preparing it
 * first — and a refusal that only holds on one of them is a refusal that can be walked past.
 */
async function refusal(source: string, needle: string, column = 0): Promise<string | undefined> {
    const { document, params } = await at(source, needle, column);
    const provider = services.Jpipe.lsp.RenameProvider!;
    const messages: Array<string | undefined> = [];
    for (const request of [
        () => provider.prepareRename!(document, params),
        () => provider.rename(document, { ...params, newName: 'NEW' })
    ]) {
        try {
            expect(await request(), 'declined requests return nothing').toBeUndefined();
            messages.push(undefined);
        } catch (error) {
            messages.push((error as Error).message);
        }
    }
    expect(messages[0], 'prepare and rename decline alike').toBe(messages[1]);
    return messages[0];
}

/** The source text each edit replaces, so assertions read as what the user sees. */
function replaced(source: string, edits: TextEdit[]): string[] {
    const lines = source.split('\n');
    return edits.map(e => lines[e.range.start.line].slice(e.range.start.character, e.range.end.character));
}

/** The file as it stands once the rename is accepted. */
async function renamed(source: string, needle: string, column = 0, newName = 'NEW'): Promise<string> {
    const edits = await renameEdits(source, needle, column, newName);
    return TextDocument.applyEdits(TextDocument.create('mem://x.jd', 'jpipe', 0, source), edits);
}

/** Validation errors in a model, as messages — the check that a rename left it meaning something. */
async function errorsIn(source: string): Promise<string[]> {
    const document = await parse(source, { validation: true });
    return (document.diagnostics ?? [])
        .filter(d => d.severity === 1)
        .map(d => Diagnostic.getMessageString(d));
}

const TEMPLATE_AND_USER = `template T { @support a is "A" }
justification J implements T { evidence T:a is "A" }`;

/** A template, an implementation that overrides through it, and a composition naming both. */
const TEMPLATE_IN_USE = `template T {
 @support a is "A"
 strategy s is "S"
 conclusion c is "C"
 a supports s
 s supports c
}
justification J implements T {
 evidence T:a is "Signed off"
 T:a supports T:s
}
justification K is assemble(J, T) { conclusionLabel: "All of it" strategyLabel: "Together" }`;

const LOCAL_ELEMENTS = `justification J { conclusion c is "C" strategy s is "S" evidence e is "E"
 e supports s
 s supports c }`;

describe('Rename', () => {

    describe('model names', () => {

        // The regression this file exists for: before `getNameNode` handled string ids, this
        // returned a single edit — the `implements T` usage — and silently left `template T`
        // untouched, so accepting the rename produced a justification implementing nothing.
        test('renaming from a reference also rewrites the declaration', async () => {
            const edits = await renameEdits(TEMPLATE_AND_USER, 'implements T', 'implements '.length);
            // The declaration, the `implements` reference, and the override's qualifier.
            expect(replaced(TEMPLATE_AND_USER, edits)).toEqual(['T', 'T', 'T']);
            // Line 0 is `template T` — the declaration.
            expect(edits.some(e => e.range.start.line === 0)).toBe(true);
            expect(edits.every(e => e.newText === 'NEW')).toBe(true);
        });

        test('renaming from the declaration also rewrites the reference', async () => {
            const edits = await renameEdits(TEMPLATE_AND_USER, 'template T', 'template '.length);
            expect(edits.some(e => e.range.start.line === 0)).toBe(true);
            expect(edits.some(e => e.range.start.line === 1)).toBe(true);
        });
    });

    /**
     * The reported bug. A template's name is written into every override that refines it and every
     * relation that names one, and none of those is a cross-reference to the template — so a
     * rename that follows references alone renames the declaration out from under them.
     */
    describe('a template name used as a qualifier', () => {

        test('the fixture is a model with nothing wrong with it', async () => {
            expect(await errorsIn(TEMPLATE_IN_USE)).toEqual([]);
        });

        test('overrides, relations and composition parameters all follow the template', async () => {
            const after = await renamed(TEMPLATE_IN_USE, 'template T', 'template '.length, 'Signoff');
            expect(after).toContain('template Signoff {');
            expect(after).toContain('justification J implements Signoff {');
            expect(after).toContain('evidence Signoff:a is "Signed off"');
            expect(after).toContain('Signoff:a supports Signoff:s');
            expect(after).toContain('assemble(J, Signoff)');
            expect(after, 'no occurrence of the old name survives').not.toMatch(/\bT\b/);
        });

        // The assertion the others exist for: renaming is only correct if what comes out still
        // means what went in, and every check above could pass on a model that no longer links.
        test('the renamed model still validates', async () => {
            expect(await errorsIn(await renamed(TEMPLATE_IN_USE, 'template T', 'template '.length, 'Signoff'))).toEqual([]);
        });

        test('renaming from the `implements` reference reaches just as far', async () => {
            const fromReference = await renamed(TEMPLATE_IN_USE, 'implements T', 'implements '.length, 'Signoff');
            const fromDeclaration = await renamed(TEMPLATE_IN_USE, 'template T', 'template '.length, 'Signoff');
            expect(fromReference).toBe(fromDeclaration);
        });

        // The mirror of the case above, on the other side of the rule. `T:a` in a position that
        // takes a *model* names no model at all, so the rename leaves the broken reference broken
        // instead of rewriting half of it into something that looks repaired.
        test('a model reference with a segment too many is left alone', async () => {
            const source = `template T { @support a is "A" }
justification K is assemble(T:a) { conclusionLabel: "X" strategyLabel: "Y" }`;
            const after = await renamed(source, 'template T', 'template '.length);
            expect(after).toContain('template NEW {');
            expect(after).toContain('assemble(T:a)');
        });

        // The qualifier rewrite keys on the name introducing *something else*. An element called
        // `T` is its own name, not a use of the template's.
        test('an element that merely shares the template name is left alone', async () => {
            const source = `template T { @support a is "A" }
justification J implements T { evidence T:a is "A" strategy T is "S" }`;
            const after = await renamed(source, 'template T', 'template '.length);
            expect(after).toContain('evidence NEW:a is "A"');
            expect(after).toContain('strategy T is "S"');
        });
    });

    describe('unqualified elements', () => {

        test('renaming from a relation rewrites the declaration and the relation', async () => {
            const edits = await renameEdits(LOCAL_ELEMENTS, 'e supports s');
            expect(edits).toHaveLength(2);
            expect(replaced(LOCAL_ELEMENTS, edits)).toEqual(['e', 'e']);
            expect(edits.some(e => e.range.start.line === 0)).toBe(true);
        });

        /**
         * An element's id is a nested `QualifiedId`, so the cursor's CST leaf belongs to *that*
         * node rather than to the element. Langium's resolution stopped there and found nothing to
         * rename — which made an element renameable from every relation naming it and not from the
         * line declaring it.
         */
        test('renaming from the declaration reaches just as far as from a relation', async () => {
            expect(await isRenameOffered(LOCAL_ELEMENTS, 'evidence e', 'evidence '.length)).toBe(true);
            expect(await renamed(LOCAL_ELEMENTS, 'evidence e', 'evidence '.length))
                .toBe(await renamed(LOCAL_ELEMENTS, 'e supports s'));
        });
    });

    /**
     * An `@support` names something every implementer has to restate, so its name is the one name
     * in a model that other files are obliged to spell out. Renaming it has to carry to all of
     * them, and renaming it *from* one of them has to be declined — the restatement is not where
     * the name lives.
     */
    describe('an element name used through a template', () => {

        const OVERRIDDEN = `template T {
 @support abs is "An abstract support"
 strategy s is "S"
 conclusion c is "C"
 abs supports s
 s supports c
}
justification J implements T {
 evidence T:abs is "Direct evidence"
}
justification K implements T {
 sub-conclusion T:abs is "An intermediate step"
 strategy s2 is "S2"
 evidence e2 is "E2"
 s2 supports T:abs
 e2 supports s2
}`;

        test('the fixture is a set of models with nothing wrong with them', async () => {
            expect(await errorsIn(OVERRIDDEN)).toEqual([]);
        });

        test('renaming the @support carries to every override and every relation naming one', async () => {
            const after = await renamed(OVERRIDDEN, '@support abs', '@support '.length, 'signoff');
            expect(after).toContain('@support signoff is');
            expect(after).toContain('signoff supports s');
            expect(after).toContain('evidence T:signoff is');
            expect(after).toContain('sub-conclusion T:signoff is');
            expect(after).toContain('s2 supports T:signoff');
            expect(after, 'no occurrence of the old name survives').not.toMatch(/\babs\b/);
        });

        test('the renamed models still validate', async () => {
            expect(await errorsIn(await renamed(OVERRIDDEN, '@support abs', '@support '.length, 'signoff'))).toEqual([]);
        });

        test('renaming from a relation inside the template carries just as far', async () => {
            expect(await renamed(OVERRIDDEN, 'abs supports s', 0, 'signoff'))
                .toBe(await renamed(OVERRIDDEN, '@support abs', '@support '.length, 'signoff'));
        });

        /**
         * The scope provider registers each element under a short alias too, when that alias is
         * unambiguous — so a relation in the implementing model can say `abs` and mean the
         * override. Nothing about that spelling says which element it is; only the resolved
         * reference does.
         */
        test('a relation using the unqualified short alias follows too', async () => {
            const source = `template T {
 @support abs is "A"
 strategy s is "S"
 conclusion c is "C"
 abs supports s
 s supports c
}
justification J implements T {
 evidence T:abs is "E"
 abs supports s
}`;
            expect(await errorsIn(source), 'the fixture is a working model').toEqual([]);
            const after = await renamed(source, '@support abs', '@support '.length, 'signoff');
            expect(after).toContain('evidence T:signoff is "E"');
            expect(after).toContain(' signoff supports s\n');
            expect(await errorsIn(after)).toEqual([]);
        });

        /**
         * The other way round: while an `implements` line is being written, every relation in the
         * file below it is unresolved. Matching those by how they are spelled is what keeps a
         * half-finished file no more broken after the rename than before it.
         */
        test('a relation that does not resolve is matched by how it is spelled', async () => {
            const source = `template T {
 @support abs is "A"
 strategy s is "S"
 conclusion c is "C"
 abs supports s
 s supports c
}
justification J {
 conclusion c2 is "C2"
 strategy s2 is "S2"
 T:abs supports s2
 s2 supports c2
}`;
            const after = await renamed(source, '@support abs', '@support '.length, 'signoff');
            expect(after).toContain('T:signoff supports s2');
        });

        // A plain element of a template is restated the same way an `@support` is, the difference
        // being only that implementers may leave it alone.
        test('a template element that is not a @support carries the same way', async () => {
            const source = `template T {
 @support abs is "A"
 strategy s is "S"
 conclusion c is "C"
 abs supports s
 s supports c
}
justification J implements T {
 evidence T:abs is "E"
 strategy T:s is "A sharper strategy"
}`;
            const after = await renamed(source, 'strategy s is', 'strategy '.length, 'ground');
            expect(after).toContain('strategy ground is "S"');
            expect(after).toContain('strategy T:ground is "A sharper strategy"');
        });
    });

    /**
     * A hook is the third way this grammar writes a name that no link records, after the override
     * and the relation — and the least visible, because it is inside a string. A rename that misses
     * it leaves a model that parses, reads correctly, and dies in the compiler.
     */
    describe('a refine hook naming the renamed element', () => {

        const REF = `justification Ref {
 conclusion rc is "RC"
 strategy rs is "RS"
 evidence re is "RE"
 re supports rs
 rs supports rc
}`;

        const HOOKED = `justification Base {
 conclusion c is "C"
 strategy s is "S"
 evidence e is "E"
 e supports s
 s supports c
}
${REF}
justification R is refine(Base, Ref) { hook: "e" }`;

        test('the hook follows the element', async () => {
            expect(await renamed(HOOKED, 'evidence e', 9, 'signed'))
                .toContain('hook: "signed"');
        });

        // The edit reaches inside the literal: replacing the whole token would work here and
        // would quietly eat the quotes the moment the name were qualified.
        test('the quotes are left where they were', async () => {
            expect(await renamed(HOOKED, 'evidence e', 9, 'signed'))
                .toContain('justification R is refine(Base, Ref) { hook: "signed" }');
            expect(replaced(HOOKED, await renameEdits(HOOKED, 'evidence e', 9, 'signed')))
                .not.toContain('"e"');
        });

        // Renaming the `@support` renames every override of it, and the hook resolves to one of
        // them through the compiler's suffix fallback — so it has to move with them.
        const THROUGH_TEMPLATE = `template T {
 @support a is "A"
 strategy s is "S"
 conclusion c is "C"
 a supports s
 s supports c
}
justification Base implements T { evidence T:a is "Signed" }
${REF}
justification R is refine(Base, Ref) { hook: "HOOKTEXT" }`;

        test('a qualified hook keeps its qualifier', async () => {
            const source = THROUGH_TEMPLATE.replace('HOOKTEXT', 'T:a');
            expect(await renamed(source, '@support a', 9, 'signed'))
                .toContain('hook: "T:signed"');
        });

        test('a bare hook naming a qualified element is rewritten bare', async () => {
            const source = THROUGH_TEMPLATE.replace('HOOKTEXT', 'a');
            expect(await renamed(source, '@support a', 9, 'signed'))
                .toContain('hook: "signed"');
        });

        // Spelling alone could not tell these apart: both hooks say "e", and only one of them
        // resolves to the element being renamed.
        test('a same-named element of another model is not dragged along', async () => {
            const source = `${HOOKED}
justification Other {
 conclusion oc is "OC"
 strategy os is "OS"
 evidence e is "E"
 e supports os
 os supports oc
}
justification R2 is refine(Other, Ref) { hook: "e" }`;
            const result = await renamed(source, 'evidence e', 9, 'signed');
            expect(result).toContain('hook: "signed"');
            expect(result).toContain('hook: "e"');
        });
    });

    describe('an override is renamed at the template, not where it is restated', () => {

        const QUALIFIED_RELATION = `template T { @support a is "A" }
justification J implements T { evidence T:a is "A" conclusion c is "C" strategy s is "S"
 T:a supports s
 s supports c }`;

        test.each([
            ['the qualifier segment', 0],
            ['the local segment', 2]
        ])('rename is declined on %s of a qualified reference, and says why', async (_label, column) => {
            expect(await refusal(QUALIFIED_RELATION, 'T:a supports', column))
                .toContain(`restates '@support a' in template 'T'`);
        });

        test('rename is declined on a qualified override declaration, and says why', async () => {
            const message = await refusal(TEMPLATE_AND_USER, 'T:a is');
            expect(message).toContain(`'T:a' restates '@support a' in template 'T'`);
            expect(message, 'the message says what to do instead').toContain('Rename it there');
        });

        // The template may be in a file this one only loads, or not resolve at all while the
        // `implements` is being typed. The refusal still has to name something.
        test('an override whose template cannot be resolved still says where the name lives', async () => {
            const message = await refusal('justification J implements Missing { evidence Missing:a is "A" }', 'Missing:a is');
            expect(message).toContain(`'a' in template 'Missing'`);
        });

        // The guard keys on the id's shape, not on the presence of a template, so a plain
        // element must stay renameable.
        test('an unqualified element in the same file is still renameable', async () => {
            expect(await isRenameOffered(LOCAL_ELEMENTS, 'e supports s')).toBe(true);
        });
    });
});
