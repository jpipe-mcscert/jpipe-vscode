# ADR-VSC-0003: A DOM-free host, enforced by separate tsconfig projects

**Date:** 2026-08-10
**Status:** Accepted

## Context

The extension package contains code that runs in three different places. The extension host is
Node: no `document`, no `window`. The language server is a separate Node process: likewise. The
preview webview is a browser: DOM and nothing else — no `vscode` module, no `node:fs`.

A single `tsconfig.json` covering `src/` would have to include the `DOM` lib, because the webview
genuinely needs it. That makes `document` and `window` resolve everywhere, including in the
extension host, where using them compiles cleanly and then throws `ReferenceError` at runtime in
front of a user. The failure has no compile-time signal at all, which is the worst possible shape
for it.

## Decision

The two environments are separated by TypeScript project, not by convention. `lib` is scoped per
project, and no project has both the DOM and the host's code in it:

| Project | Includes | `lib` |
|---|---|---|
| `packages/language/tsconfig.src.json` | `src/**` (the only emitting project) | ES2021 |
| `packages/extension/tsconfig.json` | `src/extension`, `src/language`, `src/shared` | ES2021 |
| `packages/extension/src/webview/tsconfig.json` | `src/webview`, `src/shared` | ES2021 + DOM + DOM.Iterable |
| `packages/language/tsconfig.test.json` | `test/**` | ES2021 |
| `packages/extension/tsconfig.test.json` | `src/**` and `test/**` | ES2021 + DOM |

The webview's project file **must** be named `tsconfig.json` and **must** sit in
`src/webview/`. That is not stylistic: the TypeScript language server walks up from the file you
opened and stops at the first `tsconfig.json` it finds. Held at the package root under any other
name it would be invisible to editors, and the webview files would be checked against the
extension-host project — which does not include them and has no DOM types.

## Rationale

- It makes the invariant mechanical. "The host contains no DOM code" is not a rule anyone has to
  remember or review for; `document` simply does not resolve there.
- The `lib` scoping is symmetrical and equally valuable in the other direction: the webview
  project excludes the host's code, so `vscode` and `node:` imports are unavailable to browser
  code by the same mechanism.
- `src/shared/` is included by both the host project and the webview project, which is exactly
  what makes it the one place code may be shared between the two bundles — see
  jpipe-vscode ADR-VSC-0005.
- An eslint rule (`no-restricted-globals`, or an import boundary rule) was the alternative. It
  needs a linter the repository does not have, it reports later than the compiler does, and it is
  a second source of truth about a boundary the compiler can enforce for free.
- The test project is the one place host and webview code meet, deliberately: the extension's
  Vitest suite covers both, so it carries DOM and the widest `include`.

## Consequences

- There are five TypeScript projects for two packages. `tsc -b` sequences them, and the extra
  configuration is the price of the guarantee.
- **`packages/extension/src/webview/tsconfig.json` is not referenced from `tsconfig.build.json`.**
  It is built only by the extension package's own `build` script
  (`tsc -b tsconfig.json src/webview`). A root `npm run watch`, which runs
  `tsc -b tsconfig.build.json --watch`, therefore does not type-check the webview on change. This
  is a known gap, not a decision.
- Moving a file between `src/extension/`, `src/webview/` and `src/shared/` changes which globals
  it may use. A module that grows a DOM dependency has to move, not just gain an import.
- Anything placed in `src/shared/` must compile under *both* `lib` sets, which in practice means
  it can be types, or logic over plain data, but not anything that touches an environment.
