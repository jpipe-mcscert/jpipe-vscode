import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import config from '../vitest.config.js';

/**
 * The modules left out of coverage are listed twice, once for Vitest and once for SonarQube, and
 * nothing else compares the two (#75). Each list is in its own format, a TypeScript array and a
 * backslash-continued properties value, and the gate only notices a gap after review: PR #72
 * failed it at 20% coverage on new code because `jar-selection.ts`, which imports `vscode`, was
 * in neither, although its own comment said it was excluded.
 *
 * The rule for both lists is *uncoverable by construction, never merely untested* (jpipe-vscode
 * ADR-VSC-0004, ADR-VSC-0010). The one cause of that this can see from the source is a module
 * that reaches `vscode` at run time, directly or through a module it imports, since no test here
 * can load it. The other entries, entry points with side effects and files of types only, are
 * judged by a reviewer, as the comments beside them say.
 */

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, '..');
const repositoryRoot = resolve(extensionRoot, '..', '..');

/** `coverage.exclude` in `vitest.config.ts`, relative to this package. */
const vitestList: string[] = (config.test?.coverage as { exclude?: string[] } | undefined)?.exclude ?? [];

/** `sonar.coverage.exclusions`, relative to the repository. */
function sonarList(): string[] {
    const properties = readFileSync(join(repositoryRoot, 'sonar-project.properties'), 'utf8');
    const start = properties.search(/^sonar\.coverage\.exclusions=/m);
    expect(start, 'sonar.coverage.exclusions is missing').toBeGreaterThanOrEqual(0);
    const value: string[] = [];
    for (const line of properties.slice(start).split('\n')) {
        const continued = line.trimEnd().endsWith('\\');
        value.push(line.replace(/^sonar\.coverage\.exclusions=/, '').replace(/\\\s*$/, ''));
        if (!continued) break;
    }
    return value.join('').split(',').map(entry => entry.trim()).filter(entry => entry !== '');
}

/** Every `.ts` file under `src/`, relative to this package. */
function sources(dir = join(extensionRoot, 'src')): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return sources(full);
        return entry.name.endsWith('.ts') ? [relative(extensionRoot, full).split('\\').join('/')] : [];
    });
}

/**
 * What `file` imports at run time: `vscode`, or a file of this package. An `import type` is
 * erased by TypeScript and loads nothing, so it does not count; neither do node built-ins and
 * other packages.
 */
function runtimeImports(file: string): string[] {
    const text = readFileSync(join(extensionRoot, file), 'utf8');
    const specifiers = [
        ...text.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+(['"])([^'"]+)\1/gm),
        ...text.matchAll(/^import\s+(['"])([^'"]+)\1/gm),
        ...text.matchAll(/\bimport\(\s*(['"])([^'"]+)\1\s*\)/g)
    ].map(match => match[2]);
    return specifiers.flatMap(specifier => {
        if (specifier === 'vscode') return ['vscode'];
        if (!specifier.startsWith('.')) return [];
        const target = join(dirname(file), specifier).split('\\').join('/').replace(/\.js$/, '.ts');
        return [target];
    });
}

/**
 * The modules under `src/` that load `vscode` when they are loaded: those importing it, then,
 * walking the imports backwards, every module importing one of those, cycles included.
 */
function reachingVscode(): string[] {
    const all = sources();
    const importers = new Map<string, string[]>();
    const reached = new Set<string>();
    for (const file of all) {
        for (const target of runtimeImports(file)) {
            if (target === 'vscode') reached.add(file);
            else importers.set(target, [...(importers.get(target) ?? []), file]);
        }
    }
    const pending = [...reached];
    while (pending.length > 0) {
        for (const importer of importers.get(pending.pop()!) ?? []) {
            if (!reached.has(importer)) {
                reached.add(importer);
                pending.push(importer);
            }
        }
    }
    return all.filter(file => reached.has(file));
}

describe('the modules left out of coverage', () => {

    test('are the same for Vitest and for SonarQube', () => {
        const prefix = 'packages/extension/';
        const sonar = sonarList()
            .filter(entry => entry.startsWith(`${prefix}src/`))
            .map(entry => entry.slice(prefix.length));
        expect([...sonar].sort((a, b) => a.localeCompare(b))).toEqual([...vitestList].sort((a, b) => a.localeCompare(b)));
    });

    // Documented beside the Sonar list: neither is under `packages/extension/src/`, where Vitest
    // measures, so neither has an entry to agree with.
    test('differ for SonarQube only by the two files Vitest does not measure', () => {
        const others = sonarList().filter(entry => !entry.startsWith('packages/extension/src/'));
        expect(others).toEqual(['packages/language/src/index.ts', 'packages/extension/esbuild.mjs']);
    });

    test('include every module that reaches vscode at run time', () => {
        const missing = reachingVscode().filter(file => !vitestList.includes(file));
        expect(missing, 'imports vscode, so no test can load it: add it to both lists').toEqual([]);
    });

    test('name files that exist', () => {
        const stale = [
            ...vitestList.filter(entry => !existsSync(join(extensionRoot, entry))),
            ...sonarList().filter(entry => !existsSync(join(repositoryRoot, entry)))
        ];
        expect(stale).toEqual([]);
    });
});
