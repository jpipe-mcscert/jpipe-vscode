import { describe, expect, test } from 'vitest';
import { arityPhrase, operatorSpec, knownOperatorNames } from 'jpipe-language';

/**
 * The wording of an operator's arity, as the validator reports it.
 *
 * Tested directly because one of its three cases cannot be reached through the validator: no
 * shipped operator declares a `max` above its `min`, so a bounded range never arises. That was
 * invisible while the three cases were one nested ternary — line coverage counts the statement,
 * not the branch — and became visible the moment they were separate returns.
 */

describe('arityPhrase', () => {

    test('says "exactly" when the bounds meet', () => {
        expect(arityPhrase(2, 2)).toBe('exactly 2');
    });

    test('says "at least" when there is no upper bound', () => {
        expect(arityPhrase(1, undefined)).toBe('at least 1');
    });

    test('names both bounds when they differ', () => {
        // Unreachable through the validator today. Kept and tested rather than deleted: an
        // operator declaring `{ min: 1, max: 3 }` would otherwise silently get a wrong message,
        // and the next reader would have no way to tell the case was ever considered.
        expect(arityPhrase(1, 3)).toBe('between 1 and 3');
    });

    test('handles a zero lower bound', () => {
        expect(arityPhrase(0, undefined)).toBe('at least 0');
        expect(arityPhrase(0, 0)).toBe('exactly 0');
    });
});

describe('the shipped operators', () => {

    test('are the two the phrase has to describe', () => {
        // Guards the claim above: if a third operator arrives with a bounded range, the
        // "unreachable" note in `arityPhrase` stops being true and should be revisited.
        expect([...knownOperatorNames()].sort()).toEqual(['assemble', 'refine']);
    });

    // Object rows with `$name` placeholders rather than a tuple with `%s`: positional
    // placeholders take the row's *second* element, which is the arity, so the title claimed
    // `assemble is described as "1"`. Named ones cannot drift from what the row holds.
    test.each([
        { operator: 'assemble', min: 1, max: undefined, phrase: 'at least 1' },
        { operator: 'refine', min: 2, max: 2, phrase: 'exactly 2' }
    ])('$operator is described as $phrase', ({ operator, min, max, phrase }) => {
        const spec = operatorSpec(operator);
        expect(spec?.arity.min).toBe(min);
        expect(spec?.arity.max).toBe(max);
        expect(arityPhrase(spec!.arity.min, spec!.arity.max)).toBe(phrase);
    });
});
