# ADR-VSC-0036: The runner is a release chosen from PyPI, or a development copy

**Date:** 2026-11-25
**Status:** Accepted

## Context

Runs use the workspace's own Python environment (ADR-VSC-0026), and the release of jpipe-runner it
gets was decided for the user: the one installed on the machine when there is one, else the newest.
Nothing let a user say which release a workspace runs, short of installing it by hand, although the
compiler has had a release picker since its managed mode.

Work on jpipe-runner itself was one setting: naming a local checkout ran it, installed editable.
There was no switch to go back to a release without forgetting the path, and a run did not say it
used a checkout, so its results could be taken for a release's. Comparing a branch with the working
copy meant switching the checkout.

The runner's settings were split across General and Execution by a line users did not see (the
libraries and the editor in one, the program and the jobs in the other), while the offers jPipe
makes, to set the environment up or to install Pylance, sat among them.

## Decision

**Three groups for the runner** (ADR-VSC-0028):

| Group | Holds |
|---|---|
| `jPipe › Runner › General` | how runs reach jpipe-runner (workspace or command), the release, the command, steps at a time, the step libraries |
| `jPipe › Runner › Assistance` | what jPipe offers to do: suggest the set-up and Pylance, point the editor at the environment |
| `jPipe › Runner › Development` | development mode, the local copy, and its branch |

Each links to what acts on it: the release to its picker, the environment and the assistance to
**Set Up** and **Check the Python Environment**.

**A release is chosen from those PyPI lists.** `jpipe.runner.version` names one, or is empty for any
from the minimum on (ADR-VSC-0032), which keeps the behaviour of ADR-VSC-0026. **Choose jpipe-runner
Release…**, linked from the setting, lists the final releases PyPI has from the minimum on, newest
first, with their dates and what the first release of each feature brings; it writes the setting
for the workspace, then Set Up looks again and offers the fix, with its consent dialog. The list is
asked of `https://pypi.org/pypi/jpipe-runner/json` only: the JSON request takes the hosts it may reach
as a parameter, and PyPI is not added to the compiler's GitHub allowlist.

A chosen release is installed exactly. An environment with another is reported (`other-release`),
not run, and the fix installs the chosen one: with pip, or through the project's Pipenv, Poetry or
uv, which records it, since a managed environment is what its lock file says. A pip project's
requirements file still records the minimum (ADR-VSC-0026). A value that is not a final release
from the minimum on is ignored, and the log says so.

**Development mode is a switch**, `jpipe.runner.developmentMode`. On, runs use the local copy named
by `jpipe.runner.localSource`, and the chosen release is set aside; off, the copy is ignored, and an
environment still running one is offered a release back. Settings written before the switch existed
are given it once, where a copy is named, so that nobody working on the runner loses it.

**A branch is installed from its commits.** `jpipe.runner.localBranch` names a local branch of the
copy. Without one, the copy is installed editable, as before. With one, pip installs
`git+file://<copy>@<branch>`, which builds the branch's last commit and records it; the checkout's
files, uncommitted changes included, are neither used nor touched. Each check asks git which commit
the branch is at (`rev-parse refs/heads/<branch>`), and every run with a branch checks first: an
environment installed from an older commit is reported behind, and the run is blocked with a
reinstall on its button, since running the older code is not what a run of the branch is for (an
editable copy whose version moved still runs: its code is current). A reinstall is two pip
steps, because pip stops at a version it has, however many commits came since: a forced install
without dependencies, then an ordinary one, which adds any dependency the new commits brought.

**A development run says so.** The Run panel shows a banner, first in its stack, naming the runner's
version, the copy, and either `working copy` or the branch and commit, for as long as the run is on
show. The Libraries view reads "development jpipe-runner".

## Alternatives considered

- **A dropdown of releases in the Settings editor.** An `enum` is fixed when the extension is
  built, so it would list the releases of that day. The picker asks PyPI when it opens.
- **Switching the checkout to the branch.** Runs would then use uncommitted changes too, but jPipe
  would change the user's working copy, and refuse whenever it had changes.
- **Pinning the chosen release in a pip project's requirements file.** It would make the choice
  everyone's who rebuilds the environment, where the setting may be one person's; ADR-VSC-0026
  keeps the record at the minimum.

## Consequences

- Choosing a release needs network access to PyPI; the rest of the extension does not.
- A run with a branch costs a check first: git, and asking the environment's Python what it has.
  New commits are noticed then, not as they are made.
- A run in development mode can be told from a release's, in the panel, and in the environment
  report, which names the branch and commit.
- A managed project whose user chooses a release has it recorded in its files by its tool, and the
  consent dialog says which.
