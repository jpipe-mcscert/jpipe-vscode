import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import manifest from '../package.json' with { type: 'json' };

/**
 * Every command the manifest advertises has a handler, and every handler has a manifest entry.
 *
 * This is the one thing about the command surface that can be checked without a VS Code host,
 * and it is worth checking: a command declared in `package.json` with nothing registered for it
 * appears in the palette and the menus, and does nothing at all when invoked. Neither the
 * compiler nor the rest of the suite can see that, because the two halves are a JSON string and
 * a TypeScript string that never meet.
 *
 * It is not hypothetical. Registering the export commands as `jpipe.download${format}` looks
 * obviously right and is wrong: `ImageFormat.PYTHON` is `'PYTHON'`, while the contributed
 * command is `jpipe.downloadPython`. That would have left "Download as Python" in the menu with
 * no handler behind it.
 *
 * The registrations are read as text, since `commands.ts` imports `vscode` and cannot be loaded
 * here — the same approach as `preview-shell.test.ts`, for the same reason.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(join(here, '..', ...parts), 'utf8');

/** Command ids the manifest contributes. */
const declared: string[] = manifest.contributes.commands.map(c => c.command);

/** Command ids passed to `registerCommand`, across every source file that calls it. */
function registeredIn(...sources: string[]): string[] {
    const ids = new Set<string>();
    for (const source of sources) {
        for (const m of source.matchAll(/registerCommand\(\s*'([^']+)'/g)) ids.add(m[1]);
        // The export commands come from a table of tuples rather than a literal argument.
        for (const m of source.matchAll(/\[\s*'(jpipe\.[A-Za-z.]+)'\s*,/g)) ids.add(m[1]);
    }
    return [...ids];
}

const registered = registeredIn(read('src', 'extension', 'commands.ts'));

describe('contributed commands', () => {

    test('the manifest and the source were both actually read', () => {
        // Guards the guard: a moved file or a changed regex would otherwise make every
        // assertion below a comparison of two empty lists.
        expect(declared.length).toBeGreaterThan(15);
        expect(registered.length).toBeGreaterThan(15);
    });

    test('every declared command has a handler', () => {
        const missing = declared.filter(id => !registered.includes(id));
        expect(missing).toEqual([]);
    });

    test('every registered handler has a manifest entry', () => {
        // The other direction matters too: a handler with no contribution is unreachable from
        // the palette, so the feature exists and nobody can find it.
        const undeclared = registered.filter(id => !declared.includes(id));
        expect(undeclared).toEqual([]);
    });

    test('the export commands spell Python the way the manifest does', () => {
        // Pinned specifically because this is the one id where the enum value and the command
        // disagree in case, and the mismatch is silent.
        expect(declared).toContain('jpipe.downloadPython');
        expect(declared).not.toContain('jpipe.downloadPYTHON');
        expect(registered).toContain('jpipe.downloadPython');
    });
});
