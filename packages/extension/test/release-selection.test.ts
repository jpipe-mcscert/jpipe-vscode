import { describe, expect, test } from 'vitest';
import {
    comparePrecedence,
    compareSemverDesc,
    isAllowedHost,
    isStrictlyNewer,
    parseSemver,
    selectInstallableReleases,
    type JpipeRelease
} from '../src/extension/compiler/release-selection.js';

/**
 * This logic picks which compiler the user is offered and where it may be downloaded from, so a
 * silent regression here means installing the wrong version — or fetching from the wrong host.
 */

/** A releases-API entry, with only the fields the selection actually reads. */
function apiRelease(tag: string, overrides: Record<string, unknown> = {}) {
    return {
        tag_name: tag,
        name: `jPipe ${tag}`,
        published_at: '2026-01-01T00:00:00Z',
        draft: false,
        prerelease: false,
        assets: [{
            name: `jpipe-cli-${tag.replace(/^v/, '')}.jar`,
            browser_download_url: `https://github.com/o/r/releases/download/${tag}/jpipe-cli.jar`,
            size: 1234
        }],
        ...overrides
    };
}

const tags = (releases: JpipeRelease[]) => releases.map(r => r.tag);

describe('parseSemver', () => {
    test('accepts tags with and without the v prefix', () => {
        // Both forms occur in this project's history: `v2.1.0` and a lone `1.9.0`.
        expect(parseSemver('v2.1.0')?.nums).toEqual([2, 1, 0]);
        expect(parseSemver('1.9.0')?.nums).toEqual([1, 9, 0]);
        expect(parseSemver('  v2.1.0  ')?.nums).toEqual([2, 1, 0]);
    });

    test('splits off the prerelease part', () => {
        expect(parseSemver('v2.0.0-rc1')?.pre).toBe('rc1');
        expect(parseSemver('v2.0.0-rc.1')?.pre).toBe('rc.1');
        expect(parseSemver('v2.0.0')?.pre).toBeUndefined();
    });

    test('rejects anything that is not a version', () => {
        // This is how the rolling `unstable` tag gets excluded from the picker.
        expect(parseSemver('unstable')).toBeUndefined();
        expect(parseSemver('')).toBeUndefined();
        expect(parseSemver('v2.0')).toBeUndefined();
    });

    // Unanchored, these would be read as the release they resemble and offered as that release.
    test('rejects a tag with trailing junk rather than reading the version out of it', () => {
        expect(parseSemver('v2.1.0nightly')).toBeUndefined();
        expect(parseSemver('v2.1.0.1')).toBeUndefined();
        expect(parseSemver('v2.1.0 (do not use)')).toBeUndefined();
    });

    test('accepts build metadata and drops it, as semver requires', () => {
        // Build metadata is valid but takes no part in precedence.
        expect(parseSemver('v2.1.0+build.5')?.nums).toEqual([2, 1, 0]);
        expect(parseSemver('v2.1.0+build.5')?.pre).toBeUndefined();
        expect(parseSemver('v2.0.0-rc.1+exp')?.pre).toBe('rc.1');
        expect(comparePrecedence('v2.1.0+build.5', 'v2.1.0')).toBe(0);
    });
});

describe('comparePrecedence', () => {
    test.each([
        // Core version wins first.
        ['v2.1.0', 'v2.0.0', 'newer'],
        ['v2.0.1', 'v2.0.0', 'newer'],
        ['v3.0.0', 'v2.9.9', 'newer'],
        ['1.9.0', 'v2.0.0', 'older'],
        ['v2.0.0', 'v2.0.0', 'same'],
        // A prerelease ranks below the release it leads to.
        ['v2.0.0-rc1', 'v2.0.0', 'older'],
        ['v2.0.0', 'v2.0.0-rc1', 'newer'],
        // Numeric identifiers compare as numbers: the classic rc.2 vs rc.10 trap.
        ['v2.0.0-rc.10', 'v2.0.0-rc.2', 'newer'],
        ['v2.0.0-rc.2', 'v2.0.0-rc.10', 'older'],
        // Alphanumeric identifiers compare lexically.
        ['v2.0.0-beta', 'v2.0.0-alpha', 'newer'],
        // Numeric ranks below alphanumeric.
        ['v2.0.0-1', 'v2.0.0-alpha', 'older'],
        // Fewer identifiers rank lower.
        ['v2.0.0-rc.1', 'v2.0.0-rc', 'newer'],
        ['v2.0.0-rc', 'v2.0.0-rc.1', 'older']
    ])('%s vs %s → %s', (a, b, expected) => {
        const result = comparePrecedence(a, b);
        if (expected === 'newer') expect(result).toBeGreaterThan(0);
        else if (expected === 'older') expect(result).toBeLessThan(0);
        else expect(result).toBe(0);
    });

    test('an unparseable tag compares equal rather than throwing', () => {
        // Keeps a rogue tag from reordering the list or crashing the picker.
        expect(comparePrecedence('unstable', 'v2.0.0')).toBe(0);
        expect(comparePrecedence('v2.0.0', 'unstable')).toBe(0);
    });

    // `rc1` is one identifier, `rc.1` is two — both spellings exist in this project's tags, so
    // the comparison between them is exercised deliberately rather than left to chance.
    test('rc1 and rc.1 are ordered by the first identifier', () => {
        // 'rc1' vs 'rc': alphanumeric comparison puts 'rc' first, so rc.1 is the older of the two.
        expect(comparePrecedence('v2.0.0-rc1', 'v2.0.0-rc.1')).toBeGreaterThan(0);
    });
});

describe('isStrictlyNewer', () => {
    test('drives the update prompt only on a genuine upgrade', () => {
        expect(isStrictlyNewer('v2.2.0', 'v2.1.0')).toBe(true);
        expect(isStrictlyNewer('v2.1.0', 'v2.1.0')).toBe(false);
        expect(isStrictlyNewer('v2.0.0', 'v2.1.0')).toBe(false);
        // Installing a stable release must not keep offering its own prerelease.
        expect(isStrictlyNewer('v2.0.0-rc1', 'v2.0.0')).toBe(false);
    });
});

describe('compareSemverDesc', () => {
    test('sorts newest first', () => {
        const releases = ['v2.0.0', 'v2.2.0', 'v2.0.0-rc1', 'v2.1.0']
            .map(tag => ({ tag } as JpipeRelease));
        expect(tags([...releases].sort(compareSemverDesc)))
            .toEqual(['v2.2.0', 'v2.1.0', 'v2.0.0', 'v2.0.0-rc1']);
    });
});

describe('selectInstallableReleases', () => {
    test('keeps stable releases, newest first', () => {
        const picked = selectInstallableReleases(
            [apiRelease('v2.0.0'), apiRelease('v2.2.0'), apiRelease('v2.1.0')], false);
        expect(tags(picked)).toEqual(['v2.2.0', 'v2.1.0', 'v2.0.0']);
    });

    test('hides prereleases unless asked for', () => {
        const payload = [apiRelease('v2.2.0'), apiRelease('v2.3.0-rc1', { prerelease: true })];
        expect(tags(selectInstallableReleases(payload, false))).toEqual(['v2.2.0']);
        expect(tags(selectInstallableReleases(payload, true))).toEqual(['v2.3.0-rc1', 'v2.2.0']);
    });

    test('always hides drafts, even when prereleases are wanted', () => {
        const payload = [apiRelease('v2.2.0'), apiRelease('v2.3.0', { draft: true })];
        expect(tags(selectInstallableReleases(payload, true))).toEqual(['v2.2.0']);
    });

    test('hides releases below the supported major version', () => {
        // 1.x predates the subcommands this extension drives.
        const payload = [apiRelease('v2.0.0'), apiRelease('1.9.0'), apiRelease('0.2.8')];
        expect(tags(selectInstallableReleases(payload, false))).toEqual(['v2.0.0']);
    });

    test('hides tags that are not versions at all', () => {
        // The rolling `unstable` tag must never appear in the picker, and neither must a tag
        // that merely starts with a version.
        const payload = [apiRelease('v2.0.0'), apiRelease('unstable'), apiRelease('v2.1.0nightly')];
        expect(tags(selectInstallableReleases(payload, false))).toEqual(['v2.0.0']);
    });

    test('requires a jpipe-cli jar asset', () => {
        const payload = [
            apiRelease('v2.2.0'),
            apiRelease('v2.3.0', { assets: [{ name: 'jpipe-2.3.0.zip', browser_download_url: 'u', size: 1 }] }),
            apiRelease('v2.4.0', { assets: [] })
        ];
        expect(tags(selectInstallableReleases(payload, false))).toEqual(['v2.2.0']);
    });

    test('skips an asset with no download URL', () => {
        const payload = [apiRelease('v2.3.0', { assets: [{ name: 'jpipe-cli-2.3.0.jar', size: 1 }] })];
        expect(selectInstallableReleases(payload, false)).toEqual([]);
    });

    test('picks the cli jar out of a release carrying several assets', () => {
        const payload = [apiRelease('v2.3.0', {
            assets: [
                { name: 'jpipe-2.3.0.zip', browser_download_url: 'zip', size: 10 },
                { name: 'jpipe-cli-2.3.0.jar', browser_download_url: 'jar', size: 20 },
                { name: 'checksums.txt', browser_download_url: 'txt', size: 1 }
            ]
        })];
        const [release] = selectInstallableReleases(payload, false);
        expect(release.jarUrl).toBe('jar');
        expect(release.jarName).toBe('jpipe-cli-2.3.0.jar');
        expect(release.jarSize).toBe(20);
    });

    test('falls back to the tag when a release has no name', () => {
        const [release] = selectInstallableReleases([apiRelease('v2.3.0', { name: '' })], false);
        expect(release.name).toBe('v2.3.0');
    });

    test('treats a missing asset size as zero rather than NaN', () => {
        // A zero size disables the size check on download; NaN would poison the comparison.
        const payload = [apiRelease('v2.3.0', {
            assets: [{ name: 'jpipe-cli-2.3.0.jar', browser_download_url: 'u' }]
        })];
        expect(selectInstallableReleases(payload, false)[0].jarSize).toBe(0);
    });

    test('survives malformed entries instead of throwing', () => {
        const payload = [null, undefined, {}, { tag_name: null }, apiRelease('v2.0.0')];
        expect(tags(selectInstallableReleases(payload, false))).toEqual(['v2.0.0']);
    });

    test('rejects a payload that is not an array', () => {
        expect(() => selectInstallableReleases({ message: 'rate limited' }, false))
            .toThrow(/Unexpected response/);
        expect(() => selectInstallableReleases(null, false)).toThrow(/Unexpected response/);
    });
});

describe('isAllowedHost', () => {
    test.each(['api.github.com', 'github.com', 'objects.githubusercontent.com'])(
        'allows %s', host => expect(isAllowedHost(host)).toBe(true));

    test('allows githubusercontent subdomains, which is where assets redirect to', () => {
        expect(isAllowedHost('release-assets.githubusercontent.com')).toBe(true);
    });

    test.each([
        'evil.com',
        'raw.github.com.evil.com',
        // The suffix check must keep its leading dot: without it these would slip through.
        'evilgithubusercontent.com',
        'notgithubusercontent.com',
        // A lookalike that merely contains the allowed host is not the allowed host.
        'githubusercontent.com.evil.net',
        ''
    ])('rejects %o', host => expect(isAllowedHost(host)).toBe(false));

    test('is exact about the allowlist, not a substring match', () => {
        expect(isAllowedHost('api.github.com.evil.net')).toBe(false);
        expect(isAllowedHost('xapi.github.com')).toBe(false);
    });
});
