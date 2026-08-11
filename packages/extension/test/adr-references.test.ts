import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * Every `docs/adr/…` path written anywhere in the repository points at a file that exists.
 *
 * ADR filenames carry their title (`vsc-0013-dependency-freshness-policy.md`), which makes them
 * long enough that writing `docs/adr/vsc-0013` and moving on is the natural mistake. It has been
 * made three times, in three different files, and caught by a reviewer each time — a pointer
 * that does not resolve is exactly the kind of documentation defect that sends the next reader
 * (or the next agent) looking for something that is not there.
 *
 * This lives in the extension's suite for want of a better home: the concern is repository-wide,
 * but this is the package whose tests already read files from disk, and it needs to run on every
 * pull request rather than at release time.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');

/** Text files git is tracking — so generated output and node_modules are excluded for free. */
function trackedTextFiles(): string[] {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' });
    return out
        .split('\0')
        .filter(p => /\.(ts|tsx|js|mjs|cjs|md|ya?ml|json|sh)$/.test(p))
        .filter(p => existsSync(join(repo, p)) && statSync(join(repo, p)).isFile());
}

/**
 * `docs/adr/` references in a file, with trailing sentence punctuation trimmed.
 *
 * `vsc-NNNN-` is the placeholder the process record uses when describing the naming scheme
 * rather than citing a decision, so it is not a reference and is skipped.
 */
function adrReferences(source: string): string[] {
    return [...source.matchAll(/docs\/adr\/[A-Za-z0-9._-]+/g)]
        .map(m => m[0].replace(/[.,;:)\]]+$/, ''))
        .filter(ref => ref !== 'docs/adr' && !ref.includes('NNNN'));
}

describe('ADR references resolve', () => {

    const files = trackedTextFiles();

    test('the repository is being scanned at all', () => {
        // Guards the guard: a wrong `repo` path or a stricter extension filter would silently
        // turn every assertion below into a pass over an empty list.
        expect(files.length).toBeGreaterThan(30);
        expect(files).toContain('docs/adr/README.md');
    });

    test('every docs/adr/… path names a file that exists', () => {
        const broken: string[] = [];

        for (const file of files) {
            for (const ref of adrReferences(readFileSync(join(repo, file), 'utf8'))) {
                if (!existsSync(join(repo, ref))) broken.push(`${file} -> ${ref}`);
            }
        }

        expect(broken).toEqual([]);
    });
});
