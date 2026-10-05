# ADR-VSC-0002: Two packages in one npm workspace

**Date:** 2026-08-10
**Status:** Accepted

## Context

jPipe tooling for editors has two distinct halves. One is the language itself — the Langium
grammar, the validator, scoping, completion, code actions — which is pure LSP and knows nothing
about any particular editor. The other is the VS Code client: commands, menus, the webview
preview, the settings surface, and the machinery that shells out to the jPipe compiler.

Those halves have different dependency sets (`langium` and `vscode-languageserver` versus
`@types/vscode` and `vscode-languageclient`), different module formats at runtime, different test
constraints, and different reasons to change. Keeping them in one package would mean the language
server compiling against `@types/vscode`, and nothing but review discipline stopping it from
importing the VS Code API — which would make the server unusable in any other editor.

## Decision

The repository is an npm workspace with two packages: `packages/language` (`jpipe-language`) and
`packages/extension` (`jpipe-extension`). `jpipe-language` is shaped like a publishable library —
it has an `exports` map, a `main`, a `types` entry and a real build output under `out/` — even
though it is not currently published to npm.

The extension depends on it as an ordinary dependency pinned to an **exact version** —
`"jpipe-language": "X.Y.Z"`, the repository's own current version — not `workspace:*` or a
range. npm workspaces resolve that to the local package by symlink.

**Development tooling that both packages use is declared once, in the root `package.json`** —
`typescript`, `@types/node`, `shx`, `vitest` and `@vitest/coverage-v8`. A package declares only
what it alone uses (`langium-cli` in the language package; `esbuild`, `happy-dom`, `@types/vscode`
in the extension). A workspace's scripts find root-declared binaries, since npm puts every
ancestor's `node_modules/.bin` on their `PATH`.

## Rationale

- The package boundary is what actually keeps the language server editor-agnostic. `vscode`
  is imported only under `packages/extension/src/extension/`; the language package cannot import
  it because it does not depend on it.
- Shaping `jpipe-language` as publishable, rather than as an internal folder, means the day it is
  wanted in another editor's client — or as a standalone LSP binary — nothing has to be
  untangled. The public surface is deliberate: `src/index.ts` is the only entry point.
- Exact-version pinning rather than `workspace:*` keeps the manifest meaningful to plain npm. It
  also makes the version mismatch that would break a release detectable by a string comparison,
  which `scripts/release.sh` and `.github/workflows/release.yml` both do — see
  jpipe-vscode ADR-VSC-0008.
- A single package with a lint rule banning `vscode` imports in a subdirectory was considered.
  It needs a linter this repository does not have, and it is a weaker guarantee than a dependency
  graph that makes the import unresolvable.
- Two separate repositories were considered and rejected: the two halves version together, ship
  together, and are developed by the same people in the same change.
- **Shared tooling is declared once because a root declaration has exactly one place to live.**
  Declared in both workspaces, npm is free to install a copy inside each workspace's own
  `node_modules`, and it does so whenever an update passes through a conflict. That breaks
  `vitest` and its coverage provider, which pin each other's exact version: Dependabot moves the
  members of its `vitest` group one at a time with `--force`, so the plugin's new major meets the
  old `vitest` at the root, is nested in each workspace, and stays there after `vitest` follows.
  Vitest loads its provider with a bare import from its own location at the root, which cannot
  see into a workspace, so coverage fails with `Cannot find package '@vitest/coverage-v8'`.
  Declared at the root, the same updates leave both packages side by side, and both workspaces
  run the same version of the tools by construction rather than by keeping two ranges in step.

## Consequences

- The version now lives in **four** places that must agree: the three `package.json` files and
  the `jpipe-language` dependency pin inside the extension's. This is the direct cost of exact
  pinning, and it is why releases go through a script (jpipe-vscode ADR-VSC-0008).
- `npm version --workspaces` must be run with `--no-workspaces-update`, because otherwise npm
  tries to resolve the still-old `jpipe-language` version against the public registry and fails
  with a 404 — the package is workspace-local and has never been published.
- `packages/language/out/` must exist before the language package's tests run: the tests import
  `'jpipe-language'`, which resolves through the `exports` map to the built `out/index.js` rather
  than to source. Every CI job therefore builds before it tests, and the ordering is commented in
  the workflow.
- **A package's manifest does not list all the tools its own scripts run.** `vitest run` in
  `packages/language` works only inside the workspace, where the root's binaries are on the
  `PATH`. That is acceptable while neither package is built or tested on its own; publishing
  `jpipe-language` would not change it, since `devDependencies` are not installed for consumers.
- Adding a capability to the language server that the extension must also know about — a custom
  LSP notification, say — crosses a package boundary and needs a deliberate contract on both
  sides.
- Anything genuinely shared *within* the extension (the webview protocol, the diagnostic report
  types) lives in `packages/extension/src/shared/`, which the language package cannot reach. That
  directory is shared between bundles, not between packages.
- The language package has no value-level import cycle. Every service that refers back to
  `jpipe-module.ts` does so for the `JpipeServices` type alone, with `import type`, which erases
  at compile time; no service imports it for a value (only `index.ts` re-exports it). A service that needs another one reaches it
  through the injected `JpipeServices` handle, never through a value import of the module, so
  that stays true. Wiring that must reach a service *during* injection — the
  `DocumentBuilder.onUpdate` hook that clears the glob cache — is done in `createJpipeServices`
  after `inject` returns, which avoids a cycle in the dependency-injection graph rather than in
  the import graph.

