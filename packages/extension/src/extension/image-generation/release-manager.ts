import * as vscode from 'vscode';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { JpipeLogger } from '../logger.js';

/** GitHub repository that publishes the jPipe compiler releases. */
const RELEASE_REPO = 'jpipe-mcscert/jpipe-compiler';

/** Only 2.x+ releases expose the `process` / `diagnostic` / `--headless doctor` subcommands
 *  the extension drives; older `jpipe.jar` releases predate them and are hidden. */
const MIN_MAJOR = 2;

/** Asset name of the CLI jar in a 2.x release, e.g. `jpipe-cli-2.1.0.jar`. */
const CLI_JAR_RE = /^jpipe-cli-.*\.jar$/;

/** Hosts we are willing to talk to. Any redirect outside this set is rejected. */
const ALLOWED_HOSTS = new Set([
    'api.github.com',
    'github.com',
    'objects.githubusercontent.com',
]);

/** globalState keys. */
const KEY_INSTALLED = 'jpipe.managedCompiler';
const KEY_LAST_CHECK = 'jpipe.managedCompiler.lastUpdateCheck';

/** Only check for a newer release once per this window (ms). */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Follow at most this many HTTP redirects before giving up. */
const MAX_REDIRECTS = 5;

export interface JpipeRelease {
    tag: string;
    name: string;
    publishedAt: string;
    jarUrl: string;
    jarName: string;
    jarSize: number;
}

interface InstalledCompiler {
    tag: string;
    jarPath: string;
}

/** True for `objects.githubusercontent.com` and any `*.githubusercontent.com` subdomain. */
function isAllowedHost(host: string): boolean {
    return ALLOWED_HOSTS.has(host) || host.endsWith('.githubusercontent.com');
}

/** Parse a release tag like `v2.1.0` / `2.0.0` into its major/minor/patch, or undefined. */
function parseSemver(tag: string): [number, number, number] | undefined {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag.trim());
    if (!m) return undefined;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Sort comparator: newest semver first. */
function compareSemverDesc(a: JpipeRelease, b: JpipeRelease): number {
    const sa = parseSemver(a.tag) ?? [0, 0, 0];
    const sb = parseSemver(b.tag) ?? [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        if (sb[i] !== sa[i]) return sb[i] - sa[i];
    }
    return 0;
}

/** True when `candidate` is a strictly higher semver than `baseline`. */
function isStrictlyNewer(candidate: string, baseline: string): boolean {
    const c = parseSemver(candidate);
    const b = parseSemver(baseline);
    if (!c || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (c[i] !== b[i]) return c[i] > b[i];
    }
    return false;
}

/**
 * Downloads, stores, and tracks a jPipe compiler jar pulled from the GitHub releases page,
 * so the "managed" execution mode can run it without the user wiring up a path by hand.
 */
export class ReleaseManager {

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly logger: JpipeLogger
    ) {}

    /** List installable (stable, v2.0.0+) releases, newest first. Throws on network/API failure. */
    public async listReleases(): Promise<JpipeRelease[]> {
        const url = `https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=100`;
        const raw = await this.httpsGetJson(url);
        if (!Array.isArray(raw)) {
            throw new Error('Unexpected response from the GitHub releases API.');
        }

        const releases: JpipeRelease[] = [];
        for (const rel of raw as any[]) {
            if (rel?.draft || rel?.prerelease) continue;
            const tag: string = rel?.tag_name ?? '';
            const semver = parseSemver(tag);
            if (!semver || semver[0] < MIN_MAJOR) continue;

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
        this.logger.debug(`Found ${releases.length} installable jPipe release(s)`);
        return releases;
    }

    /**
     * Download the jar for `release` into hidden global storage and return its path.
     * Idempotent: an already-present jar with the expected byte size is reused.
     */
    public async download(
        release: JpipeRelease,
        onProgress?: (fraction: number) => void
    ): Promise<string> {
        const destDir = path.join(this.compilerRoot(), release.tag);
        const destPath = path.join(destDir, release.jarName);

        if (fs.existsSync(destPath) && this.sizeMatches(destPath, release.jarSize)) {
            this.logger.info(`Reusing already-downloaded jPipe ${release.tag}`);
            return destPath;
        }

        await fs.promises.mkdir(destDir, { recursive: true });
        const partPath = `${destPath}.part`;
        await fs.promises.rm(partPath, { force: true });

        this.logger.info(`Downloading jPipe ${release.tag} from ${release.jarUrl}`);
        const sha256 = await this.httpsDownloadToFile(release.jarUrl, partPath, release.jarSize, onProgress);

        // Verify the payload before making it visible under its final name.
        if (release.jarSize > 0 && !this.sizeMatches(partPath, release.jarSize)) {
            await fs.promises.rm(partPath, { force: true });
            throw new Error(`Downloaded jar size mismatch for ${release.tag} (expected ${release.jarSize} bytes).`);
        }
        await fs.promises.rename(partPath, destPath);
        this.logger.info(`Installed jPipe ${release.tag} → ${destPath} (sha256: ${sha256})`);
        return destPath;
    }

    /** The currently installed managed compiler, or undefined if none / the file vanished. */
    public getInstalled(): InstalledCompiler | undefined {
        const installed = this.context.globalState.get<InstalledCompiler>(KEY_INSTALLED);
        if (!installed?.jarPath) return undefined;
        if (!fs.existsSync(installed.jarPath)) {
            this.logger.warn(`Managed jPipe jar missing on disk: ${installed.jarPath}`);
            return undefined;
        }
        return installed;
    }

    /** Record the active managed compiler. */
    public async setInstalled(tag: string, jarPath: string): Promise<void> {
        await this.context.globalState.update(KEY_INSTALLED, { tag, jarPath } satisfies InstalledCompiler);
    }

    /**
     * If a managed compiler is installed and a strictly-newer stable release exists, show a
     * non-blocking notification offering to update. Throttled to once per day and
     * silent on any failure (this runs opportunistically at activation).
     */
    public async maybeNotifyUpdate(runInstall: (preselectTag: string) => Promise<void>): Promise<void> {
        const installed = this.getInstalled();
        if (!installed) return;

        const last = this.context.globalState.get<number>(KEY_LAST_CHECK, 0);
        if (Date.now() - last < UPDATE_CHECK_INTERVAL_MS) return;
        await this.context.globalState.update(KEY_LAST_CHECK, Date.now());

        try {
            const releases = await this.listReleases();
            const latest = releases[0]; // sorted newest-first
            if (!latest || !isStrictlyNewer(latest.tag, installed.tag)) return;

            const sel = await vscode.window.showInformationMessage(
                `A newer jPipe compiler (${latest.tag}) is available. You have ${installed.tag}.`,
                'Update'
            );
            if (sel === 'Update') await runInstall(latest.tag);
        } catch (err) {
            this.logger.debug(`Update check skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // ---- internals -------------------------------------------------------

    private compilerRoot(): string {
        return path.join(this.context.globalStorageUri.fsPath, 'compiler');
    }

    private sizeMatches(filePath: string, expected: number): boolean {
        if (expected <= 0) return true; // API did not report a size; skip the check
        try {
            return fs.statSync(filePath).size === expected;
        } catch {
            return false;
        }
    }

    /** HTTPS GET returning parsed JSON. Enforces host allowlist and follows redirects. */
    private httpsGetJson(url: string, redirects = 0): Promise<unknown> {
        return new Promise((resolve, reject) => {
            this.get(url, redirects, reject, res => {
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    resolve(this.httpsGetJson(this.resolveRedirect(url, res.headers.location), redirects + 1));
                    return;
                }
                if (status === 403) {
                    res.resume();
                    reject(new Error('GitHub API rate limit reached. Please try again later.'));
                    return;
                }
                if (status !== 200) {
                    res.resume();
                    reject(new Error(`GitHub API request failed (HTTP ${status}).`));
                    return;
                }
                const chunks: Buffer[] = [];
                res.on('data', c => chunks.push(c as Buffer));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch {
                        reject(new Error('Could not parse the GitHub API response.'));
                    }
                });
                res.on('error', reject);
            });
        });
    }

    /** Stream a URL to `dest`, returning the payload's SHA-256. Enforces host allowlist + redirects. */
    private httpsDownloadToFile(
        url: string,
        dest: string,
        expectedSize: number,
        onProgress?: (fraction: number) => void,
        redirects = 0
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            this.get(url, redirects, reject, res => {
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    resolve(this.httpsDownloadToFile(
                        this.resolveRedirect(url, res.headers.location), dest, expectedSize, onProgress, redirects + 1
                    ));
                    return;
                }
                if (status !== 200) {
                    res.resume();
                    reject(new Error(`Download failed (HTTP ${status}).`));
                    return;
                }

                const total = expectedSize > 0
                    ? expectedSize
                    : Number(res.headers['content-length'] ?? 0);
                const hash = crypto.createHash('sha256');
                const file = fs.createWriteStream(dest);
                let received = 0;

                res.on('data', (chunk: Buffer) => {
                    hash.update(chunk);
                    received += chunk.length;
                    if (onProgress && total > 0) onProgress(Math.min(received / total, 1));
                });
                res.pipe(file);
                file.on('finish', () => file.close(() => resolve(hash.digest('hex'))));
                file.on('error', err => fs.rm(dest, { force: true }, () => reject(err)));
                res.on('error', err => fs.rm(dest, { force: true }, () => reject(err)));
            });
        });
    }

    /**
     * Issue a validated HTTPS GET. Rejects non-HTTPS URLs, disallowed hosts, and excessive
     * redirects *before* opening a socket, then invokes `onResponse` with the response.
     */
    private get(
        url: string,
        redirects: number,
        onError: (err: Error) => void,
        onResponse: (res: IncomingMessage) => void
    ): void {
        if (redirects > MAX_REDIRECTS) {
            onError(new Error('Too many redirects.'));
            return;
        }
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            onError(new Error(`Invalid URL: ${url}`));
            return;
        }
        if (parsed.protocol !== 'https:') {
            onError(new Error(`Refusing non-HTTPS URL: ${url}`));
            return;
        }
        if (!isAllowedHost(parsed.hostname)) {
            onError(new Error(`Refusing to contact untrusted host: ${parsed.hostname}`));
            return;
        }
        const req = https.get(url, {
            headers: {
                'User-Agent': 'jpipe-vscode',
                'Accept': 'application/vnd.github+json',
            },
        }, onResponse);
        req.on('error', onError);
    }

    /** Resolve a possibly-relative redirect Location against the request URL. */
    private resolveRedirect(from: string, location: string): string {
        try {
            return new URL(location, from).toString();
        } catch {
            return location;
        }
    }
}
