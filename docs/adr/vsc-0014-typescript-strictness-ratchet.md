# ADR-VSC-0014: TypeScript strictness is a ratchet, and three notches were free

**Date:** 2026-08-11
**Status:** Accepted

## Context

The project has run with `strict: true` plus `noUnusedLocals`, `noImplicitReturns` and
`noImplicitOverride` since early on. Five further flags were available and none had been
considered: `noFallthroughCasesInSwitch`, `isolatedModules`, `verbatimModuleSyntax`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`.

The architecture audit of 2026-08-11 measured each one rather than arguing about it — running
`tsc --noEmit` per flag, per project — and the numbers did not match anyone's expectations:

| Flag | language | extension | webview | tests |
|---|---|---|---|---|
| `noFallthroughCasesInSwitch` | 0 | 0 | 0 | 0 |
| `isolatedModules` | 0 | 0 | 0 | 0 |
| `verbatimModuleSyntax` | 1 | 1 | 0 | — |
| `exactOptionalPropertyTypes` | 5 | 0 | — | — |
| `noUncheckedIndexedAccess` | 38 | 8 | — | — |

Two flags cost nothing at all. `exactOptionalPropertyTypes`, which had been assumed to be the
expensive one, costs five errors.

One of these is more than tidiness. The extension is bundled by esbuild, which transpiles file by
file with no view of the whole program: it decides what to erase by how a declaration *looks*. A
type re-exported as though it were a value therefore survives into the output as an import of a
binding that does not exist — a failure that appears only in the bundle, never in `tsc`, and so
first shows up as an extension that will not activate (jpipe-vscode ADR-VSC-0005).

## Decision

Strictness is treated as a **ratchet**: flags are turned on in cost order, each in its own change,
and none is ever turned back off to make an unrelated change easier.

Three notches are taken now, in the shared `tsconfig.json` so every project inherits them:

- **`noFallthroughCasesInSwitch`** — free.
- **`isolatedModules`** — free, and it is the flag that makes the file-by-file assumption esbuild
  already relies on into something the compiler checks.
- **`verbatimModuleSyntax`** — two one-word fixes, and the companion to the above: it requires
  `import type` / `export type` to be written where they are meant, which is what gives esbuild
  an unambiguous answer.

Two notches are **deferred, not declined**:

- **`exactOptionalPropertyTypes`** (5 errors) — next, and cheap enough that "next" should mean
  soon.
- **`noUncheckedIndexedAccess`** (46 errors) — the largest and the most valuable. Its errors are
  concentrated in index access after a length check the compiler cannot see, so most resolve into
  either a genuine guard or a destructure.

## Rationale

- Measuring first changed the order. `exactOptionalPropertyTypes` was expected to be the
  expensive one and is nearly free; the real cost sits in `noUncheckedIndexedAccess`, which is
  also where the real bugs would be.
- One flag per change keeps the diff attributable. Enabling all five at once would put 46
  mechanical edits next to the two that matter and make the review worthless.
- `isolatedModules` and `verbatimModuleSyntax` are taken together deliberately: the first states
  the constraint, the second is how the code satisfies it legibly. Splitting them would leave a
  gap where the constraint is declared and the syntax that honours it is not required.
- Verified rather than assumed: with these on, re-exporting a type as a value now fails at
  compile time with `TS1205`, where before it compiled and would have broken only in the bundle.
- Doing nothing was the alternative. It was rejected because two of these cost literally nothing
  and one of them closes a failure mode that reaches users rather than the build.

## Consequences

- **Type-only imports must now be written as such.** `import { type Foo }` or
  `import type { Foo }`; a plain import of a type is an error. This is the one visible change to
  everyday work, and the compiler names the fix in the message.
- The generated Langium sources satisfy all three, which is not something this project controls —
  `langium-cli` output is regenerated on every build (jpipe-vscode ADR-VSC-0006), so a future
  generator that emitted non-conforming code would break the build rather than degrade quietly.
  That is the correct failure direction, but it is a coupling worth remembering.
- The remaining two flags are now a known, sized backlog rather than an open question. A future
  change should take `exactOptionalPropertyTypes` before adding anything new.
- A flag is never removed to unblock a change. If one genuinely has to come off, that supersedes
  this record and should say why.
