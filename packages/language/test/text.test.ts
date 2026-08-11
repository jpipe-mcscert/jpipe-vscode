import { describe, expect, test } from 'vitest';
import { byCodeUnit } from '../src/jpipe-text.js';

/**
 * `byCodeUnit` decides the order a model's globbed `load` files are seen in, and that order has
 * to match the compiler's (jpipe-vscode ADR-VSC-0007). These cases pin the two properties that
 * matter: it orders by UTF-16 code unit, and it does not consult a locale.
 */
describe('byCodeUnit', () => {
    test.each([
        ['a', 'b', -1],
        ['b', 'a', 1],
        ['a', 'a', 0]
    ])('byCodeUnit(%j, %j) === %i', (a, b, expected) => {
        expect(byCodeUnit(a as string, b as string)).toBe(expected);
    });

    test('orders uppercase before lowercase, as code units do', () => {
        // The point of the whole exercise: a locale-aware comparison puts 'a' before 'B', and
        // Java — which the compiler uses — does not. If this flips, the IDE and the compiler
        // disagree about load order.
        expect(byCodeUnit('B', 'a')).toBe(-1);
        expect('B'.localeCompare('a')).toBe(1);
    });

    test('sorts paths the way the compiler walks them', () => {
        const paths = ['models/b.jd', 'models/A.jd', 'models/a.jd', 'lib/z.jd'];
        expect([...paths].sort(byCodeUnit)).toEqual([
            'lib/z.jd',
            'models/A.jd',
            'models/a.jd',
            'models/b.jd'
        ]);
    });

    test('is a consistent comparator, so the sort is stable and total', () => {
        const values = ['x', 'y', 'X', '', 'xy'];
        for (const a of values) {
            for (const b of values) {
                const forward = byCodeUnit(a, b);
                const reverse = byCodeUnit(b, a);
                // The equal case is split out rather than asserted as `-reverse`: negating 0
                // gives -0, and `toBe` is Object.is, for which -0 and 0 differ.
                if (forward === 0) expect(reverse).toBe(0);
                else expect(forward).toBe(-reverse);
            }
        }
    });
});
