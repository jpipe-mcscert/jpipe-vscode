/**
 * Which compiler releases are installable, which is newest, and which hosts we will fetch from.
 *
 * Split out of `release-manager.ts` because that file imports `vscode` and so cannot be loaded
 * outside an extension host. Everything here is pure, and it decides what the install picker
 * offers and where a download is allowed to come from — worth pinning with tests.
 */

/** Only 2.x+ releases expose the `process` / `diagnostic` / `--headless doctor` subcommands
 *  the extension drives; older `jpipe.jar` releases predate them and are hidden. */
export const MIN_MAJOR = 2;

/** Asset name of the CLI jar in a 2.x release, e.g. `jpipe-cli-2.1.0.jar`. */
export const CLI_JAR_RE = /^jpipe-cli-.*\.jar$/;

/** Hosts we are willing to talk to. Any redirect outside this set is rejected. */
export const ALLOWED_HOSTS = new Set([
    'api.github.com',
    'github.com',
    'objects.githubusercontent.com',
]);

export interface JpipeRelease {
    tag: string;
    name: string;
    publishedAt: string;
    jarUrl: string;
    jarName: string;
    jarSize: number;
}

/**
 * True for the allowlisted hosts and any `*.githubusercontent.com` subdomain.
 *
 * The suffix test includes the leading dot deliberately: without it,
 * `evilgithubusercontent.com` would pass.
 */
export function isAllowedHost(host: string): boolean {
    return ALLOWED_HOSTS.has(host) || host.endsWith('.githubusercontent.com');
}

interface Version {
    nums: [number, number, number];
    /** Prerelease identifiers (e.g. `rc.1`), or undefined for a stable release. */
    pre: string | undefined;
}

/** Parse a release tag like `v2.1.0` or `v2.0.0-rc1` into its core version + prerelease. */
export function parseSemver(tag: string): { nums: [number, number, number]; pre: string | undefined } | undefined {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(tag.trim());
    if (!m) return undefined;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] };
}

/** Compare two prerelease strings per semver identifier rules (numeric < alphanumeric). */
export function comparePreRelease(a: string, b: string): number {
    const as = a.split('.');
    const bs = b.split('.');
    for (let i = 0; i < Math.max(as.length, bs.length); i++) {
        const x = as[i];
        const y = bs[i];
        if (x === undefined) return -1; // fewer identifiers = lower precedence
        if (y === undefined) return 1;
        const xn = /^\d+$/.test(x);
        const yn = /^\d+$/.test(y);
        if (xn && yn) { const d = Number(x) - Number(y); if (d !== 0) return Math.sign(d); }
        else if (xn) return -1;
        else if (yn) return 1;
        else if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

/** Full semver precedence: >0 if `a` is newer than `b`, <0 if older, 0 if equal. */
export function comparePrecedence(a: string, b: string): number {
    const va = parseSemver(a) as Version | undefined;
    const vb = parseSemver(b) as Version | undefined;
    if (!va || !vb) return 0;
    for (let i = 0; i < 3; i++) {
        if (va.nums[i] !== vb.nums[i]) return va.nums[i] - vb.nums[i];
    }
    // Same core version: a stable release outranks a prerelease of that version.
    if (va.pre === undefined && vb.pre === undefined) return 0;
    if (va.pre === undefined) return 1;
    if (vb.pre === undefined) return -1;
    return comparePreRelease(va.pre, vb.pre);
}

/** Sort comparator: newest version first (stable ahead of its own prereleases). */
export function compareSemverDesc(a: JpipeRelease, b: JpipeRelease): number {
    return comparePrecedence(b.tag, a.tag);
}

/** True when `candidate` has strictly higher precedence than `baseline`. */
export function isStrictlyNewer(candidate: string, baseline: string): boolean {
    return comparePrecedence(candidate, baseline) > 0;
}

/**
 * Reduces the GitHub releases payload to the installable ones, newest first.
 *
 * Dropped: drafts, prereleases (unless asked for), anything below {@link MIN_MAJOR}, anything
 * whose tag is not semver at all (which is how the rolling `unstable` tag is excluded), and
 * anything without a downloadable `jpipe-cli-*.jar` asset.
 *
 * @throws when the payload is not an array, i.e. the API answered with something unexpected.
 */
export function selectInstallableReleases(raw: unknown, includePrereleases: boolean): JpipeRelease[] {
    if (!Array.isArray(raw)) {
        throw new Error('Unexpected response from the GitHub releases API.');
    }

    const releases: JpipeRelease[] = [];
    for (const rel of raw as any[]) {
        if (rel?.draft) continue;
        if (rel?.prerelease && !includePrereleases) continue;
        const tag: string = rel?.tag_name ?? '';
        const semver = parseSemver(tag);
        if (!semver || semver.nums[0] < MIN_MAJOR) continue;

        const assets: any[] = Array.isArray(rel?.assets) ? rel.assets : [];
        const jar = assets.find(a => CLI_JAR_RE.test(a?.name ?? ''));
        if (!jar?.browser_download_url) continue;

        releases.push({
            tag,
            name: rel?.name || tag,
            publishedAt: rel?.published_at ?? '',
            jarUrl: jar.browser_download_url,
            jarName: jar.name,
            jarSize: typeof jar.size === 'number' ? jar.size : 0,
        });
    }
    releases.sort(compareSemverDesc);
    return releases;
}
