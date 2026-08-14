/**
 * Choosing the column a diagnostic's source opens in.
 *
 * This replaces a hardcoded `ViewColumn.One`, which was only ever right when the model happened
 * to sit in the first column — in a three-column layout it opened the source over whatever was on
 * the left (jpipe-vscode ADR-VSC-0019). The rule is small enough to state and easy enough to get
 * backwards, and `preview-provider.ts` cannot be loaded by any test, so it lives here.
 *
 * A webview panel is never among the visible *text* editors, so every column reaching this
 * function holds text. That is the fact the whole rule rests on.
 */
import { describe, expect, test } from 'vitest';
import { chooseRevealColumn, type VisibleEditor } from '../src/extension/preview/reveal-column.js';

/** A visible text editor, described the way the chooser sees one. */
function editor(column: number | undefined, extra: Partial<VisibleEditor> = {}): VisibleEditor {
    return { column, showsTarget: false, isModel: false, ...extra };
}

describe('choosing where to reveal a source', () => {

    // Nothing on screen to reason from. Column one is a guess, but the alternative — passing no
    // column — is worse: `showTextDocument` would fall back to the active column, which when the
    // click came from the panel is the panel's own.
    test('falls back to the first column when nothing is visible', () => {
        expect(chooseRevealColumn([])).toBe(1);
    });

    test('uses the only visible editor, wherever it is', () => {
        expect(chooseRevealColumn([editor(2, { isModel: true })])).toBe(2);
    });

    /**
     * The reported case. Another file on the left, the model in the middle, the preview on the
     * right: the old code opened the source in column one, over the unrelated file.
     */
    test('prefers the column holding the model over the first column', () => {
        expect(chooseRevealColumn([
            editor(1),
            editor(2, { isModel: true })
        ])).toBe(2);
    });

    // A file the user already has open should be revealed where they left it, not moved across
    // the window — so this outranks even the model's own column.
    test('reveals a document that is already open where it already is', () => {
        expect(chooseRevealColumn([
            editor(1, { showsTarget: true }),
            editor(2, { isModel: true })
        ])).toBe(1);
    });

    // A `load`ed file's diagnostic names a document that is itself a model, so both flags land on
    // the same editor. The target rule still wins, which is the same answer either way here — the
    // point is that the two rules do not fight.
    test('the target rule wins when the target is itself a model', () => {
        expect(chooseRevealColumn([
            editor(1, { isModel: true }),
            editor(3, { isModel: true, showsTarget: true })
        ])).toBe(3);
    });

    // No model is visible — the user closed it, or the report outlived it. Any column with text
    // in it still beats guessing, because none of them is the preview's.
    test('falls back to any visible editor when no model is on screen', () => {
        expect(chooseRevealColumn([editor(3)])).toBe(3);
    });

    /**
     * `viewColumn` is undefined for an editor outside the main grid. Such an editor is a real
     * editor and passes every other test, so without the column check it would be chosen and its
     * missing column passed on as though it meant "wherever you like".
     */
    test('skips editors that have no column, at every level of the rule', () => {
        expect(chooseRevealColumn([
            editor(undefined, { showsTarget: true }),
            editor(2, { isModel: true })
        ])).toBe(2);
        expect(chooseRevealColumn([
            editor(undefined, { isModel: true }),
            editor(4)
        ])).toBe(4);
        expect(chooseRevealColumn([editor(undefined)])).toBe(1);
    });
});
