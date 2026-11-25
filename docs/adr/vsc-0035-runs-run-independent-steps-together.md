# ADR-VSC-0035: Runs run independent steps together, unless a setting says otherwise

**Date:** 2026-11-23
**Status:** Accepted

## Context

From 4.4, jpipe-runner takes `--jobs N` (jpipe-runner ADR-0038): it runs up to `N` steps at a time,
each on a thread of its own, and `--jobs auto` runs one per CPU the process may use. A step still
starts only once everything that supports it is decided, and the report is the same, in the same
order, whatever the number of jobs; only the events interleave, which ADR-VSC-0033 already reads.
The runner's own default is `1`: one step at a time, in model order, as before.

Steps are where a run spends its time (ADR-VSC-0033), and the evidence under one strategy is most
often independent: a test suite, a linter, a scanner. Run one at a time, they add up.

Running steps together is not free for every library. A step that writes a file another evidence
observes, changes the working directory or the environment, or changes a value it consumes, can
break with `--jobs`, and nothing checks it (jpipe-runner's `authoring.md`, "Steps that run
together"). A runner older than 4.4 refuses the option as unknown, with a usage error, and runs
nothing.

## Decision

- **A setting, `jpipe.runner.jobs`, in jPipe › Runner › General** (ADR-VSC-0028, ADR-VSC-0036),
  beside the execution environment, the release and the runner command: how a model is run. `auto`, or a whole
  number of at least 1. It is a string with a pattern, so that the Settings editor shows a text box
  and refuses anything else, rather than sending the user to `settings.json`. A number written in
  `settings.json` is read as well. Anything else runs as `auto`, and the log says so, once.
- **`auto` by default**, passed as `--jobs auto`, so that the runner counts the CPUs it may use.
- **A number is passed as it is, capped at the CPUs this editor may use**
  (`os.availableParallelism()`), as the issue that asked for the setting specified (#136). The log
  says, once, when it was lowered. The runner is launched as a task of the extension host, so it
  runs on that host's machine, a remote one included, unless the runner command the user names
  wraps it elsewhere, in a container say: then the cap is that of the editor's machine, and `auto`,
  which the runner counts for itself, is the value to use.
- **Asked only of a runner known to have it**, 4.4 and later, development builds included
  (`RUNNER_FEATURES.jobs` in `requirements.ts`, `runsJobs` in `runner/runner-invocation.ts`), like
  `--events` (ADR-VSC-0033). A runner whose release is unknown is not asked, and runs as before.
  A development build of 4.4 from before the option refuses it with a usage error and no report:
  the run is launched once more without it (`relaunchWithout`), as for `--events`. Only a
  pre-release of the release that brought an option may lack it (`runnerMayLack`), so a usage
  error from any other release is the user's to read, and launches nothing again. Every 4.4 build
  knows `--events`, so a usage error with both in doubt is put down to `--jobs`.
- **A check is not asked**: it calls no step.
- **The Run panel's verdict bar names every step under way**: one by its label, more counted, since
  a label is a sentence and the bar one line, with all of them in its tooltip. The drawing and Results already mark each running
  element on its own.
- **jpipe-runner's recommended release becomes 4.4.0** (ADR-VSC-0032), and Check jPipe Installation
  says, of an older one, what each later release brings.

## Alternatives considered

- **The runner's default, `1`.** The editor and CI would agree, but a run in the editor, where it is
  watched as it goes, would stay as slow as it can be, and few users would find the setting. A run
  in the editor is a development run: one that fails there and passes in CI points at a library
  that breaks the rules for steps that run together, which is worth knowing before CI runs it with
  more jobs.
- **An integer setting with an `anyOf` schema.** VS Code's Settings editor cannot edit it, and sends
  the user to `settings.json`.
- **Refusing a number above the CPUs.** The machine a setting is written on is not always the one it
  runs on, with settings synchronised or committed to a workspace. Lowering it keeps the run going.

## Consequences

- **A library not ready for steps that run together can fail in the editor and pass in CI**, where
  the runner's default is `1`. The setting's description says so and how to go back to `1`.
- **Runs with independent slow steps are faster in the editor** with jpipe-runner 4.4 or later; with
  an older runner, nothing changes.
- **The events of one run interleave.** ADR-VSC-0033 already reads them as such: the elements running
  are a set, and each is decided by its own event.
