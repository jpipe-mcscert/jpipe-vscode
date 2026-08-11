/**
 * Finding the innermost LSP document symbol containing a cursor.
 *
 * Split out of `preview-provider.ts` for the reason `preview-refresh.ts` and `export-target.ts`
 * were: it needs nothing from the editor. Everything here is arithmetic over the shape the
 * language server sends back, so unlike most of the panel it can be — and now is — tested.
 *
 * This drives the highlight in the preview: the name returned here is matched against the node
 * ids in the compiler's SVG, so picking the wrong symbol highlights the wrong box, and picking
 * none leaves the diagram looking inert while the cursor moves through it.
 */

/**
 * The part of the LSP `DocumentSymbol` this needs.
 *
 * Declared structurally rather than imported from `vscode`: the values arrive over the wire from
 * the language server as plain JSON, and describing them as data is what keeps this module
 * loadable outside an extension host (jpipe-vscode ADR-VSC-0004).
 */
export interface DocumentSymbol {
    name: string;
    range: SymbolRange;
    children?: DocumentSymbol[];
}

export interface SymbolRange {
    start: { line: number; character: number };
    end: { line: number; character: number };
}

/** Whether `range` covers the given zero-based position, inclusive at both ends. */
function rangeContains(range: SymbolRange, line: number, character: number): boolean {
    const { start, end } = range;
    if (line < start.line || line > end.line) return false;
    if (line === start.line && character < start.character) return false;
    if (line === end.line && character > end.character) return false;
    return true;
}

/**
 * Whether `a` covers less ground than `b` — the test for "more specific".
 *
 * Compared lines first, then characters, rather than by the weighted sum
 * `lineSpan * 10000 + charSpan` this replaces. That weight was doing two jobs badly: a line
 * longer than its weight let the character term bleed into the line term and rank an outer
 * symbol as the inner one, and a range spanning lines has a *negative* character span whenever
 * it ends left of where it starts, which the sum then quietly folded in. Comparing the two
 * components in order needs no magic number and cannot mix them up.
 */
function isSmaller(a: SymbolRange, b: SymbolRange): boolean {
    const linesA = a.end.line - a.start.line;
    const linesB = b.end.line - b.start.line;
    if (linesA !== linesB) return linesA < linesB;
    return (a.end.character - a.start.character) < (b.end.character - b.start.character);
}

/**
 * The most specific symbol containing the position, or null if none does.
 *
 * Descends into children, so in a `.jd` file the cursor inside an evidence declaration yields
 * that evidence rather than the justification wrapping it — which is the point, since the
 * enclosing model is not a node in the diagram and highlighting it would highlight everything.
 *
 * Siblings are allowed to overlap: rather than take the first hit, every containing symbol is
 * considered and the smallest wins. The language server has no obligation to send them in any
 * particular order, and a parse in progress can produce ranges that genuinely do overlap.
 */
export function symbolAtPosition(
    symbols: readonly DocumentSymbol[],
    line: number,
    character: number
): DocumentSymbol | null {
    let best: DocumentSymbol | null = null;
    for (const symbol of symbols) {
        if (!rangeContains(symbol.range, line, character)) continue;
        const child = symbol.children?.length
            ? symbolAtPosition(symbol.children, line, character)
            : null;
        const chosen = child ?? symbol;
        if (!best || isSmaller(chosen.range, best.range)) best = chosen;
    }
    return best;
}
