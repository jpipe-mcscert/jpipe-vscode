# ADR-VSC-0010: Coverage measurement, and honest exclusions

**Date:** 2026-08-10
**Status:** Accepted

## Context

The quality gate adopted in jpipe-vscode ADR-VSC-0009 has a coverage condition on new code.
Sonar only sees coverage if the build hands it an LCOV report, and this repository produced
none — there was no coverage tooling of any kind.

Two properties of this repository make that harder than adding a flag.

First, **the two workspaces measure differently**. The extension's tests import `../src/**`
directly, so the instrumented file is already the source. The language package's tests import
`'jpipe-language'`, which resolves through the package's `exports` map to the *built*
`out/index.js` — deliberately, so the suite exercises the package the way a consumer does (see
jpipe-vscode ADR-VSC-0002). There, v8 instruments JavaScript and the result must be remapped
through the source maps `tsc` emits.

Second, **roughly half the extension package cannot be covered at all**. Ten modules import
`vscode` or are environment entry points, and none can be loaded without a VS Code host or a
browser (jpipe-vscode ADR-VSC-0004). Counting them would report them as 0% forever and drag the
figure down by a constant that no amount of test-writing could move.

## Decision

Coverage is measured by `@vitest/coverage-v8`, per workspace, emitting `text-summary` and
`lcov` into `packages/*/coverage/`. `npm run test:coverage` produces both reports;
`sonar.javascript.lcov.reportPaths` names both files. The plain `test` script is left
untouched, so `build.yml`, `release.yml` and `release.sh` are unaffected.

Modules that cannot be loaded are excluded from coverage, in **two places that must stay in
step**: `coverage.exclude` in `packages/extension/vitest.config.ts`, and
`sonar.coverage.exclusions` in `sonar-project.properties`.

The rule for that list is **uncoverable by construction, never merely untested**. A module
belongs on it because loading it throws — not because covering it is inconvenient, and not
because it is currently untested. Adding to it is a decision to be argued, not a way to make a
number go up.

## The `include` asymmetry between the two configs

The two `vitest.config.ts` files differ, and the difference is not an oversight.

The extension's config sets `coverage.include: ['src/**/*.ts']`. Its tests import source
directly, so the setting behaves as it reads: a module no test reaches is reported at 0% rather
than being absent, which is what stops newly added untested code from quietly improving the
average.

The language package's config **deliberately omits it**. The filter is applied to the
*executed* path, so with `include: ['src/**/*.ts']` every `out/*.js` file is discarded before
it can be mapped back to source. The report does not fail — it silently collapses to the three
modules some tests import from `../src/` directly, and reports **6.38%** where the true figure
is **86.52%**. Nothing in the output indicates the number is wrong. Omitting `include` loses
nothing there, because `src/index.ts` re-exports the whole package, so every module is loaded
and appears in the report anyway.

A related trap: the language package's exclusion globs are matched against absolute paths, so
they must not be anchored at the package root. `src/generated/**` does not match;
`**/generated/**` does.

## Rationale

- Measuring per workspace, rather than merging into one report, matches how the packages are
  built and tested and avoids a merge step that could hide a missing report as a passing one.
- `@vitest/coverage-v8` over Istanbul: it needs no instrumentation step and reuses the runtime's
  own coverage. Its version must match `vitest` exactly, or Vitest refuses to start.
- Aliasing `'jpipe-language'` to `src/index.ts` under test was considered as a way to sidestep
  the remapping entirely. It works — 82% — but it changes what the suite guarantees, from
  "the built package behaves" to "the sources behave", and it would stop the tests noticing a
  broken `exports` map or a missing re-export. Rejected, since omitting `include` achieves the
  same coverage without giving that up.
- Excluding the unloadable modules rather than lowering the gate's coverage threshold: a
  threshold applies to everything, so lowering it to accommodate code that *cannot* be tested
  would also excuse code that simply *is not*.

## Consequences

- **Two exclusion lists must agree.** They are in different files, in different formats, and
  nothing enforces their agreement. A module added to one and not the other produces either an
  unexplained 0% in Sonar or a silently inflated local figure. The correspondence is exact for
  the extension's source modules; Sonar carries two additional entries with no Vitest
  counterpart, `packages/language/src/index.ts` (eighteen `export *` lines, reporting `LF:0`)
  and `esbuild.mjs` (a build script outside Vitest's `src/` coverage scope).
- The baseline, from a clean build: language 81.85% statements / 86.52% lines across 45
  modules; extension 93.44% / 94.17% across 11. The extension's figure covers only the half of
  the package that is loadable, and reads high for that reason — it is not comparable to the
  language package's.
- `coverage/` is git-ignored and removed by both `clean` scripts. Both were required in the same
  change: `release.sh check_clean_tree` uses `git status --porcelain`, which reports untracked
  files, so without the ignore rule `release.sh prepare` would refuse to run on any machine that
  had produced a coverage report.
- The exclusion list is a standing invitation to cheat, and the rule above is the only thing
  preventing it. A module that becomes hard to test is not thereby uncoverable; the answer is to
  push its logic below the seam (jpipe-vscode ADR-VSC-0004), not to add a line here.
- A "types only" justification must be checked against the file's exports rather than assumed
  from its name. `preview-protocol.ts` qualifies — every export is a `type` or `interface`. Its
  neighbour `diagnostic-report.ts` does not: it exports a runtime `SUPPORTED_SCHEMA_VERSION`,
  and was briefly and wrongly excluded on this basis.

## Amendment (2026-08-11): release-manager.ts is now excluded honestly

This record's rule is *uncoverable by construction, never merely untested*. The architecture
audit found `release-manager.ts` failing it: 300 lines behind **five** `vscode.*` references — a
1.7% density — doing GitHub HTTPS, redirect handling, host validation and file placement, none of
which needs an editor. It was on the exclusion list by **accretion**, which by this record's own
terms made the exclusion dishonest.

It has been split. `release-download.ts` holds the work and imports no `vscode`; `ReleaseManager`
is now 131 lines of settings reads, `globalState` and one notification — things only an extension
host can do.

- **The exclusion list is unchanged.** `release-manager.ts` still cannot be loaded, so it stays
  on it; `release-download.ts` was never added. What changed is that the exclusion is now true
  rather than convenient.
- **45 tests now cover logic that had none**, including the security boundary: HTTPS-only, the
  host allowlist, and the redirect ceiling — checked on every hop, since a 302 to an
  attacker-controlled host is the obvious way around a validated first URL.
- **The transport is injectable** (`Transport`, defaulting to `httpsTransport`). Not for its own
  sake: the allowlist refuses every host but GitHub's, so a local test server could not be
  contacted even if one were started. Parameterising it is the only way the redirect, rate-limit
  and malformed-body handling is reachable at all.
- **Measured coverage of the extension package went down**, from 94.19% to 93.28% lines. It went
  down because 96 lines that were previously invisible are now counted, 82 of them covered. A
  figure that improves when code stops being measured is the failure mode this record exists to
  prevent, and the same arithmetic works in reverse.

`image-generator.ts` (6% density) is the same shape one step milder and has not been done.

