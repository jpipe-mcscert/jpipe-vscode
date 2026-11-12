# ADR-VSC-0026: Runs use the Python VS Code uses

**Date:** 2026-11-11
**Status:** Accepted

## Context

The ▶ button runs a justification with jpipe-runner, which imports the checked step libraries
with the Python it runs on. Meanwhile, the editor analyses those same libraries with the
interpreter selected in VS Code — Pylance, the Python extension's language server, uses it to
resolve `from jpipe_runner import …` and to check every call of a step decorator.

The first version of the button searched for a runner on its own: the `jpipe.runner.command`
setting, then `.venv`/`venv` in the workspace folder, then `jpipe-runner` on `PATH`. In practice
that gave each workspace up to three Pythons that did not agree: a project managed by Pipenv keeps
its environment outside the folder, so the search skipped it and fell through to a Homebrew
install on `PATH`, while the editor analysed with yet another interpreter and flagged every
`jpipe_runner` import as unresolved. A warning that was true, about an environment nobody chose.

## Decision

A run uses the interpreter VS Code uses for the workspace folder and starts the runner as a module
of it: `<python> -m jpipe_runner`. When the Python extension is installed, that interpreter is the
one it has selected, read through its API; without it, the folder's `.venv`, else `python3`. The
extension is used as an optional companion: its API is reached through `vscode.extensions`, typed
structurally, and is not declared as a dependency. `jpipe.runner.command`, when set, still wins.

Before running — and once, when a workspace with step libraries opens — that interpreter is
probed: its version, whether it is a virtual environment, whether it can find `jpipe_runner`
(located, not imported). When it cannot run step libraries, the Libraries view says why and offers
the fix that fits the project, which runs only when the user accepts it, in a visible terminal:
install the runner into the selected environment; select the folder's own `.venv`; select the
environment Pipenv or Poetry manages; or, when there is none, create `.venv` with Python's own
`venv` module and install the runner into it. The environment is created with the selected Python
when it is recent enough, and otherwise with the first Python 3.11 or newer found on the machine —
a fresh folder on macOS selects `/usr/bin/python3`, which is 3.9, and an environment built from it
could never hold the runner. Declining is remembered for the workspace.

## Rationale

- **The editor and the run must agree.** A library Pylance accepts and the runner cannot import,
  or the reverse, is the most confusing failure this feature can have. One interpreter for both
  makes it impossible by construction, whatever manages the environment — venv, Pipenv, Poetry,
  conda — because that is the Python extension's job, and it already does it.
- **Searching ourselves cannot keep up.** Every environment manager keeps its environments
  somewhere else. The search covered the one layout the runner's README recommends and silently
  picked the wrong Python for the others.
- **An optional companion, not a dependency.** Declaring the Python extension as a dependency
  would install it for every jPipe user, including those who never run a model. Without it, runs
  fall back to the folder's `.venv` and `python3`, which is what a project set up as the runner
  recommends needs.
- **Point the editor at the runner's install instead** (`python.analysis.extraPaths`) was
  considered and kept out of the default. It silences the one import and nothing else a library
  needs, writes a machine-specific path that changes with every upgrade, and is wrong whenever the
  project has an environment of its own.
- **Nothing is installed or created unasked.** Creating an environment and installing from PyPI
  change the project and reach the network, so they happen on a click, in a terminal, and never
  on their own.

## Consequences

- The run depends on the Python extension's environment API when it is present. A change to that
  API would break interpreter selection; the fallback then applies and the status row says what
  the selected Python lacks.
- A Python with jpipe-runner installed globally is accepted: it runs. Only a Python that cannot
  run step libraries gets a fix offered.
- The probe runs an interpreter for a few milliseconds when the workspace opens and when the
  selected interpreter changes. It imports nothing from the project.
- `jpipe.runner.command` remains the escape hatch for an install neither VS Code nor the folder
  knows about.
