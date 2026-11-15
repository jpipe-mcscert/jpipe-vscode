# ADR-VSC-0029: A run is read from the runner's JSON report, and listed, not drawn as a tree

**Date:** 2026-11-14
**Status:** Accepted

## Context

The ▶ button runs a justification with jpipe-runner. The runner prints a text report for people,
whose layout may change in any release, and can also write a **JSON report**: a versioned contract
(jpipe-runner ADR-0011) that says, for every element, how it ended, why, which step judged it, the
files it observed and the values it produced, and for every problem its code, its fix and a
structured traceback. It writes one whole report when the run ends; there is no stream of steps.

The extension should show a run's outcome in the editor's own terms — rows to click, files to
open — rather than as text in a terminal. That raises three questions: how the report reaches the
extension, where it is shown, and in what shape.

The shape is the hard one. A justification is a graph, not a tree: one evidence may support
several strategies, and one sub-conclusion several strategies above it. A tree that nests each
element under what it supports repeats a shared element once per parent, and a shared evidence
that fails then reads as several failures.

## Decision

- **The runner writes its report to a file** (`--report PATH`), in the extension's storage for the
  workspace, beside the compiled model, in a folder that run alone uses and that is removed once
  the report is read: two runs under way at once never read each other's files. The extension
  never reads the runner's standard output.
- **The run stays a VS Code task**, whose terminal is no longer brought forward. It is where the
  steps print, and Show the Run's Output reaches it. It is brought forward only when a run ends
  without a report, which the runner documents as a usage error or a file it could not read.
- **The report is shown in a Results view in the bottom panel**, a native tree view, which appears
  with the first run that has a report.
- **Its rows are a list by outcome, not the argument**: the verdict, then Failed, Skipped, Passed
  and Not run, each element exactly once, in the report's own order. An element's row says what
  stopped it; under it are its problems with their fix and traceback, its step, the files it
  observed, what it consumed and produced, and what it supports. "Supports" and "stopped it" rows
  lead to that element's row. Problems about no listed element — a refused model — stand in a group
  of their own.
- **A check is a run that calls no step** (`--dry-run`), and is shown the same way. When no step was
  called — a check, or a run stopped before it began — no element has an outcome, and elements are
  grouped by whether a problem is about them: With problems, then No problem. The view says beside
  the model's name whether it shows a run or a check.
- **A checked library's own ▶ menu offers both**, Run as jPipe and Check as jPipe Library, after
  the Python extension's entries. They are shortcuts: they act on the justification selected in the
  Models view, with every checked library, and ask for one to be selected when none is.
- **The report is read as its contract says**: major version 1, unknown fields ignored, missing
  ones empty. Another major version is not shown, and the terminal is brought forward instead.
- **Rows are decided in `runner/run-report.ts`**, which has no VS Code in it and is tested against
  the runner's documented examples; `runner/results-view.ts` only displays them.

## Rationale

- **A file, as for the compiler.** Standard output belongs to whoever prints: a step that prints
  would end up inside a report read from it (`--json`). With `--report` the text report still
  reaches the terminal, so nothing the user had is lost.
- **A task, because a run is a build-like action**: it has a terminal for what steps print, can be
  stopped from it, and behaves as it would in CI.
- **A list, because each element has one outcome.** Grouping by outcome puts the failure a run is
  opened for at the top, and the report already names the root cause of every skipped element, so
  the relation that matters when reading a failure is stated on the row without nesting.
- **The argument's shape belongs to a diagram**, where a shared element is one node with several
  arrows. The preview draws diagrams already.
- **A tree view, not a webview**: it looks and behaves like the Models, Outline and Libraries
  views, every row is clickable without a message protocol, and it needs no second browser bundle
  (ADR-VSC-0005).
- **A library is run through a model**, since the runner runs justifications. The selected model
  is the one the Outline is showing this library's steps against, so it is the one a run from the
  library is expected to be about; loading only that library would mostly report missing steps.
- **Not the Test Explorer.** An element is not a test: the Test Explorer has no place for an
  element stopped by another, for observed files, or for produced values.

## Consequences

- The Results view shows the last run only, and nothing while a run is under way: the report
  arrives whole.
- A step's row opens its function through the libraries the Libraries view found. The report names
  a step `module.function`, so two libraries with the same file name and function name cannot be
  told apart, and the first is opened.
- An element's row does not open the element in its `.jd` file.
- The view and its click handling need the editor, so they are checked by hand (ADR-VSC-0004).
- A runner that does not know `--report` ends with a usage error, shown in the terminal. Every
  runner this extension accepts (4.0.0 and newer, ADR-VSC-0026) knows it.
