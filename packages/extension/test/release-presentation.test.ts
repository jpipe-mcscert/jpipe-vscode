import { describe, expect, test } from 'vitest';
import {
    accessMethodHeader,
    formatReleaseDate,
    releaseQuickPickItems
} from '../src/extension/compiler/release-presentation.js';
import type { JpipeRelease } from '../src/extension/compiler/release-selection.js';

/**
 * The text the release picker and the installation check put in front of a user.
 *
 * Testable only because it was moved out of the install flow: beside
 * `vscode.window.showQuickPick` this was as unreachable as the dialog itself.
 */

const release = (tag: string, publishedAt = '2026-07-01T00:00:00Z'): JpipeRelease => ({
    tag,
    name: `jPipe ${tag}`,
    publishedAt,
    jarUrl: `https://objects.githubusercontent.com/${tag}.jar`,
    jarName: `jpipe-cli-${tag}.jar`,
    jarSize: 100
});

describe('formatReleaseDate', () => {
    test('renders an ISO timestamp as a short date', () => {
        // Locale-dependent by design, so assert the parts rather than an exact rendering.
        const shown = formatReleaseDate('2026-07-01T00:00:00Z');
        expect(shown).toMatch(/2026/);
        expect(shown).not.toBe('2026-07-01T00:00:00Z');
    });

    test('passes an unparseable value through instead of showing "Invalid Date"', () => {
        // The field comes from the GitHub API; echoing what arrived at least says what it was.
        expect(formatReleaseDate('not a date')).toBe('not a date');
        expect(formatReleaseDate('')).toBe('');
    });
});

describe('releaseQuickPickItems', () => {
    const releases = [release('v2.3.0'), release('v2.2.0'), release('v2.1.0')];

    test('labels each row with its tag and keeps the release for the caller', () => {
        const items = releaseQuickPickItems(releases, undefined);
        expect(items.map(i => i.label)).toEqual(['v2.3.0', 'v2.2.0', 'v2.1.0']);
        expect(items[0].release).toBe(releases[0]);
        expect(items[0].detail).toBe('jPipe v2.3.0');
    });

    test('marks the first as latest, because the list arrives newest-first', () => {
        const items = releaseQuickPickItems(releases, undefined);
        expect(items[0].description).toContain('latest');
        expect(items[1].description).not.toContain('latest');
    });

    test('marks the installed release wherever it sits', () => {
        const items = releaseQuickPickItems(releases, { tag: 'v2.2.0' });
        expect(items[1].description).toContain('installed');
        expect(items[0].description).not.toContain('installed');
    });

    test('marks a release that is both latest and installed with both', () => {
        const items = releaseQuickPickItems(releases, { tag: 'v2.3.0' });
        expect(items[0].description).toContain('latest');
        expect(items[0].description).toContain('installed');
    });

    test('leaves no dangling separator when only the date applies', () => {
        // The parts are filtered before joining; without that an uninstalled, non-latest row
        // would read "1 Jul 2026  ·    ·  ".
        const items = releaseQuickPickItems(releases, undefined);
        expect(items[1].description).not.toMatch(/·\s*$/);
        expect(items[1].description).not.toMatch(/·\s+·/);
    });

    test('is empty for an empty list', () => {
        expect(releaseQuickPickItems([], undefined)).toEqual([]);
    });
});

describe('accessMethodHeader', () => {
    test.each([['cli'], ['jar']])('names the mode plainly for %s', (mode) => {
        expect(accessMethodHeader(mode, undefined)).toBe(`Access method: ${mode}`);
    });

    test('names the installed release in managed mode', () => {
        expect(accessMethodHeader('managed', { tag: 'v2.3.0' }))
            .toBe('Access method: managed (GitHub Release v2.3.0)');
    });

    test('says so when managed mode has nothing installed', () => {
        // The case actually worth reporting: managed mode is the only one whose answer depends
        // on state the user cannot see from the settings.
        expect(accessMethodHeader('managed', undefined))
            .toBe('Access method: managed (GitHub Release — none installed)');
    });

    test('ignores an installed release when the mode is not managed', () => {
        expect(accessMethodHeader('cli', { tag: 'v2.3.0' })).toBe('Access method: cli');
    });
});
