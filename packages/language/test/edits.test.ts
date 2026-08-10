/**
 * These are the edits every feature that writes jPipe source goes through, so a mistake here is
 * a mistake in the completion item, the quick fix and anything added later at once.
 *
 * `findLoadInsertion` gets the most attention because its predecessor scanned raw lines and
 * recognised only `//` as a comment. Every model in the compiler's example set opens with a
 * `/* … *​/` banner, which that scan read as code — so the `load` it inserted landed *above* the
 * banner, detaching the file's own header from the file. Anchoring on the CST is what fixes it,
 * and the banner cases below are what keep it fixed.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument } from 'langium';
import { parseHelper } from 'langium/test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Unit } from 'jpipe-language';
import { createJpipeServices } from 'jpipe-language';
import {
    createLoadEdit,
    deleteLinesEdit,
    findLoadInsertion,
    indentationOf,
    insertLinesEdit,
    isLoaded,
    normalizeLoadPath,
    relativeLoadPath,
    wordReplaceEdit
} from '../src/jpipe-edits.js';

let parse: ReturnType<typeof parseHelper<Unit>>;

beforeAll(async () => {
    parse = parseHelper<Unit>(createJpipeServices(EmptyFileSystem).Jpipe);
});

/** Applies the edits and returns the resulting text, which is what a user would see. */
function applied(document: LangiumDocument<Unit>, edits: ReturnType<typeof createLoadEdit>): string {
    return TextDocument.applyEdits(document.textDocument, edits ?? []);
}

describe('load paths', () => {

    test.each([
        ['./quality.jd', 'quality.jd'],
        ['quality.jd', 'quality.jd'],
        ['"./lib/base.jd"', 'lib/base.jd'],
        ['lib\\base.jd', 'lib/base.jd'],
        ['../shared/base.jd', '../shared/base.jd']
    ])('normalizeLoadPath(%s) is %s', (input, expected) => {
        expect(normalizeLoadPath(input)).toBe(expected);
    });

    test('a sibling file is written with a ./ prefix', () => {
        expect(relativeLoadPath('/w/model.jd', '/w/quality.jd')).toBe('./quality.jd');
    });

    test('a file outside the directory keeps its ../ prefix rather than gaining ./', () => {
        expect(relativeLoadPath('/w/sub/model.jd', '/w/base.jd')).toBe('../base.jd');
    });

    test('isLoaded compares in normalized form, so ./x.jd and x.jd are the same load', async () => {
        const document = await parse('load "x.jd"\njustification J { conclusion c is "C" }');
        expect(isLoaded(document.parseResult.value, './x.jd')).toBe(true);
        expect(isLoaded(document.parseResult.value, 'other.jd')).toBe(false);
    });
});

describe('findLoadInsertion', () => {

    test('a new load goes below an existing one', async () => {
        const document = await parse('load "a.jd"\njustification J { conclusion c is "C" }');
        expect(findLoadInsertion(document)).toEqual({ line: 1, suffix: '\n' });
    });

    test('the first load goes above the first declaration, with a blank line after it', async () => {
        const document = await parse('justification J { conclusion c is "C" }');
        expect(findLoadInsertion(document)).toEqual({ line: 0, suffix: '\n\n' });
    });

    // The regression this file exists for.
    test('the first load goes below a leading block-comment banner, not above it', async () => {
        const document = await parse(
            '/*\n * A banner every compiler example carries.\n */\njustification J { conclusion c is "C" }'
        );
        expect(findLoadInsertion(document).line).toBe(3);
        expect(applied(document, createLoadEdit(document, './base.jd'))).toBe(
            '/*\n * A banner every compiler example carries.\n */\nload "./base.jd"\n\njustification J { conclusion c is "C" }'
        );
    });

    test('the first load goes below a leading line-comment banner too', async () => {
        const document = await parse('// A banner\njustification J { conclusion c is "C" }');
        expect(findLoadInsertion(document).line).toBe(1);
    });

    test('an empty file takes the load at the top', async () => {
        const document = await parse('');
        expect(findLoadInsertion(document)).toEqual({ line: 0, suffix: '\n\n' });
    });
});

describe('createLoadEdit', () => {

    test('declines to add a load the file already has', async () => {
        const document = await parse('load "./base.jd"\njustification J { conclusion c is "C" }');
        expect(createLoadEdit(document, 'base.jd')).toBeUndefined();
    });

    test('appends below the existing loads without a blank line between them', async () => {
        const document = await parse('load "./a.jd"\n\njustification J { conclusion c is "C" }');
        expect(applied(document, createLoadEdit(document, './b.jd')))
            .toBe('load "./a.jd"\nload "./b.jd"\n\njustification J { conclusion c is "C" }');
    });

    test('an upward path is written as-is rather than gaining a ./ prefix', async () => {
        const document = await parse('justification J { conclusion c is "C" }');
        expect(applied(document, createLoadEdit(document, '../shared/base.jd')))
            .toContain('load "../shared/base.jd"');
    });
});

describe('generic edits', () => {

    test('wordReplaceEdit consumes the whole word the cursor sits inside', async () => {
        const document = await parse('justification J { conclusion c is "C" }');
        const edit = wordReplaceEdit(document, { line: 0, character: 20 }, 'evidence');
        expect(TextDocument.applyEdits(document.textDocument, [edit]))
            .toBe('justification J { evidence c is "C" }');
    });

    test('indentationOf reports the leading whitespace of a line', async () => {
        const document = await parse('justification J {\n    conclusion c is "C"\n}');
        expect(indentationOf(document, 1)).toBe('    ');
        expect(indentationOf(document, 2)).toBe('');
    });

    test('insertLinesEdit indents every inserted line', async () => {
        const document = await parse('justification J {\n    conclusion c is "C"\n}');
        const edit = insertLinesEdit(2, ['strategy s is "S"', 's supports c'], '    ');
        expect(TextDocument.applyEdits(document.textDocument, [edit]))
            .toBe('justification J {\n    conclusion c is "C"\n    strategy s is "S"\n    s supports c\n}');
    });

    test('deleteLinesEdit takes the newline with the line', async () => {
        const document = await parse('load "a.jd"\nload "b.jd"\njustification J { conclusion c is "C" }');
        const edit = deleteLinesEdit(document, 1, 1);
        expect(TextDocument.applyEdits(document.textDocument, [edit]))
            .toBe('load "a.jd"\njustification J { conclusion c is "C" }');
    });

    // Without the last-line guard this would build a range past the end of the document.
    test('deleteLinesEdit handles a last line with no trailing newline', async () => {
        const document = await parse('load "a.jd"\nload "b.jd"');
        expect(TextDocument.applyEdits(document.textDocument, [deleteLinesEdit(document, 1, 1)]))
            .toBe('load "a.jd"\n');
    });
});
