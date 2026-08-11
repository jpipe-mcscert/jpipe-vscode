# ADR-VSC-0001: ADR process and numbering

**Date:** 2026-08-10
**Status:** Accepted

## Context

This repository had no architecture decision records. Its structure carries several decisions
that are neither obvious from the code nor derivable from the git history — why the language
server is a separate package, why there are five TypeScript projects instead of two, why roughly
half the extension package has no tests, why the glob matcher is a hand-written port of a Java
class instead of a dependency. That reasoning lived in three places: the memory of the people who
made the decisions, scattered code comments, and `CLAUDE.md`. All three decay, and the last one
had already drifted far enough to describe a file that does not exist.

The sibling [jpipe-compiler](https://github.com/jpipe-mcscert/jpipe-compiler) has kept ADRs since
2026-03 under `docs/adr/`, numbered `NNNN-kebab-title.md`, with a settled
Context / Decision / Rationale / Consequences shape. Adopting a different format across two
repositories in one project would be a pointless divergence.

The one thing that could not simply be copied was the numbering. **The compiler's ADR numbers
are already cited from this repository's source, unqualified**, in five places: `jpipe-import.ts`
and `jpipe-scope.ts` cite "ADR 0012" for the qualified-id scheme, `glob-matcher.test.ts` and
`CLAUDE.md` cite "ADR-0022" for the glob semantics, and the diagnostic report schema cites
"ADR-0016" for the severity model. If this repository also numbered from 0001, every one of
those citations would become ambiguous — retroactively, in already-committed files.

## Decision

Architecture decisions for this repository are recorded one per file in `docs/adr/`, following
the compiler's Context / Decision / Rationale / Consequences template, and indexed in
`docs/adr/README.md`.

Records here are prefixed with `VSC`: files are `vsc-NNNN-kebab-title.md`, headings are
`# ADR-VSC-NNNN: …`, numbered from 0001. A four-digit number carrying the `VSC` prefix is always
a jpipe-vscode decision; a bare number is always a jpipe-compiler decision.

**When citing an ADR anywhere — code comment, test, prose — name the repository.** The prefix is
the safety net; naming the repository is the rule.

An ADR is never edited once accepted. It is corrected by appending a dated `## Amendment`
section, or superseded by a newer record.

## Rationale

- The five existing bare citations are the concrete problem. A prefix solves them without editing
  the compiler, without a lookup table, and without relying on everyone remembering a convention.
- Disjoint numeric blocks (compiler takes 0001–0099, this repo takes 0101+) were considered and
  rejected: they solve the same problem, but a reader has to *know* the block scheme to decode a
  number, whereas `VSC` is self-describing on sight.
- One file per decision, rather than a single `DECISIONS.md`, keeps each record's diff reviewable
  on its own and stops the file becoming something nobody opens.
- A markdown table in `README.md` is the index, rather than the compiler's `mkdocs.yml` nav. This
  repository has no mkdocs, and adding one for a dozen files would create a second thing to keep
  in step with the first.
- Matching the compiler's template costs nothing and means a contributor moving between the two
  repositories reads the same shape twice.

## Consequences

- A structural change should check whether an ADR governs it, and either follow it or supersede
  it. `CLAUDE.md` points here so that an agent reads this before making structural changes.
- The five pre-existing citations are rewritten to name `jpipe-compiler`. They are comment-only
  edits, made in the same change that introduced this record.
- Numbers are allocated in order and never reused, including for records that are later
  superseded or deprecated.
- Writing an ADR is now part of taking a structural decision, not a task for later. The cost is
  real: it is roughly an hour per record, and the batch that accompanies this one covers only the
  decisions already taken.
- This repository and the compiler must both keep the citation convention, or the ambiguity comes
  back from the other direction.
