#!/usr/bin/env node
/**
 * Compares the vendored compiler vocabulary against a jpipe-compiler checkout.
 *
 * `COMPILER_CODES` in `packages/language/src/jpipe-compiler-codes.ts` is a copy, and the test
 * suite can only check that our own codes are placed in one family or the other — it cannot know
 * that the compiler has since added a rule. This script closes that gap when, and only when, a
 * sibling checkout is on disk.
 *
 * Deliberately NOT a CI gate (jpipe-vscode ADR-VSC-0022): CI builds this repository alone, so a
 * gate here could never run, and a gate that never runs is a gate that gets deleted. Exit code 1
 * means the two lists disagree; exit 0 with a note means there was nothing to compare against.
 *
 *   npm run check:codes                 # looks for ../jpipe-compiler
 *   npm run check:codes -- /path/to/it  # or say where it is
 */
import { globSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compilerRoot = resolve(process.argv[2] ?? join(REPO, '..', 'jpipe-compiler'));

/** Where the compiler keeps each family, and how each family spells a code. */
const SOURCES = [
    { glob: 'jpipe-compiler/src/main/java/**/compiler/model/DiagnosticCodes.java',
      pattern: /=\s*"([a-z0-9-]+)"\s*;/g },
    { glob: 'jpipe-model/src/main/java/**/model/validation/*Validator.java',
      pattern: /new\s+Violation\(\s*"([a-z0-9-]+)"/g }
];

function read(path) {
    return readFileSync(path, 'utf8');
}

/** Every code the compiler checkout actually declares. */
function codesFromCompiler() {
    const found = new Set();
    for (const { glob, pattern } of SOURCES) {
        const files = globSync(glob, { cwd: compilerRoot });
        if (files.length === 0) {
            throw new Error(`no file matched ${glob} under ${compilerRoot}`);
        }
        for (const file of files) {
            const text = read(join(compilerRoot, file));
            for (const [, code] of text.matchAll(pattern)) found.add(code);
        }
    }
    return found;
}

/** The list we vendored, read out of the TypeScript rather than imported (no build required). */
function codesFromVendoredList() {
    const text = read(join(REPO, 'packages/language/src/jpipe-compiler-codes.ts'));
    const block = /export const COMPILER_CODES = \[([\s\S]*?)\] as const;/.exec(text);
    if (!block) throw new Error('could not find COMPILER_CODES in jpipe-compiler-codes.ts');
    return new Set([...block[1].matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1]));
}

let theirs;
try {
    theirs = codesFromCompiler();
} catch (error) {
    // Not an error: the sibling checkout is optional, and its absence is the normal case in CI.
    console.log(`skipped — ${error.message}`);
    process.exit(0);
}

const ours = codesFromVendoredList();
const missing = [...theirs].filter(code => !ours.has(code)).sort();
const stale = [...ours].filter(code => !theirs.has(code)).sort();

if (missing.length === 0 && stale.length === 0) {
    console.log(`ok — ${ours.size} codes, matching ${compilerRoot}`);
    process.exit(0);
}

console.error(`COMPILER_CODES disagrees with ${compilerRoot}:`);
for (const code of missing) console.error(`  + ${code}  (the compiler has it; we do not)`);
for (const code of stale) console.error(`  - ${code}  (we have it; the compiler does not)`);
console.error('\nUpdate packages/language/src/jpipe-compiler-codes.ts, including its SOURCE line.');
console.error('A code that is new upstream may be one we already coined a different name for —');
console.error('jpipe-vscode ADR-VSC-0022 says the compiler\'s name wins.');
process.exit(1);
