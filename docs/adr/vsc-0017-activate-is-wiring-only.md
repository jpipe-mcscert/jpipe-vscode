# ADR-VSC-0017: `activate()` wires collaborators and nothing else

**Date:** 2026-08-11
**Status:** Accepted

## Context

`activate()` had grown to 264 lines — the longest function in the repository — doing three
separable jobs at once: constructing collaborators, wiring event subscriptions, and registering
twenty commands. Inside it sat six nested function declarations, each closing over exactly one
collaborator: `installFromRelease` over `releaseManager`, `excludeResource` and
`resolveExclusionTarget` over `exclusions`, `resolveExportContext` over `previewProvider`. Each
was a method written outside the object it belonged to.

Nothing in the file was covered, and nothing in it could be: it imports `vscode` and runs only
inside an extension host (jpipe-vscode ADR-VSC-0004). So the cost was not correctness in the
usual sense. It was that the single place describing what the extension *is* had become the
place least amenable to reading — and that command registration, the part that grows with every
feature, was buried in the middle of it.

## Decision

`activate()` constructs collaborators, wires subscriptions, and delegates. It is 75 lines.

- **`commands.ts`** — `registerCommands(deps)`, every contributed command, as a table.
- **`exclusion-commands.ts`** — the four exclusion flows and their failure messages.
- **`compiler/managed-install.ts`** — the release picker and download flow.
- **`compiler/release-presentation.ts`** — the text those flows show. **No `vscode` import**, so
  unlike everything else here it is tested.
- **`resolveExportContext`** moved onto `PreviewProvider`, whose state it reads.

Handlers in `commands.ts` stay thin deliberately: anything with a decision in it belongs to the
module that owns the concern, so that file reads as a list of what the extension offers.

## The bug this refactor nearly introduced

Registering the seven export commands as `` `jpipe.download${format}` `` is the obvious move and
is wrong. `ImageFormat.PYTHON` is `'PYTHON'`; the contributed command is `jpipe.downloadPython`.
The template would have registered a handler nothing declares and left the declared command with
nothing behind it — "Download as Python" present in the menu, silently doing nothing.

Neither the compiler nor the suite could have caught it. The two halves are a JSON string in
`package.json` and a TypeScript string in a file no test can load; they never meet.

So the commands are written out in a table, and `test/commands.test.ts` compares the manifest
against the registrations in both directions: a declared command with no handler, and a handler
with no contribution. It reads the source as text, the same technique and for the same reason as
`preview-shell.test.ts`.

## Rationale

- Extraction here buys reviewability, not coverage — every extracted module still imports
  `vscode`. Worth being explicit about, because "we split it up" can be mistaken for "we made it
  testable", and only `release-presentation.ts` was.
- `release-presentation.ts` earns its separation on exactly that basis: labels and headers are
  decisions about text, they were only untestable through proximity to a quick pick, and they now
  have 15 tests.
- It uses a **type-only** `vscode` import for `QuickPickItem`. That erases at compile time, so
  the module stays loadable outside a host — the boundary is a runtime one, and a type reference
  does not cross it.
- Moving `resolveExportContext` onto `PreviewProvider` rather than into a module: it reads that
  object's own state through two getters that exist only for it.
- A `commands.ts` per feature area was considered and rejected. Twenty commands is a readable
  table; splitting it would scatter the answer to "what does this extension do".

## Consequences

- **Three new modules are coverage-excluded**, in both `vitest.config.ts` and
  `sonar-project.properties`. This is the exclusion list growing for a good reason — the code was
  already unloadable inside `activate()` — but it is growing, and each entry needs the same
  justification as the rest (jpipe-vscode ADR-VSC-0010).
- The command surface now has a test where it had none. It cannot verify a command *works*, only
  that both halves of its declaration exist; that is the part which was silently breakable.
- `main.ts` is 162 lines from 362. `preview-provider.ts` gained `resolveExportContext` and is
  **not** smaller — it remains 576 lines carrying panel lifecycle, compile orchestration and
  symbol lookup, with two of the five highest-complexity functions in the repository. That half
  of F-03 is untouched and still open.
- Adding a command now means two edits in two files that a test checks against each other, rather
  than one edit in a 264-line function that nothing checks.
