# ADR-VSC-0025: Step libraries are found by reading them, never by importing them

**Date:** 2026-11-11
**Status:** Accepted

## Context

The jPipe activity lists the workspace's **step libraries**: the Python files whose functions
implement a justification's elements for jpipe-runner, through its `@evidence`, `@strategy`,
`@sub_conclusion` and `@conclusion` decorators. The user checks the ones a run should load, and the
list feeds two things: the arguments of the ▶ Run button (one `--library` per checked file) and the
Outline, which shows which function implements each element.

Building that list means deciding, for every Python file in the workspace, whether it is a step
library, and which element ids its steps name. It has to be done again whenever a Python file
changes, because a library gains and loses steps as it is written. Three ways of deciding were on
the table:

- **Import each file and ask the runner** what it registered. Exact, since it is what a run does.
- **Parse each file with Python's own `ast` module**, through a helper script. Exact about syntax,
  and executes nothing in the file.
- **Read the text in TypeScript**: a small tokenizer that knows where strings and comments are,
  and a scan for the decorators as jpipe-runner's authoring guide shows them being imported and
  applied.

## Decision

Step libraries are found by reading their text in the extension host (`runner/library-scan.ts`).
No Python file is imported, executed or handed to an interpreter to be listed. A file is a step
library when it applies a step decorator bound by an import from `jpipe_runner` —
`from jpipe_runner import evidence [as alias]`, a star import, or `import jpipe_runner [as alias]`
followed by `@alias.evidence(…)` — or when it imports a step decorator by name without applying it
yet, which is what a library just created looks like. Importing only `Pass` and `Fail`, or the
module alone, makes a helper, not a library. Element ids are the decorator's positional string
literals.

## Rationale

- **Importing runs code nobody asked to run.** Importing a module executes its top-level code,
  which jpipe-runner's own documentation warns about. Doing that to every Python file of a
  workspace, on every save, in order to *list* them, would run arbitrary project code as a side
  effect of opening a folder. A run imports the checked libraries, because the user asked for a
  run; a listing must not.
- **`ast` needs an interpreter for a question that does not.** Python's parser is exact, but it
  needs a Python on hand, a process launch per refresh, and a choice of which interpreter, before
  the view can show anything. The decorators are a narrow, documented surface that a tokenizer
  recognises reliably; the scan's tests port the import and decorator forms the runner documents,
  and the forms that must *not* count — decorators inside comments, docstrings and strings, a
  same-named decorator from another package, a submodule bound under its own name.
- **Reading the text is instant and always available.** The list is right when the activity opens,
  updates as files are saved, and works in a workspace whose Python environment is not set up yet.

## Consequences

- A decorator reached in a way the scan does not follow — re-exported through another module of
  the project, or applied through a variable — is not seen, and that library is not listed. The
  runner would load it. The error is always an omission, never a file listed that is not a library,
  and the remedy is to import the decorators from `jpipe_runner` directly, as the runner's guide
  does.
- An element id computed at run time (a constant, an f-string) cannot be read, so the Outline does
  not know that step implements its element. The run is unaffected: the runner binds what it
  imports.
- The Outline's "implemented by" is an indication computed with the runner's binding rules
  (jpipe-runner's ADR-0007) over the elements the model declares itself. The runner, which has the
  compiled model with inherited elements and aliases, remains the authority on what binds.
- Virtual environments and tool caches are never scanned. Without that, jpipe-runner's own package,
  which defines the decorators, would be listed as a library.
