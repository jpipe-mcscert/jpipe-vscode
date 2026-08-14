/**
 * Which editor column to open a diagnostic's source in.
 *
 * The preview used to lock its own editor group, and this choice was hardcoded to column one on
 * the strength of it: preview beside, therefore model on the left. That was wrong whenever the
 * model was not on the left — in a three-column layout, clicking a diagnostic row opened the
 * source over whatever occupied the first column. Dropping the lock removes the excuse for the
 * assumption but not the assumption, so the choice is made here, from what is actually on screen
 * (jpipe-vscode ADR-VSC-0019).
 *
 * A webview panel is not a text editor and never appears among the visible ones, so *any* column
 * this sees is a column holding text — which is what makes "reuse a column that already has an
 * editor in it" a safe rule rather than a guess, and what keeps the source from landing on top of
 * the diagram.
 */

/** What choosing a column needs to know about one visible text editor. */
export interface VisibleEditor {
    /** Its column, or undefined when it sits outside the main grid. */
    column: number | undefined;
    /** Whether it already shows the document being revealed. */
    showsTarget: boolean;
    /** Whether it holds a jPipe model. */
    isModel: boolean;
}

/**
 * The column VS Code's own first column is numbered with, and the answer when nothing is visible.
 *
 * Passing no column at all would be worse than guessing: `showTextDocument` would fall back to the
 * active column, and when the click came from the panel that is the panel's own column — putting
 * the source exactly where the diagram is.
 */
const FIRST = 1;

/**
 * Pick the column, preferring in order: where the document already is, where the model is,
 * anywhere else that holds text.
 *
 * Reusing the target's own column comes first because a file the user already has open should be
 * revealed where they left it, not moved. The model's column comes next as the best available
 * reading of "the text side" of a split.
 */
export function chooseRevealColumn(editors: readonly VisibleEditor[]): number {
    return columnOf(editors, e => e.showsTarget)
        ?? columnOf(editors, e => e.isModel)
        ?? columnOf(editors, () => true)
        ?? FIRST;
}

/** The column of the first editor matching `predicate` that has one. */
function columnOf(
    editors: readonly VisibleEditor[],
    predicate: (editor: VisibleEditor) => boolean
): number | undefined {
    return editors.find(e => predicate(e) && e.column !== undefined)?.column;
}
