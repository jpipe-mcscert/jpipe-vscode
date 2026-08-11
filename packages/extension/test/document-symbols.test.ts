import { describe, expect, test } from 'vitest';
import { symbolAtPosition, type DocumentSymbol } from '../src/extension/preview/document-symbols.js';

/**
 * Which symbol the cursor is in, which decides what the preview highlights.
 *
 * Untestable until this moved out of `preview-provider.ts`, and worth testing now that it can be:
 * the result is matched against node ids in the compiler's SVG, so the wrong answer highlights
 * the wrong box and null leaves the diagram looking inert while the cursor moves through it.
 */

const at = (
    name: string,
    startLine: number, startChar: number,
    endLine: number, endChar: number,
    children?: DocumentSymbol[]
): DocumentSymbol => ({
    name,
    range: { start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } },
    ...(children ? { children } : {})
});

describe('symbolAtPosition', () => {

    test('returns null for an empty symbol list', () => {
        expect(symbolAtPosition([], 0, 0)).toBeNull();
    });

    test('returns null when the position is outside every symbol', () => {
        expect(symbolAtPosition([at('J', 1, 0, 3, 1)], 9, 0)).toBeNull();
    });

    test('finds a symbol containing the position', () => {
        expect(symbolAtPosition([at('J', 1, 0, 3, 1)], 2, 4)?.name).toBe('J');
    });

    test('prefers the child over the model that encloses it', () => {
        // The whole point in a `.jd` file: the justification is not a node in the diagram, so
        // returning it would highlight everything rather than the element under the cursor.
        const model = at('J', 0, 0, 10, 1, [at('e1', 2, 4, 2, 40)]);
        expect(symbolAtPosition([model], 2, 10)?.name).toBe('e1');
    });

    test('falls back to the parent when the cursor is between its children', () => {
        const model = at('J', 0, 0, 10, 1, [at('e1', 2, 4, 2, 40)]);
        expect(symbolAtPosition([model], 5, 0)?.name).toBe('J');
    });

    test('descends more than one level', () => {
        const model = at('J', 0, 0, 10, 1, [at('grp', 1, 0, 5, 9, [at('e1', 2, 4, 2, 40)])]);
        expect(symbolAtPosition([model], 2, 10)?.name).toBe('e1');
    });

    describe('range boundaries', () => {
        const symbols = [at('e1', 2, 4, 4, 20)];

        test.each([
            ['the first character', 2, 4, 'e1'],
            ['the last character', 4, 20, 'e1'],
            ['one character before the start', 2, 3, null],
            ['one character after the end', 4, 21, null],
            ['a line above', 1, 99, null],
            ['a line below', 5, 0, null]
        ])('%s', (_label, line, character, expected) => {
            // Inclusive at both ends: the cursor sitting on the closing brace of an element is
            // still inside it, and a caret at its first character is already in.
            expect(symbolAtPosition(symbols, line, character)?.name ?? null).toBe(expected);
        });

        test('a column outside the range still matches on an interior line', () => {
            // Columns only bound the first and last lines; in between, any column is inside.
            expect(symbolAtPosition(symbols, 3, 0)?.name).toBe('e1');
            expect(symbolAtPosition(symbols, 3, 5000)?.name).toBe('e1');
        });
    });

    describe('choosing between overlapping siblings', () => {
        test('takes the smallest, not the first listed', () => {
            const wide = at('wide', 0, 0, 9, 0);
            const narrow = at('narrow', 2, 0, 2, 30);
            expect(symbolAtPosition([wide, narrow], 2, 5)?.name).toBe('narrow');
            expect(symbolAtPosition([narrow, wide], 2, 5)?.name).toBe('narrow');
        });

        test('a symbol spanning fewer lines wins however long its lines are', () => {
            // Both cases here need a line longer than 10,000 characters, which is what it takes
            // to reach the defect — vanishingly unlikely in a `.jd` file, and the reason it
            // survived unnoticed. Verified to fail against the previous weighting, not merely
            // assumed to: `lineSpan * 10000 + charSpan` scored the one-line symbol at 12,000 and
            // the symbol wrapping it at 10,010, so the outer one was ranked more specific.
            const inner = at('inner', 3, 0, 3, 12000);
            const outer = at('outer', 3, 0, 4, 10);
            expect(symbolAtPosition([outer, inner], 3, 20)?.name).toBe('inner');
        });

        test('a range ending left of where it starts does not win by arithmetic', () => {
            // A range spanning lines has a *negative* character span whenever it ends left of
            // where it starts. The old sum folded that straight in — 10,000 - 40 = 9,960 — and
            // so beat a one-line symbol scoring 10,000 that was genuinely tighter.
            const outer = at('outer', 4, 50, 5, 10);
            const inner = at('inner', 4, 0, 4, 10000);
            expect(symbolAtPosition([outer, inner], 4, 55)?.name).toBe('inner');
        });

        test('keeps the first when two candidates are the same size', () => {
            // Strict `<`, so an exact tie does not churn. Nothing depends on which is chosen —
            // this pins the behaviour so a later change to the comparator is a visible decision.
            const a = at('a', 1, 0, 1, 10);
            const b = at('b', 1, 0, 1, 10);
            expect(symbolAtPosition([a, b], 1, 5)?.name).toBe('a');
        });
    });

    test('treats an empty children array as a leaf', () => {
        // `children?.length` guards this; an empty array from the server must not be recursed
        // into and must not stop the symbol itself from being the answer.
        const model: DocumentSymbol = { ...at('J', 0, 0, 5, 0), children: [] };
        expect(symbolAtPosition([model], 1, 0)?.name).toBe('J');
    });
});
