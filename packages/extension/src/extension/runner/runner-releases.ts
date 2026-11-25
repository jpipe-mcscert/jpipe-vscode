/**
 * The jpipe-runner releases a workspace can choose from, as PyPI lists them, and how the picker
 * shows them. No VS Code, so it is tested (jpipe-vscode ADR-VSC-0004, ADR-VSC-0036).
 */
import { MIN_RUNNER } from './python-environment.js';
import { formatRelease, meetsMinimum, RUNNER_FEATURES } from '../requirements.js';

/** PyPI's JSON API for jpipe-runner: every release, with its files. */
export const PYPI_RELEASES_URL = 'https://pypi.org/pypi/jpipe-runner/json';

/** The one host the release list is asked of. */
export const isPypiHost = (host: string): boolean => host === 'pypi.org';

export interface RunnerRelease {
    /** `4.5.0`. */
    version: string;
    /** When its first file was uploaded, `2026-11-20`, when PyPI says. */
    date?: string;
}

/** `4.5.0` as numbers, or undefined when it is not a final release: a pre-release, a dev build. */
function finalNumbers(version: string): number[] | undefined {
    return /^\d+(\.\d+)*$/.test(version) ? version.split('.').map(Number) : undefined;
}

/** Newest first, comparing release numbers part by part (`4.10.0` after `4.9.0`). */
function newerFirst(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (b[i] ?? 0) - (a[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * The releases PyPI's answer lists that a workspace may choose: final releases from the minimum
 * this extension works with, with at least one file that is not yanked, newest first. Anything the
 * answer does not say plainly is left out rather than guessed at.
 */
export function choosableReleases(answer: unknown): RunnerRelease[] {
    const releases = (answer as { releases?: unknown } | null)?.releases;
    if (releases === null || typeof releases !== 'object') throw new Error('PyPI did not list any jpipe-runner release.');
    const found: { release: RunnerRelease; numbers: number[] }[] = [];
    for (const [version, files] of Object.entries(releases as Record<string, unknown>)) {
        const numbers = finalNumbers(version);
        if (!numbers || !meetsMinimum(numbers, MIN_RUNNER) || !Array.isArray(files)) continue;
        const available = files.filter((file: { yanked?: unknown }) => file?.yanked !== true);
        if (available.length === 0) continue;
        const uploaded = available
            .map((file: { upload_time_iso_8601?: unknown }) => file?.upload_time_iso_8601)
            .filter((time): time is string => typeof time === 'string')
            .sort()[0];
        found.push({ release: { version, ...(uploaded ? { date: uploaded.slice(0, 10) } : {}) }, numbers });
    }
    return found.sort((a, b) => newerFirst(a.numbers, b.numbers)).map(entry => entry.release);
}

/** One entry of the picker: a release to choose, or `''`, to choose none. */
export interface ReleaseItem {
    label: string;
    description?: string;
    detail?: string;
    version: string;
}

/**
 * The picker's entries: no particular release first, then each release, newest first.
 *
 * Each says what the user needs to tell them apart: which is the newest, which the environment
 * has, which the settings choose now, when it was published, and what it brings, as Check jPipe
 * Installation says it.
 */
export function releaseItems(releases: readonly RunnerRelease[], now: { installed?: string; chosen?: string }): ReleaseItem[] {
    const brings = new Map(Object.values(RUNNER_FEATURES).map(feature => [formatRelease(feature.since), feature.brings]));
    const none: ReleaseItem = {
        label: 'Any release',
        description: now.chosen ? undefined : 'chosen',
        detail: `None in particular: any from ${MIN_RUNNER.join('.')} on. A new environment gets the newest.`,
        version: ''
    };
    return [none, ...releases.map((release, i) => {
        const marks = [
            i === 0 ? 'newest' : undefined,
            release.version === now.installed ? 'installed' : undefined,
            release.version === now.chosen ? 'chosen' : undefined
        ].filter(Boolean);
        const detail = [
            release.date ? `Published ${release.date}` : undefined,
            brings.has(release.version) ? `the first that ${brings.get(release.version)}` : undefined
        ].filter(Boolean).join(' · ');
        return {
            label: release.version,
            ...(marks.length ? { description: marks.join(', ') } : {}),
            ...(detail ? { detail } : {}),
            version: release.version
        };
    })];
}
