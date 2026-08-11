/**
 * How releases are described to the user.
 *
 * Split out of the install flow because none of it needs an extension host: these are decisions
 * about text and ordering, and putting them beside `vscode.window.showQuickPick` would have made
 * them untestable along with it (jpipe-vscode ADR-VSC-0004).
 *
 * The `vscode` import here is **type-only** and erases at compile time, so nothing at runtime
 * reaches for a module that only exists inside the editor. `QuickPickItem` is an interface; the
 * objects below are plain data that happen to satisfy it.
 */

import type * as vscode from 'vscode';
import type { JpipeRelease } from './release-selection.js';

/** An installed managed compiler, as `ReleaseManager` records it. */
export interface InstalledCompilerTag {
    tag: string;
}

/** A release as it appears in the picker, with the release kept for the caller. */
export interface ReleasePick extends vscode.QuickPickItem {
    release: JpipeRelease;
}

/**
 * `2026-07-01T00:00:00Z` → a short local date.
 *
 * An unparseable value is passed through rather than rendered as "Invalid Date": the field comes
 * from the GitHub API, and showing the raw string at least says what was received.
 */
export function formatReleaseDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The picker's rows.
 *
 * The first release is the latest, because the list arrives newest-first; saying so saves the
 * reader comparing dates. Marking the installed one heads off the commonest mistake in this
 * dialog, which is reinstalling what you already have.
 */
export function releaseQuickPickItems(
    releases: readonly JpipeRelease[],
    installed: InstalledCompilerTag | undefined
): ReleasePick[] {
    return releases.map((release, index) => ({
        label: release.tag,
        description: [
            formatReleaseDate(release.publishedAt),
            index === 0 ? '$(star-full) latest' : '',
            release.tag === installed?.tag ? '$(check) installed' : ''
        ].filter(Boolean).join('  ·  '),
        detail: release.name,
        release
    }));
}

/**
 * The first line of the "is jPipe accessible?" report.
 *
 * Managed mode is the only one whose answer depends on state the user cannot see, so it is the
 * only one that names what was found — including when nothing was, which is the case actually
 * worth telling them about.
 */
export function accessMethodHeader(mode: string, installed: InstalledCompilerTag | undefined): string {
    if (mode !== 'managed') return `Access method: ${mode}`;
    return `Access method: managed (GitHub Release${installed ? ` ${installed.tag}` : ' — none installed'})`;
}
