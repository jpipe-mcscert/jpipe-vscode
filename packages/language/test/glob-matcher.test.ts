import { describe, expect, test } from 'vitest';
import { globToRegExp, isGlobPattern, matchesGlob, GlobSyntaxError } from '../src/jpipe-glob.js';

/**
 * These assertions mirror the jPipe compiler's `LoadResolverGlobTest` and Java NIO's
 * `getPathMatcher("glob:")` semantics. Where the two could drift, the compiler wins — a
 * disagreement here means the IDE resolves a different set of files than a build does.
 */
describe('isGlobPattern', () => {
    test.each([
        ['*.jd', true],
        ['globs/**.jd', true],
        ['model?.jd', true],
        ['[ab].jd', true],
        ['{a,b}.jd', true],
        ['./base.jd', false],
        ['models/base.jd', false],
        ['/abs/path/base.jd', false]
    ])('%s → %s', (path, expected) => {
        expect(isGlobPattern(path)).toBe(expected);
    });
});

describe('Java NIO glob semantics', () => {
    test('* does not cross directory boundaries', () => {
        expect(matchesGlob('*.jd', 'top.jd')).toBe(true);
        expect(matchesGlob('*.jd', 'nested/deep.jd')).toBe(false);
    });

    // The compiler's doubleStarSlashMatchesNestedFilesOnly: the pattern requires a directory
    // segment, so a top-level file does not match.
    test('**/* matches nested files only', () => {
        expect(matchesGlob('**/*.jd', 'nested/deep.jd')).toBe(true);
        expect(matchesGlob('**/*.jd', 'deeper/still/deep.jd')).toBe(true);
        expect(matchesGlob('**/*.jd', 'top.jd')).toBe(false);
    });

    // The compiler's doubleStarMatchesEveryDepthIncludingTopLevel. This is the case minimatch and
    // picomatch get wrong, treating `**` as `*` when it is not a whole segment.
    test('** matches every depth including top level', () => {
        expect(matchesGlob('**.jd', 'top.jd')).toBe(true);
        expect(matchesGlob('**.jd', 'nested/deep.jd')).toBe(true);
        expect(matchesGlob('**.jd', 'a/b/c/deep.jd')).toBe(true);
    });

    test('** under a directory prefix matches every depth below it', () => {
        expect(matchesGlob('globs/**.jd', 'globs/model_alpha.jd')).toBe(true);
        expect(matchesGlob('globs/**.jd', 'globs/nested/model_gamma.jd')).toBe(true);
        expect(matchesGlob('globs/**.jd', 'other/model.jd')).toBe(false);
    });

    test('? matches exactly one non-separator character', () => {
        expect(matchesGlob('model?.jd', 'model1.jd')).toBe(true);
        expect(matchesGlob('model?.jd', 'model.jd')).toBe(false);
        expect(matchesGlob('model?.jd', 'model12.jd')).toBe(false);
        expect(matchesGlob('a?b.jd', 'a/b.jd')).toBe(false);
    });

    test('character classes', () => {
        expect(matchesGlob('[ab].jd', 'a.jd')).toBe(true);
        expect(matchesGlob('[ab].jd', 'c.jd')).toBe(false);
        expect(matchesGlob('[a-c].jd', 'b.jd')).toBe(true);
        expect(matchesGlob('[a-c].jd', 'd.jd')).toBe(false);
    });

    test('negated character class excludes the separator too', () => {
        expect(matchesGlob('[!a].jd', 'b.jd')).toBe(true);
        expect(matchesGlob('[!a].jd', 'a.jd')).toBe(false);
        // A negated class must never match a path separator, per Java's [^/]&&[^a] intersection.
        expect(matchesGlob('x[!a]y.jd', 'x/y.jd')).toBe(false);
    });

    test('brace alternation', () => {
        expect(matchesGlob('{alpha,beta}.jd', 'alpha.jd')).toBe(true);
        expect(matchesGlob('{alpha,beta}.jd', 'beta.jd')).toBe(true);
        expect(matchesGlob('{alpha,beta}.jd', 'gamma.jd')).toBe(false);
    });

    test('dots are literal, not regex wildcards', () => {
        expect(matchesGlob('*.jd', 'axjd')).toBe(false);
        expect(matchesGlob('a.b.jd', 'a.b.jd')).toBe(true);
        expect(matchesGlob('a.b.jd', 'axbxjd')).toBe(false);
    });

    test('patterns are anchored at both ends', () => {
        expect(matchesGlob('*.jd', 'model.jd.bak')).toBe(false);
        expect(matchesGlob('globs/*.jd', 'x/globs/model.jd')).toBe(false);
    });

    test('backslash escapes a metacharacter', () => {
        expect(matchesGlob('a\\*b.jd', 'a*b.jd')).toBe(true);
        expect(matchesGlob('a\\*b.jd', 'axxb.jd')).toBe(false);
    });
});

describe('malformed patterns', () => {
    // The compiler's invalidGlobSyntaxIsAFatalErrorAndDoesNotThrow uses exactly this pattern.
    test('unbalanced [ is rejected', () => {
        expect(() => globToRegExp('[.jd')).toThrow(GlobSyntaxError);
        expect(() => globToRegExp('[.jd')).toThrow(/Missing '\]/);
    });

    test('nested groups are rejected', () => {
        expect(() => globToRegExp('{a,{b,c}}.jd')).toThrow(/Cannot nest groups/);
    });

    test('unclosed group is rejected', () => {
        expect(() => globToRegExp('{a,b.jd')).toThrow(/Missing '\}/);
    });

    test('trailing backslash is rejected', () => {
        expect(() => globToRegExp('a\\')).toThrow(/No character to escape/);
    });

    test('an explicit separator inside a class is rejected', () => {
        expect(() => globToRegExp('[/].jd')).toThrow(/name separator/);
    });

    test('a reversed range is rejected', () => {
        expect(() => globToRegExp('[c-a].jd')).toThrow(/Invalid range/);
    });

    test('GlobSyntaxError carries a description for the diagnostic', () => {
        try {
            globToRegExp('[.jd');
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(GlobSyntaxError);
            expect((err as GlobSyntaxError).description).toBe("Missing ']");
        }
    });
});
