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

/**
 * A reason a pattern cannot be expanded.
 *
 * Each subclass knows how to word itself exactly as `LoadResolver.expandGlob` words the
 * corresponding FATAL, so the diagnostic, the hover and a compiler run all say the same thing.
 */
export abstract class GlobExpansionError extends Error {
    /** The message to show for `pattern`, in the compiler's wording. */
    abstract describe(pattern: string): string;
}

/** Thrown for a malformed pattern. Mirrors Java's `PatternSyntaxException`. */
export class GlobSyntaxError extends GlobExpansionError {
    /** Short reason, matching the JDK's wording so our diagnostic reads like the compiler's. */
    readonly description: string;

    constructor(description: string, pattern: string) {
        super(`${description} in glob pattern '${pattern}'`);
        this.name = 'GlobSyntaxError';
        this.description = description;
    }

    override describe(pattern: string): string {
        return `Invalid glob in load pattern '${pattern}': ${this.description}`;
    }
}

/** Thrown when a `..` segment survives anchoring, i.e. follows a wildcard. */
export class GlobUpwardSegmentError extends GlobExpansionError {
    constructor() {
        super('Upward segment after a wildcard');
        this.name = 'GlobUpwardSegmentError';
    }

    override describe(pattern: string): string {
        return `'..' may only appear before the first wildcard in load pattern '${pattern}'`;
    }
}

/** Thrown when a pattern's literal prefix does not name an existing directory. */
export class GlobAnchorError extends GlobExpansionError {
    /** The resolved directory that is missing — usually where the typo is. */
    readonly root: string;

    constructor(root: string) {
        super(`Not a directory: ${root}`);
        this.name = 'GlobAnchorError';
        this.root = root;
    }

    override describe(pattern: string): string {
        return `Cannot expand load pattern '${pattern}': '${this.root}' is not a directory`;
    }
}

/** Characters that make a `load` path a pattern rather than a literal path. */
const GLOB_META = '*?[{';

/** Regex metacharacters, per the JDK's `regexMetaChars`. */
const REGEX_META = '.^$+{[]|()';

/**
 * Index of the first glob metacharacter in `path`, or -1 if it holds none.
 *
 * Single source of truth for what counts as a wildcard, shared by `isGlobPattern` and
 * `anchorGlob` — as `LoadResolver.firstMetaChar` is on the compiler side.
 */
function firstMetaChar(path: string): number {
    for (let i = 0; i < path.length; i++) {
        if (GLOB_META.includes(path[i])) return i;
    }
    return -1;
}

/**
 * Whether `path` is a glob pattern rather than a literal path.
 *
 * Mirrors `LoadResolver.isGlob` exactly; the two must agree, otherwise a path one side treats as
 * literal the other treats as a pattern.
 */
export function isGlobPattern(path: string): boolean {
    return firstMetaChar(path) >= 0;
}

/** A pattern split into the directory a search starts from and the glob matched relative to it. */
export interface GlobAnchor {
    /** Literal path prefix, resolved against the declaring file's directory. May be `''`. */
    readonly prefix: string;
    /** The glob to match against paths relative to the resolved prefix. */
    readonly pattern: string;
}

/**
 * Splits a pattern at the last `/` preceding its first wildcard *character*.
 *
 * Everything before the cut is a literal path resolved exactly like a literal `load` — which is
 * what lets a pattern climb out of the declaring file's directory (`../library/*.jd`) or name an
 * absolute location. The remainder is matched relative to that directory, which is also the only
 * subtree walked.
 *
 * Anchoring is meaning-preserving for patterns that only descend: matching `dir/X` against
 * `dir/<glob>` relative to `<base>` is the same as matching `X` against `<glob>` relative to
 * `<base>/dir`. Cutting before the first wildcard *character* rather than at a segment boundary
 * is what keeps a construct spanning a separator, such as `{foo/bar,baz}/*.jd`, intact.
 *
 * Mirrors `LoadResolver.anchor`.
 */
export function anchorGlob(pattern: string): GlobAnchor {
    const cut = pattern.lastIndexOf('/', firstMetaChar(pattern));
    if (cut < 0) {
        return { prefix: '', pattern };
    }
    // cut === 0 means an absolute pattern such as "/opt/*.jd": the literal prefix is the root
    // itself, which slice(0, 0) would lose.
    const prefix = cut === 0 ? '/' : pattern.slice(0, cut);
    return { prefix, pattern: pattern.slice(cut + 1) };
}

/**
 * Whether a pattern contains a `..` segment.
 *
 * Checked *after* anchoring: a directory walk only descends, so a `..` that survives (one
 * following a wildcard, as in `*​/../foo.jd`) can never match. The caller reports that rather
 * than letting it surface as a puzzling no-match. Mirrors `LoadResolver.hasUpwardSegment`.
 */
export function hasUpwardSegment(pattern: string): boolean {
    return pattern.split('/').includes('..');
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
