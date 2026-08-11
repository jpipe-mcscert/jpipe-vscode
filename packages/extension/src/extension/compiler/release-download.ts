/**
 * Fetching a jPipe compiler release from GitHub and putting it on disk.
 *
 * Everything here is Node and nothing is VS Code: no `vscode` import, no editor state, no
 * settings lookups. That is the point. This logic used to live inside `ReleaseManager`, which
 * takes an `ExtensionContext`, and so could not be loaded by a test at all — roughly 250 lines
 * of HTTP, redirect handling, host validation and file placement excluded from coverage because
 * of five `vscode.*` references elsewhere in the same class (jpipe-vscode ADR-VSC-0004).
 *
 * `ReleaseManager` is now the adapter: it reads settings, owns `globalState`, and asks the user
 * things. It calls in here for the work.
 */

import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { isAllowedHost, type JpipeRelease } from './release-selection.js';

/** Default GitHub repository that publishes the jPipe compiler releases. */
export const DEFAULT_RELEASE_REPO = 'jpipe-mcscert/jpipe-compiler';

/** Fallback update-check interval (hours) when `jpipe.managedUpdateCheckIntervalHours` is unset. */
export const DEFAULT_UPDATE_INTERVAL_HOURS = 24;

/** Follow at most this many HTTP redirects before giving up. */
export const MAX_REDIRECTS = 5;

/**
 * The logging this module needs.
 *
 * Structural, rather than importing `JpipeLogger`, so that nothing here depends on a class whose
 * constructor takes an `ExtensionContext`. `JpipeLogger` satisfies it; so does a spy.
 */
export interface DownloadLog {
    info(message: string): void;
    warn(message: string): void;
    debug(message: string): void;
}

/**
 * The `owner/repo` to pull releases from, given whatever the setting holds.
 *
 * Only a strict `owner/repo` slug is accepted: the value is interpolated into an api.github.com
 * URL, so something containing a slash-dot sequence or a query string could point the request
 * somewhere else entirely. Anything that fails the pattern falls back to the default, loudly
 * when the user had clearly tried to set something.
 */
export function resolveRepo(configured: string | undefined, log?: DownloadLog): string {
    const value = (configured ?? '').trim();
    if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) return value;
    if (value && value !== DEFAULT_RELEASE_REPO) {
        log?.warn(`Ignoring invalid jpipe.managedRepository '${value}'; using ${DEFAULT_RELEASE_REPO}.`);
    }
    return DEFAULT_RELEASE_REPO;
}

/** The releases endpoint for a repository slug. */
export function releasesUrl(repo: string): string {
    return `https://api.github.com/repos/${repo}/releases?per_page=100`;
}

/** Where managed compilers live under the extension's global storage. */
export function compilerRootIn(globalStorageRoot: string): string {
    return path.join(globalStorageRoot, 'compiler');
}

/**
 * Whether an update check is due.
 *
 * A non-positive or non-numeric interval falls back to the default rather than checking on every
 * activation, which is what a `0` in the setting would otherwise mean.
 */
export function isDueForUpdateCheck(lastCheckMs: number, nowMs: number, intervalHours: unknown): boolean {
    const hours = typeof intervalHours === 'number' && intervalHours > 0
        ? intervalHours
        : DEFAULT_UPDATE_INTERVAL_HOURS;

    const elapsed = nowMs - lastCheckMs;
    // A negative elapsed time means the stored check is in the future: the clock was wrong when
    // it was written, or has since been moved back. Waiting for it to catch up would suppress
    // update checks for however far out that timestamp is — potentially indefinitely — so treat
    // it as due and let the next run rewrite the stamp with a sane value.
    if (elapsed < 0) return true;

    return elapsed >= hours * 3_600_000;
}

/**
 * Whether the file at `filePath` is the size the API said it would be.
 *
 * A non-positive `expected` means the API did not report a size, and the check is skipped rather
 * than failed — refusing a download because GitHub omitted a field would be worse than accepting
 * one this cannot confirm.
 */
export function sizeMatches(filePath: string, expected: number): boolean {
    if (expected <= 0) return true;
    try {
        return fs.statSync(filePath).size === expected;
    } catch {
        return false;
    }
}

/** Resolve a possibly-relative redirect Location against the request URL. */
export function resolveRedirect(from: string, location: string): string {
    try {
        return new URL(location, from).toString();
    } catch {
        return location;
    }
}

/**
 * Check a URL before a socket is opened, throwing if it must not be requested.
 *
 * Separated out and exported because it is the security boundary of this module — HTTPS only, a
 * host allowlist, a redirect ceiling — and it was previously buried in a private method of a
 * class no test could construct.
 */
export function validateRequestUrl(url: string, redirects: number): URL {
    if (redirects > MAX_REDIRECTS) throw new Error('Too many redirects.');

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Invalid URL: ${url}`);
    }
    if (parsed.protocol !== 'https:') throw new Error(`Refusing non-HTTPS URL: ${url}`);
    if (!isAllowedHost(parsed.hostname)) throw new Error(`Refusing to contact untrusted host: ${parsed.hostname}`);
    return parsed;
}

/**
 * How a request is actually made.
 *
 * Injectable so the response handling below — redirects, rate limits, malformed bodies — can be
 * exercised without a socket. The allowlist in `validateRequestUrl` refuses anything but
 * github.com hosts, so a local test server could not be reached even if one were started; making
 * the transport a parameter is the only way this logic is testable at all.
 */
export type Transport = (
    url: string,
    onResponse: (res: IncomingMessage) => void,
    onError: (err: Error) => void
) => void;

/** The real one: HTTPS, with the headers the GitHub API expects. */
export const httpsTransport: Transport = (url, onResponse, onError) => {
    const req = https.get(url, {
        headers: {
            'User-Agent': 'jpipe-vscode',
            'Accept': 'application/vnd.github+json'
        }
    }, onResponse);
    req.on('error', onError);
};

/** Issue a validated GET, rejecting before opening a socket if the URL is not allowed. */
function get(
    url: string,
    redirects: number,
    onError: (err: Error) => void,
    onResponse: (res: IncomingMessage) => void,
    transport: Transport = httpsTransport
): void {
    try {
        validateRequestUrl(url, redirects);
    } catch (err) {
        onError(err as Error);
        return;
    }
    transport(url, onResponse, onError);
}

/** HTTPS GET returning parsed JSON. Enforces the host allowlist and follows redirects. */
export function httpsGetJson(url: string, redirects = 0, transport: Transport = httpsTransport): Promise<unknown> {
    return new Promise((resolve, reject) => {
        get(url, redirects, reject, res => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                resolve(httpsGetJson(resolveRedirect(url, res.headers.location), redirects + 1, transport));
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
        }, transport);
    });
}

/** Stream a URL to `dest`, returning the payload's SHA-256. Enforces allowlist + redirects. */
export function httpsDownloadToFile(
    url: string,
    dest: string,
    expectedSize: number,
    onProgress?: (fraction: number) => void,
    redirects = 0,
    transport: Transport = httpsTransport
): Promise<string> {
    return new Promise((resolve, reject) => {
        get(url, redirects, reject, res => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                resolve(httpsDownloadToFile(
                    resolveRedirect(url, res.headers.location), dest, expectedSize, onProgress, redirects + 1, transport
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
        }, transport);
    });
}

/**
 * Download `release`'s jar under `compilerRoot` and return its path.
 *
 * Idempotent: an already-present jar of the expected size is reused rather than re-fetched.
 *
 * The payload is written to a `.part` file and only renamed into place once its size checks out,
 * so an interrupted download can never leave something that looks like an installed compiler.
 * Note this is a size check, not a checksum comparison — the SHA-256 is computed and logged, but
 * GitHub publishes no digest to compare it against, so it is a record rather than a gate.
 */
export async function downloadJar(
    release: JpipeRelease,
    compilerRoot: string,
    log: DownloadLog,
    onProgress?: (fraction: number) => void
): Promise<string> {
    const destDir = path.join(compilerRoot, release.tag);
    const destPath = path.join(destDir, release.jarName);

    if (fs.existsSync(destPath) && sizeMatches(destPath, release.jarSize)) {
        log.info(`Reusing already-downloaded jPipe ${release.tag}`);
        return destPath;
    }

    await fs.promises.mkdir(destDir, { recursive: true });
    const partPath = `${destPath}.part`;
    await fs.promises.rm(partPath, { force: true });

    log.info(`Downloading jPipe ${release.tag} from ${release.jarUrl}`);
    const sha256 = await httpsDownloadToFile(release.jarUrl, partPath, release.jarSize, onProgress);

    if (release.jarSize > 0 && !sizeMatches(partPath, release.jarSize)) {
        await fs.promises.rm(partPath, { force: true });
        throw new Error(`Downloaded jar size mismatch for ${release.tag} (expected ${release.jarSize} bytes).`);
    }
    // Remove any stale/partial file at the destination first: fs.rename fails on Windows when
    // the target already exists, which would block re-download/retry.
    await fs.promises.rm(destPath, { force: true });
    await fs.promises.rename(partPath, destPath);
    log.info(`Installed jPipe ${release.tag} → ${destPath} (sha256: ${sha256})`);
    return destPath;
}
