# ADR-VSC-0005: Two esbuild bundles — CJS host, IIFE webview

**Date:** 2026-08-10
**Status:** Accepted

## Context

All source in this repository is ESM: every `package.json` declares `"type": "module"`, and
imports carry explicit `.js` extensions. But the two things the extension package ships run under
incompatible loaders.

The VS Code extension host still loads extension entry points as CommonJS. A `.js` file inside a
`"type": "module"` package is treated by Node as ESM, so shipping ESM to the host fails to load.

The preview webview runs in a browser inside a webview panel. It has no module loader, no
`require`, and is delivered by a `<script>` tag from a generated HTML shell — so it needs a
single self-contained script with no import statements at all.

## Decision

`esbuild.mjs` maintains two independent build contexts.

The **host** context bundles `src/extension/main.ts` and `src/language/main.ts` to `out/`, as
`format: 'cjs'`, `platform: 'node'`, target ES2017, with `external: ['vscode']` and
`outExtension: { '.js': '.cjs' }`.

The **webview** context bundles `src/webview/preview.ts` and `preview.css` to `out/webview/`, as
`format: 'iife'`, `platform: 'browser'`, target ES2020.

`packages/extension/src/shared/` is the **only** code both bundles may import.

## Rationale

- The `.cjs` extension is what makes CommonJS output legal inside a `"type": "module"` package.
  Without it Node reads `out/extension/main.js` as ESM — because the nearest `package.json` says
  so — and the extension fails to activate. `main` in `package.json` therefore points at
  `./out/extension/main.cjs`.
- `external: ['vscode']` is not an optimisation. The module does not exist on disk; it is
  injected by the host at runtime, and bundling it would fail resolution.
- Two contexts rather than one with per-entry overrides: esbuild's `format`, `platform` and
  `outExtension` are context-level, and the two sets have nothing in common. Trying to express
  both in one config would mean fighting it.
- The language server is bundled to CJS as well, even though it runs as its own Node process and
  could stay ESM. It ships inside the same VSIX and is spawned by the host, so one output
  convention for both is simpler than two.
- `src/shared/` exists because both bundles need the webview message protocol and the diagnostic
  report shape, and duplicating either would let the two sides drift silently — a message the
  host sends and the webview no longer understands produces no error anywhere.

## Consequences

- `src/shared/` must compile under both the host's and the webview's `lib` sets (see
  jpipe-vscode ADR-VSC-0003), so it can hold types and logic over plain data, but nothing that
  touches an environment.
- Anything in `src/shared/` is bundled into **both** outputs. It is duplicated at runtime, which
  is fine for types (erased) and small pure functions, and a reason not to put anything large
  there.
- `tsc -b` type-checks; esbuild bundles and does no type-checking of its own. Both must run — the
  package's `build` script is `tsc -b … && node esbuild.mjs`, in that order, and running esbuild
  alone will happily bundle code that does not type-check.
- esbuild transpiles file-by-file and erases types without a full program view. A type re-exported
  as if it were a value would become a runtime import of a binding that does not exist — a
  failure visible only in the bundle. TypeScript's `isolatedModules` flag is what catches this,
  and it is currently **not** enabled.
- Sourcemaps are emitted unless `--minify` is passed, and `.vscodeignore` excludes `**/*.map`
  from the VSIX.
