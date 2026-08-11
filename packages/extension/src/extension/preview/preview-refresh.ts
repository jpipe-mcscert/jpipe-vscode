/**
 * What the preview should do when the cursor moves.
 *
 * Split out of `preview-provider.ts` because that file imports `vscode` and so cannot be loaded
 * outside an extension host. The decision itself needs nothing from the editor — only where the
 * cursor now is and what the panel is currently showing — and it is worth testing, because it is
 * the difference between running the compiler on every keystroke and never running it at all.
 */

export type PreviewMode = 'diagram' | 'diagnostic';

/** Everything the decision depends on. */
export interface CursorContext {
    readonly mode: PreviewMode;
    /** The document the cursor is now in. */
    readonly documentUri: string;
    /** The document the panel is showing, if it has shown one. */
    readonly renderedUri: string | undefined;
    /** Whether the document has edits the compiler has not seen. */
    readonly unsaved: boolean;
    /** The diagram under the cursor, when the cursor is inside one. Diagram mode only. */
    readonly diagramAtCursor: string | undefined;
    /** The diagram the panel is showing. Diagram mode only. */
    readonly renderedDiagram: string | undefined;
}

export type CursorResponse =
    /** Run the compiler and replace what the panel is showing. */
    | 'render'
    /** Keep what is shown and move the highlight to follow the cursor. */
    | 'highlight'
    /** Leave the panel alone. */
    | 'nothing';

/**
 * Decides between re-rendering, following the cursor, and doing nothing.
 *
 * The costly branch is `render`, which runs the external compiler — so the rule is to take it
 * only when what the panel shows has actually gone out of date:
 *
 * - **A different file** is a different report and a different set of diagrams, in either mode.
 *   In diagnostic mode this is the whole of it: a report cannot change as the cursor moves
 *   *within* a file, so everything else there is a highlight.
 * - **A different diagram** in the same file matters only in diagram mode, which is the one mode
 *   showing a single diagram at a time.
 * - **Unsaved edits** hold back a diagram re-render, because the compiler would be asked to draw
 *   a file it cannot see and the panel would flick to an older picture. A *report* is still worth
 *   running, since the panel says plainly that it describes the last saved version — and refusing
 *   would leave the previous file's report on screen, which says nothing true at all.
 */
export function responseToCursorMove(context: CursorContext): CursorResponse {
    const movedFile = context.documentUri !== context.renderedUri;

    if (context.mode === 'diagnostic') {
        return movedFile ? 'render' : 'highlight';
    }

    if (movedFile) {
        return context.unsaved ? 'nothing' : 'render';
    }

    const movedDiagram = context.diagramAtCursor !== undefined
        && context.diagramAtCursor !== context.renderedDiagram;
    return movedDiagram && !context.unsaved ? 'render' : 'highlight';
}
