import * as vscode from 'vscode';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { JpipeLogger } from '../logger.js';
import {
    isAllowedHost,
    isStrictlyNewer,
    selectInstallableReleases,
    type JpipeRelease
} from './release-selection.js';

/** Default GitHub repository that publishes the jPipe compiler releases. */
const DEFAULT_RELEASE_REPO = 'jpipe-mcscert/jpipe-compiler';

/** globalState keys. */
const KEY_INSTALLED = 'jpipe.managedCompiler';
const KEY_LAST_CHECK = 'jpipe.managedCompiler.lastUpdateCheck';

/** Fallback update-check interval (hours) when `jpipe.managedUpdateCheckIntervalHours` is unset. */
const DEFAULT_UPDATE_INTERVAL_HOURS = 24;

/** Follow at most this many HTTP redirects before giving up. */
const MAX_REDIRECTS = 5;

interface InstalledCompiler {
    tag: string;
    jarPath: string;
}

// Re-exported so `import { JpipeRelease } from './release-manager.js'` keeps working.
export type { JpipeRelease };

/**
 * Downloads, stores, and tracks a jPipe compiler jar pulled from the GitHub releases page,
 * so the "managed" execution mode can run it without the user wiring up a path by hand.
 */
export class ReleaseManager {

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly logger: JpipeLogger
    ) {}

    /**
     * List installable releases (v2.0.0+ with a `jpipe-cli-*.jar` asset), newest first.
     * Excludes pre-releases unless `jpipe.managedIncludePrereleases` is enabled; the rolling
     * non-semver `unstable` tag is always excluded. Throws on network/API failure.
     */
    public async listReleases(): Promise<JpipeRelease[]> {
        const config = vscode.workspace.getConfiguration('jpipe');
        const includePrereleases = config.get<boolean>('managedIncludePrereleases', false);
        const url = `https://api.github.com/repos/${this.repo()}/releases?per_page=100`;
        const raw = await this.httpsGetJson(url);
        const releases = selectInstallableReleases(raw, includePrereleases);
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
        // Remove any stale/partial file at the destination first: fs.rename fails on
        // Windows when the target already exists, which would block re-download/retry.
        await fs.promises.rm(destPath, { force: true });
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
     * If the extension is in managed mode with a compiler installed and a strictly-newer
     * release exists, show a non-blocking notification offering to update. Throttled and
     * silent on any failure (this runs opportunistically at activation).
     */
    public async maybeNotifyUpdate(runInstall: (preselectTag: string) => Promise<void>): Promise<void> {
        const config = vscode.workspace.getConfiguration('jpipe');
        // Managed-mode only: don't prompt when the user is running cli/jar even if a
        // managed jar happens to be installed (matches jpipe.managedCheckForUpdates' scope).
        if (config.get<string>('executionMode', 'cli') !== 'managed') return;
        if (!config.get<boolean>('managedCheckForUpdates', true)) return;

        const installed = this.getInstalled();
        if (!installed) return;

        const hours = config.get<number>('managedUpdateCheckIntervalHours', DEFAULT_UPDATE_INTERVAL_HOURS);
        const intervalMs = (typeof hours === 'number' && hours > 0 ? hours : DEFAULT_UPDATE_INTERVAL_HOURS) * 3_600_000;
        const last = this.context.globalState.get<number>(KEY_LAST_CHECK, 0);
        if (Date.now() - last < intervalMs) return;
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

    /** The `owner/repo` releases are pulled from (configurable for forks/testing). */
    private repo(): string {
        const configured = (vscode.workspace.getConfiguration('jpipe').get<string>('managedRepository', DEFAULT_RELEASE_REPO) ?? '').trim();
        // Accept only a strict owner/repo slug; anything else could distort the API URL.
        if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(configured)) return configured;
        if (configured && configured !== DEFAULT_RELEASE_REPO) {
            this.logger.warn(`Ignoring invalid jpipe.managedRepository '${configured}'; using ${DEFAULT_RELEASE_REPO}.`);
        }
        return DEFAULT_RELEASE_REPO;
    }

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
