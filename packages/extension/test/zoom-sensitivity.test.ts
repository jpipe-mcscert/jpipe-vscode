import { describe, expect, test } from 'vitest';
import { clampZoomSensitivity } from '../src/extension/preview/zoom-sensitivity.js';

/** The zoom multiplier both diagram panels hand their page, whatever settings.json holds. */
describe('the zoom sensitivity', () => {

    test.each([
        [1, 1], [2.5, 2.5], [0.25, 0.25], [4, 4],
        [0, 0.25], [-3, 0.25], [10, 4],
        [Number.NaN, 1], [Number.POSITIVE_INFINITY, 1], ['2', 1], [null, 1], [undefined, 1]
    ])('%s is used as %s', (value, used) => {
        expect(clampZoomSensitivity(value)).toBe(used);
    });
});
