import { URI, UriUtils } from 'langium';
import type { JpipeServerLogger } from './jpipe-logger.js';

/**
 * Holds the paths excluded from validation. An entry is either a directory — excluding every
 * document beneath it — or a single `.jd` file.
 *
 * The list is mutable so the client can update it over LSP without restarting the server
 * (see `jpipe/setExcludedPaths`). It is seeded from the `JPIPE_EXCLUDED_PATHS` environment
 * variable, which keeps headless/test usage working without an LSP connection.
 */
export class JpipeExclusionService {
    private excludedUris: URI[] = [];
    private readonly logger: JpipeServerLogger;

    constructor(logger: JpipeServerLogger) {
        this.logger = logger;
        this.setExcludedPaths(this.readFromEnvironment());
    }

    /** Replace the excluded paths with `paths` (URI strings). Invalid entries are skipped. */
    setExcludedPaths(paths: string[]): void {
        this.excludedUris = paths.flatMap(p => {
            if (typeof p !== 'string' || p.trim().length === 0) {
                this.logger.warn('Ignoring blank excluded-path entry.');
                return [];
            }
            let uri: URI;
            try {
                uri = URI.parse(p);
            } catch {
                this.logger.warn(`Ignoring invalid excluded-path URI: ${p}`);
                return [];
            }
            // `URI.parse` is lenient: a blank or root-ish entry yields path '/', which would
            // match every document and silently disable validation workspace-wide.
            // Scanned from the end rather than `replace(/\/+$/, '')`: that pattern has to retry
            // from every position inside a run of slashes (S8786), where this is linear.
            let end = uri.path.length;
            while (end > 0 && uri.path[end - 1] === '/') end--;
            const path = uri.path.slice(0, end);
            if (path.length === 0) {
                this.logger.warn(`Ignoring excluded-path entry that resolves to the filesystem root: ${p}`);
                return [];
            }
            return [uri];
        });
        this.logger.debug(`Excluded paths: ${this.excludedUris.length === 0 ? '(none)' : this.excludedUris.map(u => u.toString()).join(', ')}`);
    }

    /**
     * True when `uri` is an excluded path itself, or lives beneath one.
     *
     * `UriUtils.contains` returns true for equal paths and otherwise requires a `/` at the
     * segment boundary, so a file entry matches exactly that document and a directory entry
     * matches everything under it — no separate handling needed for the two kinds of entry.
     */
    isExcluded(uri: URI): boolean {
        return this.excludedUris.some(excluded => UriUtils.contains(excluded, uri));
    }

    private readFromEnvironment(): string[] {
        try {
            const raw = process.env.JPIPE_EXCLUDED_PATHS;
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.every((v: unknown) => typeof v === 'string')) {
                return parsed;
            }
            this.logger.warn('JPIPE_EXCLUDED_PATHS must be a JSON array of strings; nothing will be excluded.');
        } catch {
            this.logger.warn('Failed to parse JPIPE_EXCLUDED_PATHS; nothing will be excluded from validation.');
        }
        return [];
    }
}
