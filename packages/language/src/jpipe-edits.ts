/**
 * Building the text edits that jPipe features apply.
 *
 * Pure functions over a document — no services, no `CompletionContext` — because the same edit
 * has to be reachable from a completion item and from a code action. Anything that needs to know
 * *whether* to offer an edit stays with its caller; this file only knows how to write one.
 */
import * as path from 'node:path';
import { type CstNode, type LangiumDocument } from 'langium';
import { Position, type Range, type TextEdit } from 'vscode-languageserver';
import type { Justification, Template, Unit } from './generated/ast.js';

// ── load paths ───────────────────────────────────────────────────────────────────────────────

/** The path to write in a `load`, relative to the file declaring it, always `./`- or `../`-led. */
export function relativeLoadPath(sourcePath: string, targetPath: string): string {
    const relative = path.relative(path.dirname(sourcePath), targetPath).replaceAll('\\', '/');
    return relative.startsWith('../') ? relative : `./${relative}`;
}

/**
 * Reduces a load path to the form two paths can be compared in: no surrounding quotes, no
 * leading `./`, forward slashes throughout.
 */
export function normalizeLoadPath(filePath: string): string {
    return filePath
        .replaceAll(/^["']|["']$/g, '')
        .replaceAll(/^\.\//g, '')
        .replaceAll('\\', '/');
}

/** Whether the unit already loads the given path, comparing in normalized form. */
export function isLoaded(unit: Unit, relativePath: string): boolean {
    const wanted = normalizeLoadPath(relativePath);
    return unit.imports.some(load => normalizeLoadPath(load.path) === wanted);
}

/** Where a new `load` belongs, and what must follow it to keep the file readable. */
export interface LoadInsertion {
    /** Zero-based line to insert at, before whatever currently occupies it. */
    readonly line: number;
    /** Trailing newlines: one inside an existing block of loads, two to open one. */
    readonly suffix: string;
}

/**
 * Decides where a `load` should go: after the last existing one, otherwise above the first
 * declaration.
 *
 * Anchored on the CST rather than on scanning lines for `load `. A rule's CST node begins at its
 * first non-hidden token and a leading comment is reached as a preceding *sibling*, never as part
 * of the node — so the first declaration's offset already sits below any banner comment, and the
 * `load` cannot land above one.
 */
export function findLoadInsertion(document: LangiumDocument<Unit>): LoadInsertion {
    const unit = document.parseResult.value;

    const lastLoad = unit.imports.at(-1)?.$cstNode;
    if (lastLoad) {
        return { line: document.textDocument.positionAt(lastLoad.end).line + 1, suffix: '\n' };
    }

    const firstDeclaration = unit.body[0]?.$cstNode;
    const line = firstDeclaration
        ? document.textDocument.positionAt(firstDeclaration.offset).line
        : 0;
    return { line, suffix: '\n\n' };
}

/**
 * The edit that adds a `load` for `relativePath`, or `undefined` if the file already loads it.
 */
export function createLoadEdit(document: LangiumDocument<Unit>, relativePath: string): TextEdit[] | undefined {
    const unit = document.parseResult.value;
    if (!unit || isLoaded(unit, relativePath)) return undefined;

    const { line, suffix } = findLoadInsertion(document);
    const finalPath = relativePath.startsWith('../')
        ? relativePath
        : `./${normalizeLoadPath(relativePath)}`;

    return [{
        range: { start: Position.create(line, 0), end: Position.create(line, 0) },
        newText: `load "${finalPath}"${suffix}`
    }];
}

/** Where a new element declaration belongs inside a model, and how far to indent it. */
export interface BodyInsertion {
    readonly line: number;
    readonly indent: string;
}

/**
 * Decides where a new element declaration goes inside a justification or template: after the last
 * declaration already there, and before the relations.
 *
 * jPipe models conventionally read as a block of declarations followed by a block of
 * `x supports y` lines, and an element inserted among the relations reads as a mistake even
 * though it parses. Where a file has only relations, the declaration goes above them for the same
 * reason.
 */
export function findElementInsertion(
    document: LangiumDocument<Unit>,
    model: Justification | Template
): BodyInsertion | undefined {
    const body = model.contents;
    const modelNode = model.$cstNode;
    if (!body || !modelNode) return undefined;

    const lastElement = body.body.at(-1)?.$cstNode;
    if (lastElement) {
        const line = document.textDocument.positionAt(lastElement.end).line;
        return { line: line + 1, indent: indentationOf(document, line) };
    }

    const firstRelation = body.rels.at(-1)?.$cstNode;
    if (firstRelation) {
        const line = document.textDocument.positionAt(firstRelation.offset).line;
        return { line, indent: indentationOf(document, line) };
    }

    // A body with neither is not reachable through the grammar, but the header's own line is the
    // one sane answer if it ever becomes so.
    const headerLine = document.textDocument.positionAt(modelNode.offset).line;
    return { line: headerLine + 1, indent: `${indentationOf(document, headerLine)}    ` };
}

/**
 * One edit adding declarations to a model, wherever its body currently stands.
 *
 * Handles the case `findElementInsertion` cannot: a model whose body is empty. `{ }` does not
 * parse — a body needs at least one member — so a justification just pointed at a template sits
 * in exactly that state, with the override it is missing being the very thing that would make it
 * parse again. Declining to write it there would withhold the fix at the one moment it is most
 * wanted.
 *
 * Returns `undefined` only when the model has no braces to write into at all.
 */
export function insertDeclarationsEdit(
    document: LangiumDocument<Unit>,
    model: Justification | Template,
    declarations: readonly string[]
): TextEdit | undefined {
    if (declarations.length === 0) return undefined;

    const existing = findElementInsertion(document, model);
    if (existing) {
        return insertLinesEdit(existing.line, declarations, existing.indent);
    }

    // No body: write inside the braces, opening the block out onto its own lines.
    const modelNode = model.$cstNode;
    if (!modelNode) return undefined;
    const text = document.textDocument.getText();
    const open = text.indexOf('{', modelNode.offset);
    const close = text.lastIndexOf('}', modelNode.end);
    if (open < 0 || close < open) return undefined;

    const outer = indentationOf(document, document.textDocument.positionAt(open).line);
    const inner = `${outer}    `;
    const body = declarations.map(line => `\n${inner}${line}`).join('');

    // Replaces whatever sits between the braces — whitespace, or a comment left where the
    // declarations should go, which stays below them.
    const between = text.slice(open + 1, close);
    const kept = between.trim().length > 0 ? `\n${inner}${between.trim()}` : '';
    return {
        range: {
            start: document.textDocument.positionAt(open + 1),
            end: document.textDocument.positionAt(close)
        },
        newText: `${body}${kept}\n${outer}`
    };
}

// ── generic edits ────────────────────────────────────────────────────────────────────────────

/** The range a CST node spans. */
export function rangeOfCstNode(node: CstNode): Range {
    return node.range;
}

/** Replaces the whole word around `position`, so a partially typed token is consumed. */
export function wordReplaceEdit(document: LangiumDocument, position: Position, newText: string): TextEdit {
    const line = document.textDocument.getText().split('\n')[position.line] ?? '';

    let startCol = position.character;
    while (startCol > 0 && /\w/.test(line[startCol - 1])) startCol--;

    let endCol = position.character;
    while (endCol < line.length && /\w/.test(line[endCol])) endCol++;

    return {
        range: {
            start: { line: position.line, character: startCol },
            end: { line: position.line, character: endCol }
        },
        newText
    };
}

/** The leading whitespace of the given line, for matching a file's own indentation. */
export function indentationOf(document: LangiumDocument, line: number): string {
    const text = document.textDocument.getText().split('\n')[line] ?? '';
    return /^[ \t]*/.exec(text)?.[0] ?? '';
}

/** Inserts whole lines at `atLine`, each carrying `indent`. */
export function insertLinesEdit(atLine: number, lines: readonly string[], indent: string): TextEdit {
    return {
        range: { start: Position.create(atLine, 0), end: Position.create(atLine, 0) },
        newText: lines.map(line => `${indent}${line}\n`).join('')
    };
}

/**
 * Deletes whole lines, including the newline that ends the last one.
 *
 * Falls back to deleting to the end of the last line when the document does not end in a
 * newline, so the edit stays within the document.
 */
export function deleteLinesEdit(document: LangiumDocument, firstLine: number, lastLine: number): TextEdit {
    const lineCount = document.textDocument.lineCount;
    const end = lastLine + 1 < lineCount
        ? Position.create(lastLine + 1, 0)
        : document.textDocument.positionAt(document.textDocument.getText().length);
    return { range: { start: Position.create(firstLine, 0), end }, newText: '' };
}
