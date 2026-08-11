# Architecture Decision Records

Decisions about how this repository is built, one file each, in the order they were taken.

An ADR is written when a choice had alternatives worth naming and a cost worth remembering —
not for every change. Most of the records here are *retroactive*: the decision was taken long
before it was written down, and the point of writing it down is that the next reader inherits
the reasoning instead of re-deriving it, or worse, quietly undoing it.

An ADR is never edited once accepted. Correct it by appending a dated `## Amendment` section, or
supersede it with a new one and set the old status to `Superseded by ADR-VSC-NNNN`.

Start from [TEMPLATE.md](TEMPLATE.md).

## Numbering, and why there is a prefix

jPipe ADRs live in two repositories. The compiler numbers its own from `0001`, and **its numbers
are already cited from this repository's source** — the `load` glob semantics come from
jpipe-compiler ADR-0022, the qualified-id scheme from jpipe-compiler ADR-0012, the diagnostic
severity model from jpipe-compiler ADR-0016. A bare `ADR-0012` in a comment here would be
ambiguous the moment this repository had a twelfth decision of its own.

So records here are prefixed: files are `vsc-NNNN-kebab-title.md` and headings are
`# ADR-VSC-NNNN: …`, numbered from 0001. A `VSC` is always this repository; a bare number is
always the compiler.

**When citing an ADR, name the repository** — `see jpipe-compiler ADR-0022`,
`see jpipe-vscode ADR-VSC-0007`. The prefix is the safety net; naming the repository is the rule.

The compiler's records are at
[jpipe-compiler/docs/adr](https://github.com/jpipe-mcscert/jpipe-compiler/tree/main/docs/adr).

## Index

| # | Decision | Date | Status |
|---|---|---|---|
| [VSC-0001](vsc-0001-adr-process-and-numbering.md) | ADR process and numbering | 2026-08-10 | Accepted |
| [VSC-0002](vsc-0002-two-package-npm-workspace.md) | Two packages in one npm workspace | 2026-08-10 | Accepted |
| [VSC-0003](vsc-0003-dom-free-host-via-separate-tsconfig-projects.md) | A DOM-free host, enforced by separate tsconfig projects | 2026-08-10 | Accepted |
| [VSC-0004](vsc-0004-vscode-free-testability-seam.md) | Testability through a `vscode`-free seam, not API mocks | 2026-08-10 | Accepted |
| [VSC-0005](vsc-0005-dual-esbuild-bundles.md) | Two esbuild bundles: CJS host, IIFE webview | 2026-08-10 | Accepted |
| [VSC-0006](vsc-0006-generated-langium-code-is-not-committed.md) | Generated Langium code is not committed | 2026-08-10 | Accepted |
| [VSC-0007](vsc-0007-java-nio-glob-fidelity.md) | `load` globs follow Java NIO, for fidelity with the compiler | 2026-08-10 | Accepted |
| [VSC-0008](vsc-0008-four-place-version-and-scripted-release.md) | A four-place version, moved only by the release script | 2026-08-10 | Accepted |
