# ADR-VSC-0016: A directory names one concern

**Date:** 2026-08-11
**Status:** Accepted

## Context

`src/extension/image-generation/` had grown to seven modules and 1,884 lines. Three of them
generated no image: `release-manager.ts` downloads a compiler from GitHub Releases and checks
the payload, `preview-provider.ts` owns the webview panel's lifecycle, `preview-shell.ts` is the
panel's HTML.

(`release-manager.ts` checks the download's byte size against the size GitHub reports, and
computes a SHA-256 that it records in the log. It does not compare that digest against an
expected value — there is no published one to compare it to — so the integrity check here is a
size check, and the transport's authenticity rests on HTTPS plus the host allowlist in
`release-selection.ts`.)

The architecture audit did not settle this by reading the names. It built the import graph with
the TypeScript compiler and found two chains that barely touch:

```
release-selection ← release-manager
release-selection ← compiler-invocation          "obtain and run the compiler"
release-manager, compiler-invocation ← image-generator

preview-shell, preview-refresh ← preview-provider   "show a panel"

preview-provider → image-generator                  the only edge between them
```

That single edge is a consumer relationship — the panel asks for a render — not evidence of a
shared concern. Two groups of files, one name describing neither.

A directory name is read far more often than it is chosen. Anyone looking for the
GitHub-Releases download had no reason to open `image-generation/`, and anyone opening it
expecting image generation found the webview panel.

## Decision

`image-generation/` is split along the boundary the graph already showed:

- **`src/extension/compiler/`** — obtaining and running the jPipe compiler.
  `release-selection.ts`, `release-manager.ts`, `compiler-invocation.ts`, `image-generator.ts`.
  1,094 lines.
- **`src/extension/preview/`** — the diagram panel.
  `preview-shell.ts`, `preview-refresh.ts`, `preview-provider.ts`. 790 lines.

The one cross-directory import, `preview/preview-provider.ts` → `compiler/image-generator.ts`,
stays as it is and points the right way: the panel depends on the compiler, never the reverse.

## Rationale

- The split was measured, not asserted. After the move each directory is internally connected and
  the only edge between them is the one consumer relationship, which is what a module boundary
  should look like.
- Renaming the single directory to something broader — `compiler-and-preview/`, or the honest but
  useless `image/` — was considered. It would have made the name accurate and left the problem:
  two concerns that change for different reasons, reviewed as one unit.
- Splitting by layer instead of concern (`services/`, `providers/`) was rejected. That names how
  a file is built rather than what it is for, so it gives no help to the person looking for the
  download logic.
- The move is cheap now and gets steadily less so. Three imports in `main.ts`, three in tests,
  four entries in each of two coverage-exclusion lists.

## Consequences

- **Two coverage-exclusion lists had to move with it**, in `vitest.config.ts` and
  `sonar-project.properties`, because both name files by path. Nothing enforces that they agree
  with reality; a stale entry silently excludes nothing and is invisible until someone checks.
  Doing this move surfaced two entries still naming `image-generation/index.ts`, a file deleted
  a week earlier — they had been excluding a path that did not exist.
- `git mv` keeps the history, so `git log --follow` still works on every moved file. Reviewers
  should read the diff as a rename plus import updates; no file content changed apart from the
  one import inside `preview-provider.ts`.
- ADR-VSC-0004 names four of these modules by their old paths in its Consequences. It carries an
  amendment pointing here; the decision it records is untouched, since which folder a module sits
  in has no bearing on whether it can be loaded without a VS Code host.
- `preview/` is the natural home for anything else the panel grows, and `compiler/` for the
  managed-install work. That is the point: the next file has an obvious place, and if it does not,
  that is a signal worth noticing rather than a folder to widen.
- This does not make `preview-provider.ts` smaller. At 576 lines it is still panel lifecycle,
  compile orchestration and LSP symbol lookup at once, and it holds two of the five
  highest-complexity functions in the repository. That is a separate finding.
