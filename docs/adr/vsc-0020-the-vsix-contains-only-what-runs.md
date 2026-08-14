# ADR-VSC-0020: The VSIX contains only what runs

**Date:** 2026-08-13
**Status:** Accepted

## Context

The extension's VSIX had been growing, and `vsce ls --tree` appeared to show tests and coverage
being packaged. Two things turned out to be true, and only one of them was what it looked like.

**`vsce ls` over-reports in a workspace; it does not misreport.** It listed 4526 entries,
including 49 MB of `.git` (2181 objects) and 133 MB of `node_modules`. Of those, **4477 lay
outside the package directory**, every one prefixed `../`. A VSIX places files at
`extension/<path relative to the package root>`, so none of them has a representable path and
none could ever enter the archive — which is why a 696 KB artefact never held 49 MB of git
objects. `.vscodeignore` patterns are relative to `packages/extension/` and cannot match them
either, so no ignore rule would have quietened them. The remaining 49 entries were, diffed
against `unzip -Z1` of a real VSIX, exactly what shipped. The outward walk was dependency
collection: `packages/extension` declares `jpipe-language`, which in an npm workspace is a
symlink into the monorepo, so collecting it enumerated the repository root.
`vsce ls --no-dependencies` returned 49 entries and nothing outside the package.

**Coverage genuinely did ship, whenever it existed on disk.** A VSIX built from this tree
contained **34 coverage files, 667 KB uncompressed** — two of every three files in the package —
including HTML renderings of our own TypeScript sources. `jpipe-vscode-1.6.0.vsix` contains
none. The cause was mundane: `.vscodeignore` was a deny-list, and it had no `coverage/` entry.

That deny-list is worth looking at squarely, because it had every appearance of care. It named
`.git/`, `node_modules/` and `src/` — none of which vsce would have packaged from this
directory anyway — and said nothing about the one directory generated right here that it would.
It was excluding the things someone had thought of.

Published releases were clean, but by accident: `release.yml` and `build.yml` run `npm test`,
only `sonar.yml` runs `test:coverage`, and it never packages — and CI begins from a fresh
`npm ci`, so the directory does not exist there. Nothing enforced it.

The accident also hid a second problem. `release.sh preflight` runs `vsce package` locally and
reported its size as a check; before v1.7.1 it reported "684K VSIX". On a machine that had run
coverage the same command yields 846 KB and 34 extra files. Preflight was reassuring us about an
artefact that is not the one CI publishes.

Alternatives on the table: extend the deny-list; keep it and rely on review; add the guard
without inverting the list.

## Decision

The VSIX carries only what the extension executes or the Marketplace displays.

`packages/extension/.vscodeignore` is an **allow-list**: everything is excluded, and each line
re-admits one thing. The packaged inventory is committed as
`packages/extension/vsix-contents.txt`, and `scripts/check-vsix.sh` compares a built VSIX
against it — in both directions — from `build.yml` and from `release.sh preflight`. Packaging
passes `--no-dependencies` at every call site.

## Rationale

- **A deny-list can only exclude what someone thought of.** That is not a hypothetical
  weakness here; it is the exact shape of what happened. An allow-list inverts the default, so
  the next generated directory is out until somebody argues it in.
- **Review was the control, and review is what missed it.** The artefact is a zip; nothing about
  reading a diff of `.vscodeignore` tells you what ended up inside one. A check that unzips is
  the only kind that answers the question actually being asked.
- **The guard runs in both directions because the allow-list introduces a new failure mode.**
  Over-inclusion ships a fat download; under-inclusion ships an extension that installs cleanly
  and quietly does not work. The second is worse, and it is the one this decision creates.
- **`--no-dependencies` removes the outward walk at its source** rather than teaching people to
  ignore it. The bundles are self-contained esbuild output, the VSIX contains no `node_modules`,
  and `jpipe-language` is a workspace package that is never published — so dependency collection
  buys nothing. Verified content-identical before and after: 51 files, 846,579 bytes both ways.
  Its real value is that `vsce ls` becomes an exact preview of the artefact, so the next person
  to look is not confronted with 2181 git objects and a false alarm.
- **The inventory is generated from a package, never hand-written.** A hand-written expectation
  is a second opinion about the artefact rather than a record of it.

## An ignore rule vsce will not honour

`!out/**` followed by `out/**/*.map` does not re-exclude the source maps. vsce applies every
negation last rather than letting later lines win, so the broad negation re-admits the whole
directory and the maps ship: the VSIX went from 846 KB to **1.9 MB**, larger than the problem
being fixed. The allow-list therefore admits bundles by kind — `!out/**/*.cjs`, `!out/**/*.js`,
`!out/**/*.css` — which leaves `.map` files out by construction instead of by a subtraction that
does not take effect. Anyone tempted to simplify those three lines to `!out/**` should package
and look.

## Consequences

- **Adding a runtime asset now needs a `.vscodeignore` edit**, and forgetting it ships an
  extension that installs and misbehaves rather than one that is merely fat. That is a worse
  failure traded for a more detectable one — which is only a good trade because the guard makes
  it detectable, in CI, on the build that introduces it.
- **`vsix-contents.txt` must be updated deliberately.** Regenerating it to make a red build go
  green defeats the whole mechanism; the diff is the review, and a `+` line is a question.
- **The VSIX drops from 51 files to 16**, and from 846,579 to 667,135 bytes on a tree with
  coverage present. Against the published v1.7.1 the saving is the 95 KB `images/mcscert.svg`,
  which nothing — manifest, README or source — referenced.
- **`release.sh preflight` now fails on a polluted tree** instead of printing a comfortable size,
  which is the point: it is the one check that runs where the stray artefacts actually live.
- **None of this touches the real weight.** `out/language/main.cjs` (1.6 MB) and
  `out/extension/main.cjs` (1.59 MB) remain 77% of the uncompressed artefact. Growth there is
  features landing, and if the download becomes a problem that is where to look — not here.
- **The guard cannot tell whether a file is *correct*, only whether it is *expected*.** A stale
  bundle of the wrong build passes it cleanly.
