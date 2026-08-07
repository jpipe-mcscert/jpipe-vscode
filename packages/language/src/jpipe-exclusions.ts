import { URI, UriUtils } from 'langium';
import type { JpipeServerLogger } from './jpipe-logger.js';

/**
 * Holds the set of directories whose `.jd` files are excluded from validation.
 *
 * The list is mutable so the client can update it over LSP without restarting the server
 * (see `jpipe/setExcludedDirectories`). It is seeded from the `JPIPE_EXCLUDED_DIRS`
 * environment variable, which keeps headless/test usage working without an LSP connection.
 */
export class JpipeExclusionService {
    private excludedUris: URI[] = [];
    private readonly logger: JpipeServerLogger;

    constructor(logger: JpipeServerLogger) {
        this.logger = logger;
        this.setExcludedDirectories(this.readFromEnvironment());
    }

    /** Replace the excluded directories with `paths` (URI strings). Invalid entries are skipped. */
    setExcludedDirectories(paths: string[]): void {
        this.excludedUris = paths.flatMap(p => {
            if (typeof p !== 'string' || p.trim().length === 0) {
                this.logger.warn('Ignoring blank excluded-directory entry.');
                return [];
            }
            let uri: URI;
            try {
                uri = URI.parse(p);
            } catch {
                this.logger.warn(`Ignoring invalid excluded-directory URI: ${p}`);
                return [];
            }
            // `URI.parse` is lenient: a blank or root-ish entry yields path '/', which would
            // match every document and silently disable validation workspace-wide.
            const path = uri.path.replace(/\/+$/, '');
            if (path.length === 0) {
                this.logger.warn(`Ignoring excluded-directory entry that resolves to the filesystem root: ${p}`);
                return [];
            }
            return [uri];
        });
        this.logger.debug(`Excluded directories: ${this.excludedUris.length === 0 ? '(none)' : this.excludedUris.map(u => u.toString()).join(', ')}`);
    }

    /** True when `uri` is inside (at any depth) one of the excluded directories. */
    isExcluded(uri: URI): boolean {
        return this.excludedUris.some(dir => UriUtils.contains(dir, uri));
    }

    private readFromEnvironment(): string[] {
        try {
            const raw = process.env.JPIPE_EXCLUDED_DIRS;
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.every((v: unknown) => typeof v === 'string')) {
                return parsed;
            }
            this.logger.warn('JPIPE_EXCLUDED_DIRS must be a JSON array of strings; no directories will be excluded.');
        } catch {
            this.logger.warn('Failed to parse JPIPE_EXCLUDED_DIRS; no directories will be excluded from validation.');
        }
        return [];
    }
}
