/**
 * Glob matching for `load` paths, compatible with the jPipe compiler.
 *
 * The compiler expands a globbed `load` with Java NIO:
 *
 * ```java
 * FileSystems.getDefault().getPathMatcher("glob:" + pattern)
 * ```
 *
 * so this module is a port of OpenJDK's `sun.nio.fs.Globs.toUnixRegexPattern`. It is deliberately
 * *not* implemented with `minimatch`/`picomatch`: those treat `**` as special only when it forms a
 * whole path segment, so `models/**.jd` would quietly degrade to `models/*.jd` and miss nested
 * files, whereas Java matches every depth. Getting that wrong would make the IDE disagree with the
 * compiler about which files a model loads.
 *
 * Patterns and candidate paths are always compared in POSIX form (`/` separators). Java on Windows
 * reaches the same result by a different route — there the pattern's `/` is compiled to match `\`
 * and the relative path uses `\` — so normalising both sides to `/` is equivalent on every platform.
 */

/** Thrown for a malformed pattern. Mirrors Java's `PatternSyntaxException`. */
export class GlobSyntaxError extends Error {
    /** Short reason, matching the JDK's wording so our diagnostic reads like the compiler's. */
    readonly description: string;

    constructor(description: string, pattern: string) {
        super(`${description} in glob pattern '${pattern}'`);
        this.name = 'GlobSyntaxError';
        this.description = description;
    }
}

/** Characters that make a `load` path a pattern rather than a literal path. */
const GLOB_META = '*?[{';

/** Regex metacharacters, per the JDK's `regexMetaChars`. */
const REGEX_META = '.^$+{[]|()';

/**
 * Whether `path` is a glob pattern rather than a literal path.
 *
 * Mirrors `LoadResolver.isGlob` exactly; the two must agree, otherwise a path one side treats as
 * literal the other treats as a pattern.
 */
export function isGlobPattern(path: string): boolean {
    return [...path].some(c => GLOB_META.includes(c));
}

/** Compiles a Java NIO glob into an anchored `RegExp` over POSIX paths. */
export function globToRegExp(pattern: string): RegExp {
    let regex = '^';
    let inGroup = false;
    let i = 0;

    const next = (): string => (i < pattern.length ? pattern[i] : '');

    while (i < pattern.length) {
        const c = pattern[i++];
        switch (c) {
            case '\\': {
                if (i === pattern.length) {
                    throw new GlobSyntaxError('No character to escape', pattern);
                }
                const escaped = pattern[i++];
                if (GLOB_META.includes(escaped) || REGEX_META.includes(escaped) || escaped === '\\') {
                    regex += '\\';
                }
                regex += escaped;
                break;
            }
            case '/':
                regex += '/';
                break;
            case '[':
                regex += parseCharacterClass();
                break;
            case '{':
                if (inGroup) {
                    throw new GlobSyntaxError('Cannot nest groups', pattern);
                }
                regex += '(?:(?:';
                inGroup = true;
                break;
            case '}':
                if (inGroup) {
                    regex += '))';
                    inGroup = false;
                } else {
                    regex += '\\}';
                }
                break;
            case ',':
                regex += inGroup ? ')|(?:' : ',';
                break;
            case '*':
                if (next() === '*') {
                    // `**` crosses directory boundaries; `*` does not. This single line is the
                    // difference between `models/**.jd` finding nested files and missing them.
                    regex += '.*';
                    i++;
                } else {
                    regex += '[^/]*';
                }
                break;
            case '?':
                regex += '[^/]';
                break;
            default:
                if (REGEX_META.includes(c)) {
                    regex += '\\';
                }
                regex += c;
        }
    }

    if (inGroup) {
        throw new GlobSyntaxError("Missing '}", pattern);
    }
    return new RegExp(`${regex}$`);

    /**
     * Consumes a `[...]` class starting after the `[`.
     *
     * The JDK emits `[[^/]&&[...]]` — a character-class *intersection*, which plain JavaScript
     * regexes cannot express (only ES2024's `v` flag can, and the language server runs on VS
     * Code's bundled Node, which may predate it). The intersection is reproduced exactly without
     * it: a literal `/` inside a class is rejected here just as Java rejects it, so for a positive
     * class the intersection is a no-op, and for a negated class it is equivalent to adding `/` to
     * the excluded set.
     */
    function parseCharacterClass(): string {
        let body = '';
        let negated = false;

        if (next() === '^') {
            // A literal '^' as the first class character; escape it so it is not read as negation.
            body += '\\^';
            i++;
        } else {
            if (next() === '!') {
                negated = true;
                i++;
            }
            if (next() === '-') {
                // A hyphen is allowed as the first character, where it means itself.
                body += '-';
                i++;
            }
        }

        let closed = false;
        let hasRangeStart = false;
        let last = '';
        while (i < pattern.length) {
            const c = pattern[i++];
            if (c === ']') {
                closed = true;
                break;
            }
            if (c === '/') {
                throw new GlobSyntaxError("Explicit 'name separator' in class", pattern);
            }
            if (c === '\\' || c === '[' || c === '^') {
                body += '\\';
            }
            body += c;

            if (c === '-') {
                if (!hasRangeStart) {
                    throw new GlobSyntaxError('Invalid range', pattern);
                }
                const rangeEnd = i < pattern.length ? pattern[i++] : '';
                if (rangeEnd === '' || rangeEnd === ']') {
                    closed = rangeEnd === ']';
                    break;
                }
                if (rangeEnd < last) {
                    throw new GlobSyntaxError('Invalid range', pattern);
                }
                body += rangeEnd;
                hasRangeStart = false;
            } else {
                hasRangeStart = true;
                last = c;
            }
        }
        if (!closed) {
            throw new GlobSyntaxError("Missing ']", pattern);
        }
        // Negated: exclude the separator too, which is what `[^/]&&[^…]` amounts to.
        return negated ? `[^${body}/]` : `[${body}]`;
    }
}

/** Whether a `/`-separated path (relative to the pattern's base directory) matches `pattern`. */
export function matchesGlob(pattern: string, relativePosixPath: string): boolean {
    return globToRegExp(pattern).test(relativePosixPath);
}

/**
 * Whether a pattern points outside the directory it is resolved against, which means it can never
 * match anything.
 *
 * The compiler expands a pattern with `Files.walk(base)` and matches `base.relativize(p)`, and
 * both of those only ever go *downwards* — so `../sibling/*.jd` and absolute patterns match
 * nothing, even though the equivalent literal paths resolve perfectly well. That asymmetry is
 * surprising enough to be worth calling out in the diagnostic rather than leaving the user
 * staring at "no file matches" for a directory they can see.
 */
export function escapesBaseDirectory(pattern: string): boolean {
    const normalized = pattern.replaceAll('\\', '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return true;
    return normalized === '..' || normalized.startsWith('../');
}
