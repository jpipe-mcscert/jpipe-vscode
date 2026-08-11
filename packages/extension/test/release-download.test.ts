import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterAll, describe, expect, test } from 'vitest';
import {
    DEFAULT_RELEASE_REPO,
    DEFAULT_UPDATE_INTERVAL_HOURS,
    compilerRootIn,
    downloadJar,
    isDueForUpdateCheck,
    releasesUrl,
    resolveRedirect,
    resolveRepo,
    sizeMatches,
    validateRequestUrl,
    httpsGetJson,
    type DownloadLog,
    type Transport
} from '../src/extension/compiler/release-download.js';

/**
 * The half of managed-compiler installs that does not need an editor.
 *
 * All of this ran untested until it was pulled out of `ReleaseManager`, which takes an
 * `ExtensionContext` and so cannot be constructed here. That included the host allowlist and the
 * HTTPS-only rule — security decisions with no coverage at all.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jpipe-release-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Collects what the code decided to say, so warnings can be asserted rather than guessed at. */
function recordingLog(): DownloadLog & { lines: string[] } {
    const lines: string[] = [];
    return {
        lines,
        info: (m) => lines.push(`info: ${m}`),
        warn: (m) => lines.push(`warn: ${m}`),
        debug: (m) => lines.push(`debug: ${m}`)
    };
}

describe('validateRequestUrl — the security boundary', () => {
    test('accepts the GitHub API over https', () => {
        expect(validateRequestUrl('https://api.github.com/repos/x/y/releases', 0).hostname)
            .toBe('api.github.com');
    });

    test.each([
        ['http', 'http://api.github.com/x', 'Refusing non-HTTPS URL'],
        ['ftp', 'ftp://api.github.com/x', 'Refusing non-HTTPS URL'],
        // A downgrade to plain HTTP is the whole reason this check exists: the payload becomes a
        // jar that gets executed, so an interceptable transport is not a cosmetic problem.
        ['file', 'file:///etc/passwd', 'Refusing non-HTTPS URL']
    ])('rejects %s', (_label, url, expected) => {
        expect(() => validateRequestUrl(url, 0)).toThrow(expected);
    });

    test.each([
        'https://evil.example.com/jpipe.jar',
        'https://api.github.com.evil.example.com/x',
        'https://notgithub.com/x'
    ])('rejects the untrusted host %s', (url) => {
        expect(() => validateRequestUrl(url, 0)).toThrow('Refusing to contact untrusted host');
    });

    test('rejects a malformed URL before opening a socket', () => {
        expect(() => validateRequestUrl('not a url', 0)).toThrow('Invalid URL');
    });

    test('stops a redirect loop', () => {
        expect(() => validateRequestUrl('https://api.github.com/x', 6)).toThrow('Too many redirects');
        // The ceiling itself is still allowed; only beyond it is refused.
        expect(() => validateRequestUrl('https://api.github.com/x', 5)).not.toThrow();
    });
});

describe('resolveRepo', () => {
    test('accepts a plain owner/repo slug', () => {
        expect(resolveRepo('someone/their-fork')).toBe('someone/their-fork');
    });

    test('trims surrounding whitespace', () => {
        expect(resolveRepo('  someone/their-fork  ')).toBe('someone/their-fork');
    });

    test.each([
        ['a URL', 'https://github.com/a/b'],
        ['a path traversal', '../../evil'],
        ['a query string', 'a/b?x=1'],
        ['too many segments', 'a/b/c'],
        ['no slash', 'justaname'],
        ['empty', '']
    ])('falls back to the default for %s', (_label, value) => {
        // The value is interpolated into an api.github.com URL, so anything that could steer the
        // request elsewhere has to be refused rather than sanitised.
        expect(resolveRepo(value)).toBe(DEFAULT_RELEASE_REPO);
    });

    test('warns when a deliberate value was ignored, but not when the field is simply empty', () => {
        const noisy = recordingLog();
        resolveRepo('https://github.com/a/b', noisy);
        expect(noisy.lines.some(l => l.startsWith('warn:'))).toBe(true);

        const quiet = recordingLog();
        resolveRepo('', quiet);
        resolveRepo(undefined, quiet);
        resolveRepo(DEFAULT_RELEASE_REPO, quiet);
        expect(quiet.lines).toEqual([]);
    });
});

describe('releasesUrl and compilerRootIn', () => {
    test('builds the releases endpoint', () => {
        expect(releasesUrl('a/b')).toBe('https://api.github.com/repos/a/b/releases?per_page=100');
    });

    test('puts compilers under the storage root', () => {
        expect(compilerRootIn(join('/storage', 'jpipe'))).toBe(join('/storage', 'jpipe', 'compiler'));
    });
});

describe('isDueForUpdateCheck', () => {
    const hour = 3_600_000;

    test('is due once the interval has elapsed', () => {
        expect(isDueForUpdateCheck(0, 25 * hour, 24)).toBe(true);
        expect(isDueForUpdateCheck(0, 23 * hour, 24)).toBe(false);
    });

    test('is due exactly on the boundary', () => {
        expect(isDueForUpdateCheck(0, 24 * hour, 24)).toBe(true);
    });

    test('is always due on a first run, where there is no recorded check', () => {
        expect(isDueForUpdateCheck(0, Date.parse('2026-08-11T00:00:00Z'), 24)).toBe(true);
    });

    test.each([[0], [-5], [undefined], [null], ['24'], [NaN]])(
        'falls back to the default interval for %j rather than checking every activation',
        (interval) => {
            const almost = DEFAULT_UPDATE_INTERVAL_HOURS * hour - 1;
            expect(isDueForUpdateCheck(0, almost, interval)).toBe(false);
            expect(isDueForUpdateCheck(0, almost + 1, interval)).toBe(true);
        });
});

describe('sizeMatches', () => {
    const file = join(scratch, 'payload.bin');
    writeFileSync(file, 'x'.repeat(100));

    test('matches the exact byte count', () => {
        expect(sizeMatches(file, 100)).toBe(true);
        expect(sizeMatches(file, 99)).toBe(false);
    });

    test('skips the check when the API reported no size', () => {
        // Refusing a download because GitHub omitted a field would be worse than accepting one
        // this cannot confirm.
        expect(sizeMatches(file, 0)).toBe(true);
        expect(sizeMatches(file, -1)).toBe(true);
    });

    test('is false for a file that is not there', () => {
        expect(sizeMatches(join(scratch, 'absent.bin'), 10)).toBe(false);
    });
});

describe('resolveRedirect', () => {
    test('resolves a relative Location against the request URL', () => {
        expect(resolveRedirect('https://api.github.com/repos/a/b', '/elsewhere'))
            .toBe('https://api.github.com/elsewhere');
    });

    test('keeps an absolute Location', () => {
        expect(resolveRedirect('https://api.github.com/x', 'https://objects.githubusercontent.com/y'))
            .toBe('https://objects.githubusercontent.com/y');
    });

    test('returns an unparseable Location untouched, for validateRequestUrl to refuse', () => {
        expect(resolveRedirect('::not a url::', 'also not a url')).toBe('also not a url');
    });
});

describe('downloadJar', () => {
    const release = {
        tag: 'v2.1.0',
        jarName: 'jpipe-cli-2.1.0.jar',
        jarUrl: 'https://objects.githubusercontent.com/jpipe-cli-2.1.0.jar',
        jarSize: 12,
        prerelease: false
    } as never;

    test('reuses a jar that is already present at the expected size, without touching the network', async () => {
        const root = join(scratch, 'reuse');
        mkdirSync(join(root, 'v2.1.0'), { recursive: true });
        const jar = join(root, 'v2.1.0', 'jpipe-cli-2.1.0.jar');
        writeFileSync(jar, 'x'.repeat(12));

        const log = recordingLog();
        // The URL is unreachable by construction; resolving proves no request was made.
        await expect(downloadJar(release, root, log)).resolves.toBe(jar);
        expect(log.lines.some(l => l.includes('Reusing'))).toBe(true);
    });

    test('does not reuse a jar of the wrong size', async () => {
        const root = join(scratch, 'wrong-size');
        mkdirSync(join(root, 'v2.1.0'), { recursive: true });
        writeFileSync(join(root, 'v2.1.0', 'jpipe-cli-2.1.0.jar'), 'x'.repeat(11));

        // Falls through to a download, which fails on the unroutable host rather than silently
        // accepting the truncated file already on disk.
        await expect(downloadJar(release, root, recordingLog())).rejects.toThrow();
    });

    test('refuses a jar URL pointing at an untrusted host', async () => {
        const evil = { ...(release as object), jarUrl: 'https://evil.example.com/x.jar' } as never;
        const root = join(scratch, 'evil');
        await expect(downloadJar(evil, root, recordingLog()))
            .rejects.toThrow('Refusing to contact untrusted host');
        // Nothing is left behind on a refused download.
        expect(existsSync(join(root, 'v2.1.0', 'jpipe-cli-2.1.0.jar'))).toBe(false);
    });
});

/**
 * The response handling, exercised through an injected transport.
 *
 * Not reachable any other way: `validateRequestUrl` refuses anything but a github.com host, so a
 * local test server could not be contacted even if one were started. Making the transport a
 * parameter is what makes redirects, rate limits and malformed bodies testable at all.
 */
describe('httpsGetJson response handling', () => {
    /** A transport that answers with a canned response, recording the URLs it was asked for. */
    function fakeTransport(
        answers: Array<{ status: number; headers?: Record<string, string>; body?: string }>
    ): { transport: Transport; urls: string[] } {
        const urls: string[] = [];
        const transport: Transport = (url, onResponse) => {
            urls.push(url);
            const answer = answers.shift() ?? { status: 500 };
            const res = Readable.from([Buffer.from(answer.body ?? '')]) as unknown as IncomingMessage;
            (res as { statusCode?: number }).statusCode = answer.status;
            (res as { headers: Record<string, string> }).headers = answer.headers ?? {};
            // Deliver on a later tick, as a socket would.
            setImmediate(() => onResponse(res));
        };
        return { transport, urls };
    }

    test('parses a 200 body', async () => {
        const { transport } = fakeTransport([{ status: 200, body: '[{"tag_name":"v2.0.0"}]' }]);
        await expect(httpsGetJson('https://api.github.com/x', 0, transport))
            .resolves.toEqual([{ tag_name: 'v2.0.0' }]);
    });

    test('follows a redirect, and resolves a relative Location', async () => {
        const { transport, urls } = fakeTransport([
            { status: 302, headers: { location: '/moved' } },
            { status: 200, body: '{"ok":true}' }
        ]);
        await expect(httpsGetJson('https://api.github.com/x', 0, transport)).resolves.toEqual({ ok: true });
        expect(urls).toEqual(['https://api.github.com/x', 'https://api.github.com/moved']);
    });

    test('gives the rate limit its own message, since 403 here is not a permissions problem', async () => {
        const { transport } = fakeTransport([{ status: 403 }]);
        await expect(httpsGetJson('https://api.github.com/x', 0, transport))
            .rejects.toThrow('rate limit');
    });

    test('reports the status for any other failure', async () => {
        const { transport } = fakeTransport([{ status: 503 }]);
        await expect(httpsGetJson('https://api.github.com/x', 0, transport))
            .rejects.toThrow('HTTP 503');
    });

    test('reports a malformed body rather than throwing a raw SyntaxError', async () => {
        const { transport } = fakeTransport([{ status: 200, body: 'not json' }]);
        await expect(httpsGetJson('https://api.github.com/x', 0, transport))
            .rejects.toThrow('Could not parse the GitHub API response');
    });

    test('stops following redirects at the ceiling', async () => {
        const answers = Array.from({ length: 8 }, () => ({ status: 302, headers: { location: '/again' } }));
        await expect(httpsGetJson('https://api.github.com/x', 0, fakeTransport(answers).transport))
            .rejects.toThrow('Too many redirects');
    });

    test('refuses a redirect that leaves the allowlist', async () => {
        // The check runs on every hop, not just the first: a 302 to an attacker-controlled host
        // is the obvious way round a validated initial URL.
        const { transport } = fakeTransport([{ status: 302, headers: { location: 'https://evil.example.com/x' } }]);
        await expect(httpsGetJson('https://api.github.com/x', 0, transport))
            .rejects.toThrow('Refusing to contact untrusted host');
    });
});
