import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { SET_EXCLUDED_PATHS, SET_UNIFICATION_METHODS } from '../src/shared/lsp-protocol.js';

/**
 * That the two sides of the LSP boundary still take their notification names from one place.
 *
 * These names were declared twice, once in each `main.ts`, until `src/shared/lsp-protocol.ts`
 * was introduced. The failure that made that worth fixing cannot be caught by a normal test:
 * renaming one side type-checks, builds, packages and ships, and the symptom is a notification
 * the server never receives — no error, no log, the setting simply stops working.
 *
 * Neither `main.ts` can be imported here (one pulls in `vscode`, the other is a server entry
 * point with top-level side effects), so this reads them as text — the same approach, and for
 * the same reason, as `preview-shell.test.ts`. It cannot prove the notification arrives. It can
 * prove nobody has quietly re-introduced a second copy of the name, which is the regression that
 * would otherwise go unnoticed until a user reported that exclusions had stopped applying.
 */

/** No `__dirname` in an ESM package; see the note in `diagnostic-fixtures.test.ts`. */
const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(join(here, '..', ...parts), 'utf8');

const hosts: ReadonlyArray<readonly [string, string]> = [
    ['extension/main.ts', read('src', 'extension', 'main.ts')],
    ['language/main.ts', read('src', 'language', 'main.ts')]
];

describe('the LSP notification names are single-sourced', () => {

    test.each(hosts)('%s imports them from shared/lsp-protocol', (_name, source) => {
        expect(source).toContain('shared/lsp-protocol.js');
    });

    test.each(hosts)('%s does not declare its own copy', (_name, source) => {
        expect(source).not.toMatch(/\b(const|let|var)\s+SET_EXCLUDED_PATHS\b/);
        expect(source).not.toMatch(/\b(const|let|var)\s+SET_UNIFICATION_METHODS\b/);
    });

    test.each(hosts)('%s does not inline the wire strings', (_name, source) => {
        // The names may appear via the imported constants, never as literals: a literal here is
        // a second declaration wearing a different hat.
        expect(source).not.toContain(`'${SET_EXCLUDED_PATHS}'`);
        expect(source).not.toContain(`'${SET_UNIFICATION_METHODS}'`);
    });

    test('the wire strings are namespaced under jpipe/', () => {
        // Pinned because they are a protocol, not an implementation detail: renaming one is a
        // breaking change to a contract, and should have to be done deliberately here.
        expect(SET_EXCLUDED_PATHS).toBe('jpipe/setExcludedPaths');
        expect(SET_UNIFICATION_METHODS).toBe('jpipe/setUnificationMethods');
    });
});
