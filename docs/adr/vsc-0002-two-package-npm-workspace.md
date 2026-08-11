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

The extension depends on it as an ordinary dependency pinned to an **exact version**
(`"jpipe-language": "1.7.0"`), not `workspace:*` or a range. npm workspaces resolve that to the
local package by symlink.

## Rationale

- The package boundary is what actually keeps the language server editor-agnostic. `vscode`
  appears in exactly seven files, all of them in `packages/extension/src/extension/`; the
  language package cannot import it because it does not depend on it.
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
- Adding a capability to the language server that the extension must also know about — a custom
  LSP notification, say — crosses a package boundary and needs a deliberate contract on both
  sides.
- Anything genuinely shared *within* the extension (the webview protocol, the diagnostic report
  types) lives in `packages/extension/src/shared/`, which the language package cannot reach. That
  directory is shared between bundles, not between packages.

## Amendment (2026-08-11): the suspected import cycle does not exist

A structural cycle through `jpipe-module.ts` had been suspected — seventeen services imported by
it, several importing back for the `JpipeServices` type.

The architecture audit built the full graph with the TypeScript compiler over 68 files,
separating value imports from type-only ones, and found **zero value-level cycles**. All ten
imports of `jpipe-module.ts` are type-only and erase at compile time. The
`jpipe-code-action-provider → code-actions/index → jpipe-language-server` triangle is not a cycle
either: nothing imports back.

Recorded so the question is not re-derived. The pre-injection `DocumentBuilder.onUpdate` wiring,
whose comment cites a cycle risk, is defensible as written.

