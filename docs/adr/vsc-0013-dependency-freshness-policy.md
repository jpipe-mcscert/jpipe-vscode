# ADR-VSC-0013: Dependency freshness, and a lockfile CI actually honours

**Date:** 2026-08-11
**Status:** Accepted

## Context

The architecture audit of 2026-08-11 turned up two related gaps.

All three workflows installed with `npm install`. That command is free to resolve a tree the
lockfile does not describe — it updates the lockfile rather than obeying it — so "it built in CI"
was a weaker claim than it read as, including in `release.yml`, which is what publishes to the
Marketplace. A lockfile nothing enforces is documentation, not a guarantee.

There was also no `dependabot.yml`. Direct dependencies were pinned with `~` and had simply
stopped moving: `@types/node` sat at 22 against 26, `@types/vscode` at 1.91 against 1.125,
TypeScript at 5.8 against 7.0. `npm audit` was clean, so nothing was *wrong* — but nothing was
watching either, and the first notice of a vulnerability would have been someone running the
audit by hand.

Left alone, these compound: the longer the gap, the larger each upgrade, and the more tempting it
becomes to take several at once and lose the ability to bisect a regression.

## Decision

**CI installs with `npm ci`,** in `build.yml`, `sonar.yml` and `release.yml`. It installs exactly
what `package-lock.json` records and fails when manifest and lockfile disagree.

**Dependabot runs weekly**, over four scopes: the three npm manifests and `github-actions`.
Updates are **grouped** — `@types/*` together, everything else together, actions together —
rather than one pull request per package.

Three pins are held deliberately and are listed in `ignore`:

- **`@types/vscode` is never bumped automatically.** It declares the *minimum* VS Code API this
  extension builds against, and `engines.vscode` must not exceed it. Raising it drops support for
  older editors — a product decision, not a dependency update.
- **`langium` and `langium-cli` majors are held.** Their generated output is regenerated from the
  grammar on every build (jpipe-vscode ADR-VSC-0006), so a major means re-checking the AST and
  the services against it. Minors and patches still flow.

`setup-node` gets `cache: npm` in all three workflows.

## Rationale

- `npm ci` is the whole point of committing a lockfile. It also fails loudly when the two are out
  of sync, which `scripts/release.sh prepare` already guarantees before a release — so the check
  costs nothing and catches the case where someone edited a manifest by hand.
- Grouping is not cosmetic. Every update here runs a full clean build, both suites and the quality
  gate; ungrouped, a quiet week of `@types` patches would mean a dozen runs of an eight-minute
  pipeline. Grouped, a red build names one week's changes, which is still a small enough set to
  bisect.
- Weekly rather than daily, because nothing here moves fast enough to need daily, and a queue of
  open dependency pull requests is how a team learns to stop reading them.
- Automatic majors were rejected. A major that passes the gate can still change behaviour the
  tests do not reach — the extension host, the webview, the compiler subprocess — and roughly half
  the extension package has no automated coverage at all (jpipe-vscode ADR-VSC-0004).
- The alternative of no automation, with a periodic manual sweep, is what produced the four-month
  gap this record exists to close.

## Consequences

- **A manifest edited without running `npm install` now breaks CI**, where before it would have
  been silently reconciled. That is the intended behaviour, and the error message says so.
- Dependency updates arrive as pull requests that must pass the quality gate like any other
  change. A grouped update that fails is a normal debugging task, not an emergency.
- The three held pins need reviewing by hand, and nothing will remind anyone. `@types/vscode` in
  particular should be revisited when the minimum supported VS Code version is next discussed.
- Adopting the `github-actions` ecosystem **changes the premise of jpipe-vscode ADR-VSC-0011**,
  which declined commit-SHA pinning specifically because nothing would advance the SHAs. Something
  now would. That record carries an amendment; adopting SHA pins is a separate change, applied to
  every action at once or not at all.
- Caching `setup-node` makes CI faster but adds a state that can be wrong. A build that fails only
  in CI and not locally is worth re-running once with the cache busted before being believed.

## Amendment (2026-08-11): three of these decisions were wrong, and one interaction was missed

Dependabot opened five pull requests. Four could not go green, and the reasons were structural
rather than bad luck.

**Per-workspace entries produce unmergeable pull requests.** This record set up one npm entry per
manifest. But these are npm workspaces: every manifest resolves into a single root
`package-lock.json`, which a workspace-scoped entry never touches. Against `npm ci` — adopted in
the same change as this record — the result is
`npm ci can only install packages when your package.json and package-lock.json are in sync`, on
every run, forever. Two decisions taken together that contradicted each other.

The root entry alone already edits all three manifests *and* the lockfile, which the first run
demonstrated. There is now one npm entry.

**A grouped major takes the group down with it.** The `dependencies` group bundled TypeScript
5.8 → 7.0 with three `vscode-languageserver` minors that were perfectly fine. The major failed
compilation and the whole pull request with it, so the good updates were unreachable except by
hand. Groups now carry `update-types: [minor, patch]` only.

**Ignoring `@types/vscode` alone was an arbitrary line.** The same argument applies to everything
pinned to something outside npm's control, and the first run proved it: `@types/node` 22 → 26
against a Volta-pinned Node 22 stopped `node:path` resolving. `typescript`, `@types/node`,
`langium`, `langium-cli` and `@vitest/coverage-v8` now have their majors ignored, each with the
reason in the file. Minors and patches still flow.

**On automated pull requests and the quality gate.** Dependabot runs with Dependabot secrets, a
store separate from Actions secrets. With that store empty, `Build and analyze` failed on every
Dependabot pull request with `Not authorized`, regardless of content — and it is a required
check, so none of them could ever merge. A `SONAR_TOKEN` has been added to the Dependabot secret
store. That is a real widening of who holds the token, accepted knowingly: it is a
project-analysis token on a public project, and the alternative was exempting automated pull
requests from the gate, which is a larger hole than the one it closes.

The expected steady state is one npm pull request and one actions pull request a week, both able
to pass.

## Amendment (2026-08-11): langium pins the LSP packages, and that is now written down

The first run under the corrected configuration produced one npm pull request with five safe
updates and the lockfile included — the intended shape. It still failed to build, and the reason
turned out to be a constraint nobody had recorded:

```
jpipe-language
├─┬ langium@4.3.1
│ └── vscode-languageserver@10.0.1     ← holds the hoisted root slot
└── vscode-languageserver@10.1.0        ← nested, because the root slot is taken
```

`langium@4.3.1` declares `vscode-languageserver: ~10.0.1`, so 10.1.0 is outside its range. npm
hoists langium's 10.0.1 to the root and gives the workspaces a second, nested copy. TypeScript
then sees two structurally identical but nominally distinct `_Connection` types and rejects the
assignment in `language/main.ts`.

**This is a real version conflict, not a Dependabot artefact.** `npm install` on the branch does
not resolve it, and `npm dedupe` only reduces four nested entries to two. The bump cannot succeed
until langium widens its own range.

So the five `vscode-language*` packages join the ignore list, holding minors and majors and
letting patches through — patches stay inside `~10.0.1` and dedupe normally.

Worth separating two lessons. The narrow one is a configuration fix. The broader one is that
**the LSP dependency versions in this repository are not independently choosable**: they are
whatever langium's range permits, and moving them is a langium upgrade wearing a different hat.
That was true before Dependabot and will be true after it; the bot's only contribution was to
surface it by trying.

On the open question of whether the bot earns its place here: this run produced two updates that
could have merged (`typescript` 5.9.3, `esbuild` 0.28.2), one genuine finding, and four pull
requests that could not. The next run is the test of whether the corrected configuration is quiet.

