# ADR-VSC-0006: Generated Langium code is not committed

**Date:** 2026-08-10
**Status:** Accepted

## Context

`packages/language/src/jpipe.langium` is the source of truth for the jPipe grammar. From it,
`langium-cli` generates the typed AST interfaces and type guards (`ast.ts`), the serialised
grammar (`grammar.ts`), the generated DI module (`module.ts`), and a TextMate grammar for syntax
highlighting.

`langium-config.json` writes the TypeScript output to `src/generated` — **inside the source
tree**, not into a build directory — because the hand-written services import it with ordinary
relative specifiers (`./generated/ast.js`). That placement is Langium's convention and is not
practically changeable.

The question is whether those ~1,850 lines are committed. Generated code inside `src/` looks like
source to every tool that walks `src/`, and looks like source to a reviewer reading a diff.

## Decision

`**/src/generated` and `syntaxes/` are git-ignored. The generated artefacts are produced by
`npm run langium:generate`, which every CI job runs before building, and are never edited by
hand.

The TextMate grammar is generated to `packages/language/syntaxes/` and copied into
`packages/extension/syntaxes/` by the extension's `build:prepare` script. Both locations are
ignored.

## Rationale

- A committed generated file invites a hand edit, and a hand edit to generated code survives
  exactly until the next `langium:generate` — silently, taking whatever behaviour depended on it.
- Grammar changes would otherwise produce diffs where a five-line grammar edit is buried under
  1,800 lines of regenerated output, which makes the real change unreviewable.
- The generator is pinned (`langium-cli ~4.3.0`) and its input is committed, so the output is
  reproducible. There is no information in the artefacts that is not in `jpipe.langium`.
- Committing them would remove the "run `langium:generate` first" step for a fresh clone. That is
  a real cost, and it is paid instead by making it the first step of every documented build path
  and every CI job.

## Consequences

- **A fresh clone does not type-check until `npm run langium:generate` has run.** It is the first
  command in the README's build section, in `CLAUDE.md`, and in every CI workflow.
- Editing `jpipe.langium` requires re-running the generator before the change has any effect.
- Any tool that scopes itself to `packages/language/src` sees generated code and must exclude it
  explicitly. Issues raised against it are unactionable by construction, and its size would
  dominate any metric computed over the package. `sonar-project.properties` excludes
  `packages/language/src/generated/**` for this reason, and so does the Vitest coverage config.
- The build order is load-bearing and appears in three places — the two workflows and
  `scripts/release.sh check_build`. `clean → langium:generate → build → test` must stay in that
  order in all of them.
- `git status` on a built tree is clean, which matters more than it sounds: `release.sh` refuses
  to run on a dirty tree, and untracked build products would block every release.
