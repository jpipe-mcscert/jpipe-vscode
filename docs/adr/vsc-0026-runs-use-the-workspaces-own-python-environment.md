# ADR-VSC-0026: Runs use the workspace's own Python environment

**Date:** 2026-11-11
**Status:** Accepted

## Context

The ▶ button runs a justification with jpipe-runner, which imports the checked step libraries
with the Python it runs on. Meanwhile, the editor analyses those same libraries with the
interpreter selected in VS Code — Pylance, the Python extension's language server, uses it to
resolve `from jpipe_runner import …` and to check every call of a step decorator.

Two sources of "the right Python" are at hand, and neither can be trusted on its own:

- **The interpreter selected in VS Code.** For a folder with no environment of its own, the
  Python extension picks one anyway, and it may be another project's: a Pipenv environment kept
  in the user's home, belonging to a different checkout. Installing into it, or upgrading a
  package in it, breaks that other project behind its lock file.
- **The process environment.** VS Code started from a shell with a virtual environment activated
  passes `VIRTUAL_ENV` and that environment's `bin` on `PATH` to every window. `python3` is then
  that environment's, and Pipenv and Poetry, finding `VIRTUAL_ENV` set, report and install into it
  instead of the project's own.

What a workspace can vouch for is what is in its folder.

## Decision

**A workspace runs its step libraries with an environment that is its own, and the editor is
pointed at that same environment.** An environment is the workspace's own when it is:

1. the one the project's manager keeps for the folder — Pipenv, Poetry or uv, read from a
   `Pipfile`, a lock file, or the tool's table in `pyproject.toml`, and asked where its
   environment is (`pipenv --venv`, `poetry env info --path`; uv's is the folder's `.venv`); or
2. a virtual environment at the folder's root: `.venv`, `venv`, `env` or `.env`.

Nothing else qualifies: not the interpreter selected in VS Code, not `PATH`. An environment
belonging to another project is never run with and never modified. Pipenv notes in each
environment which project it was made for, and one naming another folder is refused.

Every program started to look at or change the environment — the probe, the managers, pip, the
search for a base Python — runs with the inherited activation removed (`VIRTUAL_ENV` and its
`PATH` entry). A run starts the runner as `<python> -m jpipe_runner` with the workspace's
environment activated in its place.

A VS Code task cannot do that removal: its environment is laid over VS Code's own, so a variable
can be replaced but not taken out. The steps of a fix are therefore started by the extension
itself, with exactly the environment above, and a task only lends them its terminal
(`runner/step-terminal.ts`). A run stays a task, because activation replaces `VIRTUAL_ENV` and
`PATH`; what is left over from the inherited activation is given an empty value, which Python
reads as unset.

The environment is looked at one check at a time, in the order the checks were asked for, so the
status acted on is never that of an older, slower check.

**The choices are settings, in a Runner group shaped like the compiler's** (ADR-VSC-0028). A mode,
`jpipe.runner.environment`, is `workspace` by default; `command` runs the program named in
`jpipe.runner.command` instead, and then no environment is looked at, created or changed. Two
switches make the unprompted behaviours visible and reversible: `jpipe.runner.selectInEditor`
(pointing the editor at the environment) and `jpipe.runner.offerSetup` (volunteering a fix). The
mode's description links the two commands that act: **Set Up the Python Environment for Runs** and
**Check the Python Environment for Runs**, which reports the environment found, its Python and
jpipe-runner, the editor's interpreter and the machine's runner. Consent, the ownership rule and
the minimum release are not settings.

**The editor follows.** With the Python extension installed, the workspace's environment is
selected as the folder's interpreter, without asking, once per environment — through the Python
Environments extension's API where that is installed, since it then decides a folder's
environment from the manager recorded in the folder's settings and a selection made through the
Python extension's older API does not last, and through the Python extension's otherwise. The
selection is read back, not assumed: an interpreter the user picks afterwards is left alone, a run still uses the
workspace's, and the Libraries view offers to point the editor back. Both extensions are optional
companions: their API is reached through `vscode.extensions`, typed structurally, and is not declared
as a dependency. Without them, runs work the same and the editor is the user's to configure.

**When the environment cannot run step libraries**, the Libraries view says why and offers one fix:

- **No environment, no manager.** `.venv` is created with Python's own `venv` module and
  nicknamed `jpipe-<folder>` (`--prompt`), which is what a terminal and VS Code's environment
  lists show it as: a user who had no environment did not set Python up, and the name tells them
  where this one came from and which workspace it is for; the runner
  installed with its pip, and the dependency recorded in the project's requirements file, or a new
  `requirements.txt`. Only Python is needed. The base Python is the first install of 3.11 or
  newer among the one selected in VS Code, `python3`, and the versioned names; a virtual
  environment is never built on.
- **A manager, with or without an environment yet.** The tool adds jpipe-runner as a development
  dependency (`pipenv install --dev`, `poetry add --group dev`, `uv add --dev`), which records it
  and installs it, creating the environment if need be.
- **An environment in the folder without the runner.** It is installed with that environment's
  pip, and recorded in the requirements file the project already has, if any.
- **An environment whose Python is older than 3.11** is reported, not rebuilt: it is the user's.

Step libraries are written against jpipe-runner 4.0.0 and newer — `from jpipe_runner import
evidence, strategy` — so an older release counts as none, and the same fix upgrades it.

**A jpipe-runner installed on the machine is matched, not used.** One installed with Homebrew,
apt or pipx is asked its release (`jpipe-runner --version`), and when that is 4.0.0 or newer pip
installs exactly it into the workspace's environment; otherwise it installs the latest. What a
project file records is always `jpipe-runner>=4.0.0` — in a requirements file, and in what a
manager is asked to add: any release from the minimum on works, and a project is not pinned to
what one machine happened to have. A run never goes through the machine's runner. An environment whose interpreter does not answer is no
environment, and the same fixes rebuild it.

**A local jpipe-runner can stand in for a release**, for work on the runner itself.
`jpipe.runner.localSource` names a checkout; the workspace's environment is then expected to run
it, installed editable (`pip install -e`), so a change to the runner shows in the next run. What
the environment runs is read from what pip records of the install, not guessed from a version.
The fix installs the checkout — into a managed project's environment too, with pip, since the
project's files must not name a path on one machine — and, once the setting is cleared, removes
it and installs a published release. The minimum release and the match with the machine's runner
do not apply to a checkout. No project file ever records it, and the Libraries view is marked
"local jpipe-runner" while runs use one.
An editable install runs the checkout's code as it stands, but the environment keeps what it wrote
down at install time: the version, the dependencies, the commands. When the version the checkout
declares in its `pyproject.toml` is no longer the one the environment recorded, the environment is
reported as needing the local copy installed again, and that is the fix offered. Runs are not
held back meanwhile: the code they use is current.

**Nothing is changed without consent.** Before a fix creates an environment, installs a package
or rewrites a project file, a dialog states exactly that — which files change, in a few plain lines,
without versions or commands — and nothing happens unless it is accepted. The fix then runs in a visible terminal, which shows what the programs print; closing it stops them.

The fix is volunteered once per workspace, when it has a step library or gets its first one, and
declining is remembered. Two things are not silenced by that, because they are asked for:
**Set Up the Python Environment for Runs**, in the Libraries view's toolbar and the palette, which
looks again and proposes the fix, or notes in the status bar that the workspace is ready —
with a notification offering to refresh the editor only if it still flags the import; and the editor flagging a `jpipe_runner` import, which is answered once
per window when there is something to fix — an editor merely catching up with an environment
that is in order gets no notification — and carries the same action as a quick fix on the
flagged line.

## Rationale

- **Ownership is the only safe test.** "Is it a virtual environment?" and "is it selected?" are
  both true of another project's environment. What separates the workspace's from a stranger's is
  where it is and who made it, and both can be read from the folder.
- **The editor and the run must agree, and the run decides.** A library Pylance accepts and the
  runner cannot import, or the reverse, is the most confusing failure this feature can have.
  Following the editor's selection made them agree on whatever had been selected, right or wrong.
  Selecting the workspace's environment for the editor makes them agree on the right one.
- **Seamless, but not insistent.** A user opening a project should not have to know that an
  interpreter needs selecting. One who then selects another has said something, and is not
  overridden each time the window opens.
- **Consent is for the project's files.** A `Pipfile`, a `pyproject.toml`, a requirements file
  are the user's, shared with colleagues and CI. A fix that rewrites one is the right fix — the
  change is the record — and exactly the kind of change to be agreed to in so many words.
- **The project's own tool installs, when there is one.** Installing with pip into an environment
  Pipenv, Poetry or uv manages puts the runner on one machine and out of step with the lock file.
  When the tool is missing or refuses, the user is told and nothing is installed behind its back.
- **With nothing there, nothing but Python.** A workspace with no Python arrangement gets the
  one every Python install can provide: `venv`, pip, a requirements file. Choosing a manager for
  a project is not this extension's call.
- **The machine's runner cannot run a project, but it says which release to have.** It lives in
  an environment of its own, where the project's packages cannot be imported and which the editor
  does not analyse with, so running with it would work only for libraries that import nothing.
  It is, though, the release the user chose and the one a terminal runs: giving the workspace the
  same one makes the ▶ button and the command line behave alike.
- **Settings hold choices; commands act; dialogs ask.** The compiler's panel already works this
  way, and a user who has configured one should recognise the other. A setting that pre-approved
  changes to project files would turn consent into a preference, so there is none.
- **Inherited activation is an accident, not a choice.** It reflects the shell VS Code happened
  to be started from, applies to every window alike, and silently redirects the tools that honour
  it. Removing it is what makes "the manager's environment for this folder" mean that.
- **The Python extension as an optional companion.** Declaring it as a dependency would install it
  for every jPipe user, including those who never run a model.
- **The warning is where the user is looking.** An unresolved `jpipe_runner` import shows in the
  Python file, not in the Libraries view. Reading the editor's diagnostics — any checker's, by
  their wording — and putting the fix on that line meets the problem where it is seen.
- **"Installed" is not "usable".** An environment holding jpipe-runner 3.x passes a check that
  only asks whether the package is there, while the editor flags every import a library makes.

## Consequences

- A Python with jpipe-runner installed globally, or selected by hand from elsewhere, no longer
  counts: a workspace without its own environment is offered one. The `command` mode is the
  deliberate use of some other install; there is no running "anyway" with whatever is on `PATH`.
- Selecting the environment writes to the workspace's VS Code settings: that is how the Python
  extensions store the choice, down to which manager the folder's environment comes from.
- Accepting a fix can change the project's files — the manager's dependency and lock files, or a
  requirements file — as the dialog says before it does.
- With a local jpipe-runner, a run reflects the checkout but the Libraries view and the Outline do
  not: they find steps and bind them with this extension's own reading of the runner's rules
  (ADR-VSC-0025), so a checkout that changes its decorators or its binding is ahead of them.
- conda environments, and virtual environments at the root under other names or kept in a
  subfolder, are not recognised as the workspace's.
- The environment is the first workspace folder's. A multi-root workspace has one, not one per
  folder.
- Looking at the workspace runs its manager and its interpreter briefly when the window opens and
  when the selected interpreter changes. Nothing is imported from the project.
- The selection depends on the Python extension's environment API. Should it change, runs are
  unaffected and the editor is no longer pointed at the environment.
