import { describe, expect, test } from 'vitest';
import {
    formatEntry,
    isSameOrInside,
    parseEntry,
    stripTrailingSlash
} from '../src/extension/exclusion-paths.js';

/**
 * The stored spelling of an exclusion and what counts as "inside" it. Both decide whether a file
 * is validated, so a mistake here silently turns checking off — or on — for the wrong files.
 */

describe('parseEntry', () => {
    test('reads a bare single-root entry', () => {
        expect(parseEntry('counter-examples')).toEqual({ rootName: undefined, relativePath: 'counter-examples' });
        expect(parseEntry('src/broken.jd')).toEqual({ rootName: undefined, relativePath: 'src/broken.jd' });
    });

    test('splits the multi-root spelling on the first colon', () => {
        expect(parseEntry('models:counter-examples'))
            .toEqual({ rootName: 'models', relativePath: 'counter-examples' });
        // Only the first colon separates, so a path may itself contain one.
        expect(parseEntry('models:a:b'))
            .toEqual({ rootName: 'models', relativePath: 'a:b' });
    });

    test('rejects entries that cannot name anything', () => {
        // A blank entry previously resolved to the filesystem root, silencing the workspace.
        expect(parseEntry('')).toBeUndefined();
        expect(parseEntry('   ')).toBeUndefined();
        // A root name with nothing after it names no directory.
        expect(parseEntry('models:')).toBeUndefined();
    });

    test('a leading colon is not a separator', () => {
        // `indexOf` must be > 0, so this is a (odd) relative path, not an empty root name.
        expect(parseEntry(':models')).toEqual({ rootName: undefined, relativePath: ':models' });
    });

    // Documented limitation rather than a bug to chase: the format cannot address a workspace
    // folder whose own name contains a colon.
    test('a root name containing a colon cannot be addressed', () => {
        expect(parseEntry('a:b:models')).toEqual({ rootName: 'a', relativePath: 'b:models' });
    });
});

describe('formatEntry', () => {
    test('round-trips both spellings', () => {
        expect(formatEntry(undefined, 'counter-examples')).toBe('counter-examples');
        expect(formatEntry('models', 'counter-examples')).toBe('models:counter-examples');

        for (const entry of ['counter-examples', 'models:counter-examples', 'src/a.jd']) {
            const parsed = parseEntry(entry)!;
            expect(formatEntry(parsed.rootName, parsed.relativePath)).toBe(entry);
        }
    });
});

describe('stripTrailingSlash', () => {
    test('drops exactly one trailing slash', () => {
        expect(stripTrailingSlash('file:///a/b/')).toBe('file:///a/b');
        expect(stripTrailingSlash('file:///a/b')).toBe('file:///a/b');
        expect(stripTrailingSlash('file:///a/b//')).toBe('file:///a/b/');
    });
});

describe('isSameOrInside', () => {
    const parent = 'file:///ws/counter-examples';

    test('matches the directory itself', () => {
        expect(isSameOrInside(parent, parent)).toBe(true);
    });

    test('matches at any depth below', () => {
        expect(isSameOrInside(parent, `${parent}/bad.jd`)).toBe(true);
        expect(isSameOrInside(parent, `${parent}/nested/deep.jd`)).toBe(true);
    });

    // The reason the boundary check exists: a plain startsWith would swallow this.
    test('does not match a sibling that merely shares the prefix', () => {
        expect(isSameOrInside(parent, 'file:///ws/counter-examples-old/bad.jd')).toBe(false);
        expect(isSameOrInside(parent, 'file:///ws/counter-examplesX')).toBe(false);
    });

    test('does not match upwards', () => {
        expect(isSameOrInside(parent, 'file:///ws')).toBe(false);
        expect(isSameOrInside(parent, 'file:///ws/other/a.jd')).toBe(false);
    });

    test('a trailing slash on either side does not change the answer', () => {
        expect(isSameOrInside(`${parent}/`, parent)).toBe(true);
        expect(isSameOrInside(parent, `${parent}/`)).toBe(true);
        expect(isSameOrInside(`${parent}/`, `${parent}/bad.jd`)).toBe(true);
    });

    test('a file entry matches only itself', () => {
        const file = 'file:///ws/src/broken.jd';
        expect(isSameOrInside(file, file)).toBe(true);
        expect(isSameOrInside(file, 'file:///ws/src/broken.jd.bak')).toBe(false);
        expect(isSameOrInside(file, 'file:///ws/src/model.jd')).toBe(false);
    });
});
