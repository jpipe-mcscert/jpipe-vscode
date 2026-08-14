/**
 * Format Document, for `.jd`.
 *
 * The layout itself is `jpipe-layout.ts`; this is the LSP end of it. Binding this service is the
 * whole of the registration — Langium advertises `documentFormattingProvider` and
 * `documentRangeFormattingProvider` from the fact that a `Formatter` exists.
 *
 * It implements the `Formatter` interface rather than extending `AbstractFormatter`. The abstract
 * base builds its edits by declaring what should sit between one token and the next, which is a
 * different thing from what the house layout does: the layout rewrites whole lines, and it is
 * defined as much by what it refuses to move — a blank line, a trailing comment, a model written
 * on one line — as by what it changes. Those refusals are not expressible as token spacing.
 *
 * The layout declines outright on a file that does not parse, so a half-typed file formats to
 * nothing rather than to something confident and wrong.
 */
import type { LangiumDocument } from 'langium';
import type { Formatter } from 'langium/lsp';
import type {
    DocumentFormattingParams,
    DocumentOnTypeFormattingOptions,
    DocumentRangeFormattingParams,
    TextEdit
} from 'vscode-languageserver';
import type { Unit } from './generated/ast.js';
import { indentUnitOf, layoutEdits } from './jpipe-layout.js';

export class JpipeFormatter implements Formatter {

    formatDocument(document: LangiumDocument, params: DocumentFormattingParams): TextEdit[] {
        return layoutEdits(document as LangiumDocument<Unit>, indentUnitOf(params.options));
    }

    /**
     * Format Selection: the whole-document layout, kept back to the lines asked for.
     *
     * Laying the selection out *in isolation* would give a different answer, because the columns
     * a declaration lines up to are a property of the run it belongs to, not of the selection —
     * formatting three lines out of a run of six would pad them to their own widest id and leave
     * the run split down the middle. So the document is laid out and the edits outside the range
     * are dropped.
     *
     * Ranges are read by line, since every edit the layout produces spans one: half a line
     * selected still means that line. A range ending at character zero has not reached the line
     * it names, which is what a selection dragged to the start of the next line looks like.
     */
    formatDocumentRange(document: LangiumDocument, params: DocumentRangeFormattingParams): TextEdit[] {
        const { start, end } = params.range;
        const last = end.character === 0 ? end.line - 1 : end.line;
        return this.formatDocument(document, params)
            .filter(edit => edit.range.start.line >= start.line && edit.range.end.line <= last);
    }

    /**
     * Nothing. Re-aligning a run costs every line in it a rewrite, and doing that on a keystroke
     * moves the text out from under the cursor of whoever is still typing the id it aligned to.
     */
    formatDocumentOnType(): TextEdit[] {
        return [];
    }

    /** `undefined` keeps `documentOnTypeFormattingProvider` off the wire entirely. */
    get formatOnTypeOptions(): DocumentOnTypeFormattingOptions | undefined {
        return undefined;
    }
}
