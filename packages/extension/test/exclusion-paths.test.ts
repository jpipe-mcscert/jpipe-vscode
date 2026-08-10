import { describe, expect, test } from 'vitest';
import { findExcludingPath, formatEntry, isSameOrInside, parseEntry, shouldShowExclusionBanner, stripTrailingSlash } from '../src/extension/exclusion-paths.js';

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

describe('shouldShowExclusionBanner', () => {

    const excluded = ['file:///ws/counter-examples', 'file:///ws/src/broken.jd'];

    test('a jPipe file inside an excluded directory gets the banner', () => {
        expect(shouldShowExclusionBanner('jpipe', 'file:///ws/counter-examples/bad.jd', excluded)).toBe(true);
    });

    test('an excluded jPipe file gets it on its own account', () => {
        expect(shouldShowExclusionBanner('jpipe', 'file:///ws/src/broken.jd', excluded)).toBe(true);
    });

    // The banner answers "why is this file not reporting problems?", which only makes sense for a
    // file jPipe would otherwise validate. A README beside the counter-examples never was.
    test('a non-jPipe file inside an excluded directory does not', () => {
        expect(shouldShowExclusionBanner('markdown', 'file:///ws/counter-examples/README.md', excluded)).toBe(false);
        expect(shouldShowExclusionBanner('plaintext', 'file:///ws/counter-examples/notes.txt', excluded)).toBe(false);
    });

    test('a jPipe file outside every excluded path does not', () => {
        expect(shouldShowExclusionBanner('jpipe', 'file:///ws/src/model.jd', excluded)).toBe(false);
    });

    // The same boundary rule the Explorer badge uses: `counter-examples` must not swallow
    // `counter-examples-old`, or a directory nobody excluded claims to be unvalidated.
    test('a sibling directory sharing a name prefix does not', () => {
        expect(shouldShowExclusionBanner('jpipe', 'file:///ws/counter-examples-old/bad.jd', excluded)).toBe(false);
    });

    test('nothing excluded means no banner anywhere', () => {
        expect(shouldShowExclusionBanner('jpipe', 'file:///ws/counter-examples/bad.jd', [])).toBe(false);
    });

    // An untitled buffer has no path under any workspace root, so containment answers this
    // without the rule needing to know about schemes.
    test('an unsaved buffer does not', () => {
        expect(shouldShowExclusionBanner('jpipe', 'untitled:Untitled-1', excluded)).toBe(false);
    });
});

describe('findExcludingPath', () => {

    test('names the folder a file sits inside', () => {
        expect(findExcludingPath('file:///ws/counter-examples/bad.jd', ['file:///ws/counter-examples']))
            .toBe('file:///ws/counter-examples');
    });

    test('names the file when the file itself is the entry', () => {
        expect(findExcludingPath('file:///ws/src/broken.jd', ['file:///ws/src/broken.jd']))
            .toBe('file:///ws/src/broken.jd');
    });

    // Undoing the folder would leave the file excluded by its own entry, and the banner still up
    // — which reads as the click having done nothing.
    test('prefers the file over a folder that also covers it', () => {
        expect(findExcludingPath('file:///ws/ce/bad.jd', ['file:///ws/ce', 'file:///ws/ce/bad.jd']))
            .toBe('file:///ws/ce/bad.jd');
    });

    test('prefers the innermost of two nested folders', () => {
        expect(findExcludingPath('file:///ws/a/b/bad.jd', ['file:///ws/a', 'file:///ws/a/b']))
            .toBe('file:///ws/a/b');
    });

    test('is undefined for a file nothing excludes', () => {
        expect(findExcludingPath('file:///ws/src/model.jd', ['file:///ws/counter-examples']))
            .toBeUndefined();
        expect(findExcludingPath('file:///ws/src/model.jd', [])).toBeUndefined();
    });

    test('a sibling sharing a name prefix does not count as covering', () => {
        expect(findExcludingPath('file:///ws/ce-old/bad.jd', ['file:///ws/ce'])).toBeUndefined();
    });
});
