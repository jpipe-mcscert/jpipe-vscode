# ADR-VSC-0032: Each release names the oldest tools it works with

**Date:** 2026-11-19
**Status:** Accepted

## Context

The extension drives two programs it does not ship, the jPipe compiler and jpipe-runner, and
leans on one extension it does not ship either, Pylance. Each release of the extension is
written against particular releases of the first two. Scaffold Step Library writes what the
compiler's `process -f PYTHON` produces, and only compiler 3.0.0 or later produces step
libraries for jpipe-runner 4. The Libraries view, New Library… and the Outline's step bindings
read the decorators jpipe-runner introduced in 4.0.0.

What each release needs was written down in four unconnected places, each answering a different
question:

- the managed install hid compiler releases below major 2;
- the preview asked for JSON diagnostics only from compiler 2.4.0, and **quietly fell back** to
  the text report on anything older;
- the runner environment treated a jpipe-runner below 4.0.0 as missing, and offered to upgrade it;
- Python 3.11, jpipe-runner's own floor, gated the environments the extension would create.

The compiler had no requirement at all: an old one was used as far as it went, and the features
it lacked failed one by one, each in its own way, none of them saying "update the compiler". And
the managed install offered releases that the rest of the extension could not use.

Pylance is a different kind of dependency. It checks a step library against jpipe-runner as the
user writes it, and it underlines an import the workspace's environment cannot satisfy, which the
environment fix answers (jpipe-vscode ADR-VSC-0026). Nothing about running a model needs it. It
is published for Microsoft's builds of VS Code only.

## Decision

**Each release of the extension names, in `src/extension/requirements.ts`, the oldest compiler,
jpipe-runner and Python it works with, and nothing newer.** Every check reads that one table: the
compiler gate, the managed install's list of releases, the runner environment's check and its
upgrade requirement (`jpipe-runner>=X`), and Check jPipe Installation.

**A compiler older than the minimum is not run.** Its version is asked once per command
(`jpipe --headless --version`). A compiler that is too old is refused before any preview, export,
diagnostic, scaffold or run, with one notification per compiler and version, and that notification
offers the way out: the managed mode installs a newer release, and the `cli` and `jar` modes open
the install guide. A compiler that reports no readable version is let through. If it then rejects
`diagnostic -f json`, it is reported as too old. A prerelease of the minimum counts as the
minimum.

**jpipe-runner and Python keep their existing treatment**, now reading the same table: an older
runner is a workspace that cannot run yet, and the environment fix upgrades it.

**A tool may also have a recommended release**, in the same file (`RECOMMENDED`): the oldest that
has everything this release uses, where the minimum is the oldest it works with at all. A release
between the two works, without what the recommended one adds, and is never refused for it. The
code asks for what the recommended release adds only of a release that has it, and Check jPipe
Installation says, below it, what upgrading brings. For jpipe-runner, each such feature is listed
with the release that brought it (`RUNNER_FEATURES`): 4.1 follows a run as it goes
(jpipe-vscode ADR-VSC-0033), and 4.4 runs independent steps together (ADR-VSC-0035). The
recommended release is the newest of them, 4.4.0, and each feature is asked of a runner from its
own release, not from the recommended one.

**Pylance is wanted, not required.** It is not an `extensionDependencies` or `extensionPack`
entry. A workspace with step libraries is offered it once, after the environment's own offer and
silenced by the same setting. Check jPipe Installation and Check the Python Environment report
whether it is installed and offer to install it.

**Check jPipe Installation is the one report** of all three: the compiler and its version, then,
in a workspace with step libraries, whether models can run there and whether Pylance is
installed. Its single button fixes the first problem in that order.

## Rationale

- **No upper bound.** An upper bound would turn every compiler or runner release into a broken
  extension until the extension is released again. Tools that change incompatibly are met by
  raising the minimum in the release that adapts to them, and the changelog says so.
- **Refusing an old compiler, rather than degrading.** Degrading kept the preview's diagnostics
  alive on 2.3, and nothing else. A scaffold from compiler 2.5 writes a library for a runner the
  extension no longer supports, and the user discovers it at the first run. One clear refusal,
  naming the version found, the version needed and the button that fixes it, costs a user one
  update. Silent partial failure costs them a diagnosis. It also removes the text-report fallback.
- **A minimum, not an exact version.** Pinning the compiler or the runner to one release would
  flag every patch release as unsupported. Distributions such as Homebrew and Scoop move on their
  own schedule.
- **One table, in TypeScript, rather than a field in `package.json`.** The manifest was
  considered. Under `NodeNext` a JSON module can only be imported whole, which would put the
  entire manifest, every contributed command and setting, into the shipped bundle
  (jpipe-vscode ADR-VSC-0020). No tool outside the extension reads the requirements today.
- **Pylance as a soft dependency.** Declaring it would stop jPipe from activating in VSCodium and
  every other non-Microsoft build of VS Code, where Pylance cannot be installed, and would put
  Python tooling on the machine of a user who only writes models. An extension pack avoids the
  first cost but not the second.
- **A recommended release, rather than a raised minimum, for what only makes a feature better.**
  Raising jpipe-runner's minimum to 4.1 would have stopped every workspace still on 4.0 from
  running, for a run that is followed as it goes rather than read when it ends. A recommendation
  costs those users nothing, and says what they would gain.
- **The compiler is asked again while it is too old.** A user told to update often updates in
  place, under the same command. A cached refusal would outlive the update until the window
  reloaded. A compiler found usable is cached, as before.

## Consequences

- **Raising a minimum is a release decision.** It is one line in `requirements.ts`, it is a
  user-facing change, and it needs a changelog entry that says who must update what. The
  minimum's comment says which feature needs it, so that a later release can tell whether it may
  be lowered.
- **Users of an older compiler lose the preview** until they update, where they used to get its
  diagnostics as text. This is the intended effect, and the notification tells them how to update.
- **The managed install no longer lists releases the extension would refuse**, so a pinned old
  release cannot be reinstalled from the picker.
- **A compiler that misreports its version is believed.** A build that claims 3.0.0 without its
  features fails where the feature is used, and is caught only by the `-f json` check.
- **Nothing tests the extension against the minimum it declares.** The table states what the
  code was written against. No CI job runs it against those releases. A feature that silently
  needs a newer compiler is caught by its user, not by the build.
- **The extension is not released before the recommended releases it names are published.**
  Otherwise its changelog and its Marketplace page describe what no user can install yet, short
  of a development build. Like the minimums, the recommended releases are stated in the Marketplace
  README, which `test/requirements.test.ts` holds to the table.
- **Pylance's absence is visible but never blocking.** A user who declines it gets no editor
  checks on step libraries and no underline for the environment fix to answer. Runs are
  unaffected.
