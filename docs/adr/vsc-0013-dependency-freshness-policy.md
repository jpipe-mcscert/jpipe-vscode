# ADR-VSC-0013: Dependency freshness, and a lockfile CI actually honours

**Date:** 2026-08-11
**Status:** Accepted

## Context

All three workflows installed with `npm install`. That command is free to resolve a tree the
lockfile does not describe — it updates the lockfile rather than obeying it — so "it built in CI"
was a weaker claim than it read as, including in `release.yml`, which is what publishes to the
Marketplace. A lockfile nothing enforces is documentation, not a guarantee.

Nothing watched the dependencies either. Direct dependencies were pinned with `~` and had simply
stopped moving: `@types/node` sat at 22 against 26, `@types/vscode` at 1.91 against 1.125,
TypeScript at 5.8 against 7.0. `npm audit` was clean, so nothing was *wrong* — but the first
notice of a vulnerability would have been someone running the audit by hand.

Left alone, these compound: the longer the gap, the larger each upgrade, and the more tempting it
becomes to take several at once and lose the ability to bisect a regression.

Automating updates is not free of structure, though. This repository is an npm workspace with one
root `package-lock.json`, and several of its dependencies are not independently choosable: they
are pinned to the Node runtime, to the minimum supported editor, to generated code, or to another
package's version ranges.

## Decision

**CI installs with `npm ci`,** in `build.yml`, `sonar.yml` and `release.yml`. It installs exactly
what `package-lock.json` records and fails when manifest and lockfile disagree. `setup-node` uses
`cache: npm` in all three.

**Dependabot runs weekly, from two entries:** one `npm` entry at the repository root, and one
`github-actions` entry. The root npm entry is the only one; it edits all three manifests and the
lockfile together.

**Updates are grouped.** Groups carry minor and patch updates only, with one exception:

| Group | Members | Update types |
|---|---|---|
| `vitest` | `vitest`, `@vitest/*` | major, minor, patch |
| `types` | `@types/*` | minor, patch |
| `dependencies` | everything else | minor, patch |
| `actions` | every GitHub Action | all |

`vitest` is declared first and excluded from `dependencies`, so its members never land elsewhere.
A major outside the `vitest` group arrives as its own pull request.

**Some updates are held,** each listed in `ignore` with its reason:

- **`@types/vscode`: every update.** It declares the minimum VS Code API this extension builds
  against, and `engines.vscode` must not exceed it. Raising it drops support for older editors —
  a product decision, not a dependency update.
- **`@types/node`, `typescript`, `langium`, `langium-cli`: majors.** Each is pinned to something
  outside npm's control — the Node the project runs on, the language level the code targets, the
  generated AST (jpipe-vscode ADR-VSC-0006). Minors and patches flow.
- **`vscode-languageserver`, `-protocol`, `-types`, `-textdocument` and `vscode-languageclient`:
  majors and minors.** Patches flow.

**Dependabot's secret store holds a `SONAR_TOKEN`,** so its pull requests pass through the same
required quality gate as any other (jpipe-vscode ADR-VSC-0009).

## Rationale

- `npm ci` is the whole point of committing a lockfile. It fails loudly when the two are out of
  sync, which `scripts/release.sh prepare` already guarantees before a release — so the check
  costs nothing and catches a manifest edited by hand.
- **One npm entry, at the root.** Every manifest in the workspace resolves into the single root
  lockfile, which a workspace-scoped entry never touches. Against `npm ci`, a per-workspace entry
  produces a pull request that can never pass: `npm ci can only install packages when your
  package.json and package-lock.json are in sync`.
- **Grouping is not cosmetic.** Every update runs a full clean build, both suites and the quality
  gate; ungrouped, a quiet week of `@types` patches would mean a dozen runs of an eight-minute
  pipeline. Grouped, a red build names one week's changes, still a small set to bisect.
- **Majors stay out of groups** because a failing major takes every update in its group down with
  it. A TypeScript major bundled with harmless LSP minors leaves the minors unreachable except by
  hand.
- **The exception is a set of packages that pin each other exactly.** `vitest` and
  `@vitest/coverage-v8` peer-depend on each other's exact version, so they are one dependency
  published as two packages. Moved separately, npm keeps the old `vitest` for the plugin and
  nests the new one in each workspace: two majors in one lockfile. Vitest only warns about the
  mismatch, so such a pull request passes every check. Grouped, they cannot diverge, and failing
  together is the correct outcome. The exception covers exact mutual pins only, not packages that
  merely tend to move together.
- **Automatic majors are otherwise rejected.** A major that passes the gate can still change
  behaviour the tests do not reach — the extension host, the webview, the compiler subprocess —
  and roughly half the extension package has no automated coverage (jpipe-vscode ADR-VSC-0004).
  The test runner is the one place that objection does not apply: what vitest does *is* the test
  run, which the gate exercises in full.
- **The LSP packages are whatever langium's ranges permit.** `langium` declares
  `vscode-languageserver`, `-protocol`, `-types` and `-textdocument` with `~` ranges. A minor
  outside those ranges installs a second, nested copy beside langium's hoisted one, and
  TypeScript then rejects two structurally identical but nominally distinct `_Connection` types in
  `language/main.ts`. `npm install` and `npm dedupe` cannot resolve that; only a langium release
  can. `vscode-languageclient` is not a langium dependency, but it ships in lockstep with
  `vscode-languageserver`, pins `-protocol` and `-textdocument` exactly, and is used as a matched
  pair with it across the two workspaces. Patches stay inside the ranges and dedupe normally.
- **The Sonar token is shared knowingly.** Dependabot runs with its own secret store; without the
  token, the required `Build and analyze` check fails on every automated pull request regardless
  of content. It is a project-analysis token on a public project, and the alternative — exempting
  automated pull requests from the gate — is a larger hole than the one it closes.
- Weekly rather than daily, because nothing here moves fast enough to need daily, and a queue of
  open dependency pull requests is how a team learns to stop reading them.
- No automation, with a periodic manual sweep, is the alternative, and it is what produced the
  four-month gap described above.

## Consequences

- **A manifest edited without running `npm install` breaks CI.** That is intended, and the error
  message says so.
- Dependency updates arrive as pull requests that must pass the quality gate like any other
  change. The expected steady state is one npm pull request and one actions pull request a week,
  plus a `vitest` one on the weeks vitest moves, and a standalone one per unheld major.
- **A langium upgrade is a hand-written branch**, and it carries the five LSP packages with it.
  Dependabot can move `langium` within a major but leaves the LSP pins where they are, and the
  build then fails with two server copies. Supersede such a pull request rather than pushing fixes
  onto it.
- The held pins need reviewing by hand, and nothing will remind anyone. `@types/vscode` in
  particular is revisited whenever the minimum supported VS Code version is.
- npm 10.9 crashes (`reading 'edgesOut'`) when moving `vitest` and `@vitest/coverage-v8` together
  in place; npm 11 does not. If Dependabot's npm hits that defect, the `vitest` pull request fails
  outright and the bump is done by hand.
- Adopting the `github-actions` ecosystem removes the premise on which jpipe-vscode ADR-VSC-0011
  declined commit-SHA pinning, namely that nothing would advance the SHAs. Adopting SHA pins is a
  separate change, applied to every action at once or not at all.
- Caching `setup-node` makes CI faster but adds a state that can be wrong. A build that fails only
  in CI and not locally is worth re-running once with the cache busted before being believed.
