# ADR-VSC-0015: Thrown values are narrowed, never widened to `any`

**Date:** 2026-08-11
**Status:** Accepted

## Context

The architecture audit found ten `catch (e: any)` blocks, nine of them in `image-generator.ts`
and one in `preview-provider.ts`. `strict` is on, which implies `useUnknownInCatchVariables`, so
each of those was an explicit opt-out of a check the project had already enabled.

The opt-out is broader than it looks. `any` disables checking of everything reached through it,
so alongside the intended `e.stdout` these blocks would equally have accepted `e.mesage`, or a
field that no error in this codebase ever carries, and said nothing.

At the same time fifteen sites wrote the same narrowing out longhand —
`err instanceof Error ? err.message : String(err)` — four times in `main.ts` alone, and two
files carried an identical five-line three-branch block. There was no shared helper anywhere:
grepping for `errorMessage|messageOf|toMessage` returned nothing.

The reason `any` had been reached for was real rather than lazy. These catches do not only read
`.message`: they read `.stdout`, `.stderr`, `.exitCode`, `.code` and `.cancelled` off failures
thrown by a child process. `unknown` alone does not permit that, and each site had to either
narrow properly or opt out. They opted out.

## Decision

A `catch` binding is `unknown`. Reading anything off it goes through
`packages/extension/src/shared/errors.ts`:

- **`messageOf(err)`** — the message, by the rule the fifteen sites already used.
- **`displayMessageOf(err)`** — for text shown to a user, ending at `'[unknown error]'` rather
  than `String(err)`.
- **`asProcessFailure(err)`** — a thrown value viewed as a failed subprocess: `stdout`, `stderr`,
  `exitCode`, `cancelled`, each present only when it carries the expected type.
- **`detailOf(err)`** — the most specific text a failure offers: stderr, else stdout, else the
  message.

The language package keeps its own three-line `messageOf` in `jpipe-errors.ts`.

## Why two `messageOf` functions rather than one

The packages are separately distributable (jpipe-vscode ADR-VSC-0002) and neither may import the
other's internals. Sharing this would mean exporting an error utility from `jpipe-language`'s
public API, which would misdescribe what that API is for, to save three lines. The extension's
copy carries the subprocess helpers as well, because it is the side that runs the compiler; the
language package's narrows messages and nothing else, because that is all it throws.

This is a real cost and it is chosen with the alternative in view: a second copy that could drift
is worse than one that cannot, but better than a public API that lies.

## Rationale

- `messageOf` and `displayMessageOf` are kept apart because both rules already existed and they
  differ in the last branch. Collapsing them would have changed what users see in notifications
  from `'[unknown error]'` to `"[object Object]"`, in files with no automated coverage.
- `asProcessFailure` returns a value with everything absent for inputs that are not process
  failures, rather than throwing or asserting, so a caller never has to check before calling.
- The `exitCode` fallback to a numeric `code` exists because the two spellings arrive from
  different layers: `execFile` rejects with `code`, while `image-generator` re-throws a
  synthesised error carrying `exitCode`. A non-numeric `code` such as `'ENOENT'` is a spawn
  failure, not an exit status, and is deliberately excluded — reporting it as one would tell a
  user their model failed to compile when the compiler never started.
- A `NodeExecError` type guard returning a discriminated union was considered. It reads better in
  isolation but forces every call site into a conditional even where the answer is "fields
  absent, carry on", which is most of them.

## Consequences

- **`errors.ts` is testable although none of its callers are.** It imports neither `vscode` nor
  the DOM, so it sits on the tested side of the seam (jpipe-vscode ADR-VSC-0004) — 26 cases
  covering the two error shapes those files actually see. That is the first coverage any of this
  error handling has had.
- The conversion is behaviour-preserving by construction, and the tests pin the parts where that
  claim is not obvious: which of `exitCode` and `code` wins, and that `'ENOENT'` is not an exit
  code.
- Five `: any` remain in the two packages, none of them a `catch`: three parameter types
  (`filterFn`, `cancelToken`, a GitHub `assets` array) that are about typing an external shape,
  not about errors. They are out of scope here and worth their own pass.
- A new `catch` that needs a field not covered by `ProcessFailure` should add it there rather
  than widening locally. The point of this record is that the widening was the thing worth
  removing, not the verbosity.
