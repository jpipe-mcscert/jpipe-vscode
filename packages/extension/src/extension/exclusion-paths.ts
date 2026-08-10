/**
 * The stored form of an exclusion entry, and path containment.
 *
 * Split out of `exclusions.ts` so it can be tested without a VS Code host. Resolving an entry to
 * a real URI stays there — that needs the workspace folders and `Uri.joinPath`. What lives here
 * is the part with the edge cases: how an entry is spelled, and what counts as "inside".
 */

/** An entry decomposed into the workspace root it names (if any) and the path within it. */
export interface ParsedEntry {
    /** Workspace folder name, present only in the multi-root spelling. */
    readonly rootName: string | undefined;
    readonly relativePath: string;
}

/**
 * Splits `rootName:relative/path` (multi-root) or `relative/path` (single root).
 *
 * Undefined for a blank entry, and for `name:` with nothing after the colon — neither can name a
 * directory, and a blank one previously resolved to the filesystem root.
 *
 * A leading colon is *not* treated as a separator (`indexOf` must be > 0), so an entry may not
 * start with one. Note the split is on the first colon, so a workspace folder whose own name
 * contains a colon cannot be addressed; that is the format's limitation, recorded here rather
 * than discovered later.
 */
export function parseEntry(entry: string): ParsedEntry | undefined {
    if (!entry || entry.trim().length === 0) return undefined;
    const colon = entry.indexOf(':');
    if (colon > 0) {
        const relativePath = entry.slice(colon + 1);
        if (!relativePath) return undefined;
        return { rootName: entry.slice(0, colon), relativePath };
    }
    return { rootName: undefined, relativePath: entry };
}

/** The inverse of {@link parseEntry}: how an entry is written into settings. */
export function formatEntry(rootName: string | undefined, relativePath: string): string {
    return rootName ? `${rootName}:${relativePath}` : relativePath;
}

/** Drops one trailing `/`, so a directory URI compares equal however it was spelled. */
export function stripTrailingSlash(uri: string): string {
    return uri.endsWith('/') ? uri.slice(0, -1) : uri;
}

/**
 * Path containment on URI segment boundaries.
 *
 * The boundary check is the point: a plain `startsWith` would make `counter-examples` swallow
 * `counter-examples-old`, silently un-validating a directory the user never excluded.
 */
export function isSameOrInside(parent: string, child: string): boolean {
    const parentPath = stripTrailingSlash(parent);
    const childPath = stripTrailingSlash(child);
    return childPath === parentPath || childPath.startsWith(`${parentPath}/`);
}

/** The jPipe language id, as contributed in `package.json`. */
const JPIPE_LANGUAGE_ID = 'jpipe';

/**
 * Whether an open document should carry the "not being validated" banner.
 *
 * Deliberately narrower than the Explorer badge, which also marks excluded *directories*. A
 * banner answers "why is this file not reporting problems?", so it belongs only on a file that
 * would otherwise be validated — a `README.md` sitting beside the counter-examples never was.
 *
 * Untitled and other non-file documents are excluded by the containment check itself: their URIs
 * are not under any workspace path.
 */
export function shouldShowExclusionBanner(
    languageId: string,
    documentUri: string,
    excludedUris: readonly string[]
): boolean {
    if (languageId !== JPIPE_LANGUAGE_ID) return false;
    return excludedUris.some(excluded => isSameOrInside(excluded, documentUri));
}
