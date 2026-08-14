/**
 * The house layout: nesting by braces, and columns that line up.
 *
 * The convention comes from the compiler's own examples, where a run of declarations is padded so
 * that the ids start together and the `is` keywords start together:
 *
 * ```
 * conclusion c   is "A conclusion"
 * strategy   s   is "A strategy"
 * @support   abs is "An abstract support"
 * ```
 *
 * and a run of relations lines its supporters up the same way. The point is that a body then reads
 * down its columns — every label in one place, every supported element in another — which is what
 * makes a forty-element argument scannable at all.
 *
 * **This rewrites lines; it never moves content between them.** Every declaration keeps the line
 * it was written on, every comment keeps its place beside the thing it describes, and blank lines
 * are left exactly as they are — a blank line is how a body is divided into sub-arguments, and
 * a formatter that normalises them away destroys information the author put there. So a model
 * written entirely on one line comes back on one line, correctly indented and no more; splitting
 * it is a different operation from indenting it, and this is the one that was asked for.
 *
 * Depth comes from the brace *tokens*, never from scanning the text: a label is a string, a string
 * may contain a brace, and a formatter that counts those indents the rest of the file wrongly.
 *
 * **Indentation and alignment are not the same character.** The unit a level is indented by is
 * the editor's — a tab where the editor uses tabs — but the padding that lines the columns up is
 * always spaces, because a tab advances to the next tab stop rather than by a width and so cannot
 * line anything up. That is the ordinary "tabs to indent, spaces to align" rule, and it is why
 * `body` below does not take the indent unit.
 *
 * Pure over a document — no services — so it is testable without a workspace.
 */
import { CstUtils, GrammarUtils, isLeafCstNode, type AstNode, type CstNode, type LangiumDocument, type Reference } from 'langium';
import type { FormattingOptions, TextEdit } from 'vscode-languageserver';
import type { JustificationElement, Unit } from './generated/ast.js';
import { keywordFor } from './jpipe-render.js';
import { qualifiedIdText } from './jpipe-utils.js';
import { modelsOf, segmentNodes } from './jpipe-qualified-names.js';

/** One level of nesting. The examples use four spaces, so this does. */
export const INDENT_UNIT = '    ';

/**
 * One level of nesting as the editor asks for it, or the house four spaces where it has not.
 *
 * A `tabSize` of zero would silently flatten the file, so it is treated as no answer rather than
 * as an answer of none.
 */
export function indentUnitOf(options?: FormattingOptions): string {
    if (!options) return INDENT_UNIT;
    if (!options.insertSpaces) return '\t';
    return options.tabSize > 0 ? ' '.repeat(options.tabSize) : INDENT_UNIT;
}

/** A line holding exactly one declaration, in the pieces the columns are built from. */
type Piece =
    | { readonly kind: 'element'; readonly keyword: string; readonly id: string; readonly label: string }
    | { readonly kind: 'relation'; readonly from: string; readonly to: string }
    | { readonly kind: 'entry'; readonly key: string; readonly value: string };

interface Placed {
    readonly line: number;
    readonly piece: Piece;
    /** Whatever follows the declaration on its line — a trailing comment — carried across as written. */
    readonly tail: string;
}

/**
 * The edits that lay a document out in the house style, or `[]` if it already is.
 *
 * Declines outright on a file that does not parse. Depth and column widths are both read off the
 * syntax tree, and a tree that does not describe the whole file would indent the part it does
 * understand and leave the rest sitting at whatever column it happened to be at.
 */
export function layoutEdits(document: LangiumDocument<Unit>, unit: string = INDENT_UNIT): TextEdit[] {
    const root = document.parseResult.value.$cstNode;
    if (!root || document.parseResult.parserErrors.length > 0) return [];

    const lines = document.textDocument.getText().split('\n');
    const { indents, continuations } = readNesting(root, lines.length);
    const placed = placeDeclarations(document.parseResult.value, lines);
    const rendered = renderGroups(placed, indents, unit);

    const edits: TextEdit[] = [];
    for (let line = 0; line < lines.length; line++) {
        // A `\r` is not part of the line's content and must survive the rewrite.
        const content = lines[line].endsWith('\r') ? lines[line].slice(0, -1) : lines[line];
        if (continuations[line]) continue;

        const replacement = rendered.get(line)
            ?? plainLine(content, indents[line], unit);
        if (replacement === undefined || replacement === content) continue;

        edits.push({
            range: { start: { line, character: 0 }, end: { line, character: content.length } },
            newText: replacement
        });
    }
    return edits;
}

/** A line carrying no declaration: re-indented, trailing whitespace dropped, otherwise as written. */
function plainLine(content: string, indent: number | undefined, unit: string): string | undefined {
    if (content.trim() === '') return '';
    // No token starts here and none spans into it, which only happens where the tree does not
    // describe the text. Leaving it alone is the honest answer.
    if (indent === undefined) return undefined;
    return unit.repeat(indent) + content.trim();
}

/**
 * The indent each line sits at, and which lines are the continuation of something that began
 * earlier.
 *
 * A line's depth is the brace depth at the token that opens it, less one when that token is the
 * closing brace itself — which is what puts `}` back under the line that opened it. Comments count
 * as line-openers, so a comment is indented with the code it introduces.
 */
function readNesting(root: CstNode, lineCount: number): {
    indents: Array<number | undefined>;
    continuations: boolean[];
} {
    const indents: Array<number | undefined> = new Array(lineCount).fill(undefined);
    const continuations: boolean[] = new Array(lineCount).fill(false);
    const opened = new Set<number>();

    let depth = 0;
    const leaves = [...CstUtils.streamCst(root)].filter(isLeafCstNode)
        .sort((left, right) => left.offset - right.offset);

    for (const leaf of leaves) {
        const first = leaf.range.start.line;
        if (!opened.has(first)) {
            opened.add(first);
            indents[first] = Math.max(0, depth - (leaf.text === '}' ? 1 : 0));
        }
        // A block comment, or a label containing a newline, owns the lines it runs through; they
        // are not lines anyone chose the indentation of.
        for (let line = first + 1; line <= leaf.range.end.line; line++) continuations[line] = true;

        // Only the brace *keywords* count. A string is a single leaf whose text carries its
        // quotes, so `"{"` can never be mistaken for one.
        if (leaf.text === '{') depth++;
        else if (leaf.text === '}') depth = Math.max(0, depth - 1);
    }
    return { indents, continuations };
}

/**
 * The declarations that own a line outright — the only ones whose columns can be moved.
 *
 * A declaration sharing its line with another, or running across two lines, is left as written:
 * there is no column to align it to that would not also disturb its neighbour.
 */
function placeDeclarations(unit: Unit, lines: string[]): Placed[] {
    const placed: Placed[] = [];

    const consider = (node: AstNode | undefined, piece: Piece | undefined) => {
        const cst = node?.$cstNode;
        if (!cst || !piece) return;
        if (cst.range.start.line !== cst.range.end.line) return;
        const line = lines[cst.range.start.line] ?? '';
        if (line.slice(0, cst.range.start.character).trim() !== '') return;
        placed.push({
            line: cst.range.start.line,
            piece,
            tail: line.slice(cst.range.end.character).replace(/\r$/, '').trimEnd()
        });
    };

    for (const model of modelsOf(unit)) {
        for (const element of model.contents?.body ?? []) {
            consider(element, elementPiece(element));
        }
        for (const relation of model.contents?.rels ?? []) {
            const from = referenceText(relation.from);
            const to = referenceText(relation.to);
            consider(relation, from && to ? { kind: 'relation', from, to } : undefined);
        }
        for (const entry of model.composition?.config?.entries ?? []) {
            const value = literalOf(entry, 'value');
            consider(entry, entry.key && value ? { kind: 'entry', key: entry.key, value } : undefined);
        }
    }
    return placed.sort((left, right) => left.line - right.line);
}

function elementPiece(element: JustificationElement): Piece | undefined {
    const id = qualifiedIdText(element.id);
    const label = literalOf(element, 'name');
    // Half-written, which is most of what a file looks like while it is being typed.
    if (!id || !label) return undefined;
    return { kind: 'element', keyword: keywordFor(element), id, label };
}

/**
 * A string as the author wrote it, quotes and all.
 *
 * The parsed value has had its quotes removed and its escapes resolved, so re-quoting it would
 * turn `'a label'` into `"a label"` and lose an escape along the way. Indentation is no business
 * of a label's.
 */
function literalOf(node: AstNode, property: string): string | undefined {
    return GrammarUtils.findNodeForProperty(node.$cstNode, property)?.text;
}

/** A reference in its canonical spelling, so `T : a` comes back as `T:a`. */
function referenceText(reference: Reference | undefined): string | undefined {
    const segments = segmentNodes(reference?.$refNode).map(segment => segment.text);
    return segments.length > 0 ? segments.join(':') : undefined;
}

/**
 * The rewritten text of every line holding a declaration.
 *
 * Columns are shared by a *run* of adjacent lines of the same kind, and nothing else — a blank
 * line, a comment, or a change from declarations to relations starts a new run. That is what keeps
 * the alignment local: one long id somewhere else in the body does not push a whole model's labels
 * across the screen, and each sub-argument lines up within itself.
 */
function renderGroups(placed: Placed[], indents: Array<number | undefined>, unit: string): Map<number, string> {
    const rendered = new Map<number, string>();

    for (let start = 0; start < placed.length;) {
        let end = start + 1;
        while (end < placed.length
            && placed[end].line === placed[end - 1].line + 1
            && placed[end].piece.kind === placed[start].piece.kind) end++;

        const group = placed.slice(start, end);
        const widths = {
            keyword: max(group, piece => piece.kind === 'element' ? piece.keyword.length : 0),
            id:      max(group, piece => piece.kind === 'element' ? piece.id.length : 0),
            from:    max(group, piece => piece.kind === 'relation' ? piece.from.length : 0),
            key:     max(group, piece => piece.kind === 'entry' ? piece.key.length + 1 : 0)
        };
        for (const item of group) {
            const indent = unit.repeat(indents[item.line] ?? 0);
            rendered.set(item.line, indent + body(item.piece, widths) + item.tail);
        }
        start = end;
    }
    return rendered;
}

function max(group: Placed[], of: (piece: Piece) => number): number {
    return group.reduce((widest, item) => Math.max(widest, of(item.piece)), 0);
}

function body(piece: Piece, widths: { keyword: number; id: number; from: number; key: number }): string {
    switch (piece.kind) {
        case 'element':
            return `${piece.keyword.padEnd(widths.keyword)} ${piece.id.padEnd(widths.id)} is ${piece.label}`;
        case 'relation':
            return `${piece.from.padEnd(widths.from)} supports ${piece.to}`;
        case 'entry':
            return `${(piece.key + ':').padEnd(widths.key)} ${piece.value}`;
    }
}
