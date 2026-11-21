# ADR-VSC-0033: A run is followed from its events, which preview its report

**Date:** 2026-11-21
**Status:** Accepted

## Context

The Run panel and the Results view show a run from the runner's JSON report (ADR-VSC-0029,
ADR-VSC-0031), which arrives whole when the run ends. Steps are where a run spends its time —
test suites, scanners, builds — so a run could show only a busy overlay for minutes, then
everything at once.

From 4.1, jpipe-runner writes a run's events as it goes, with `--events PATH` (jpipe-runner
ADR-0030, its `docs/events.md`): a file in JSON Lines, one event per line, written whole and
flushed as it happens. `run.started` lists every element's id; `validation.ended` says what
validation found; `element.started` says that a step is about to be called; `element.decided`
carries the element exactly as the report will write it; `run.ended` gives the verdict. The events
have a version of their own (`1.x`), which only adds events and fields within a major version.
They promise a causal order and nothing more: two elements' events may interleave, since the
runner may later call independent steps together (jpipe-runner#174).

The extension launches the runner as a VS Code task (ADR-VSC-0029), so it holds none of the
runner's pipes: a file is the only way to read the events. The run's folder, where the extension
asks for that file, is in the extension's storage, outside the workspace.

## Decision

An execution is followed from its events whenever the runner can write them, and the report
replaces what they said when the run ends.

- **Asked for from 4.1.** `--events <run folder>/<name>.events.jsonl` is passed to a runner whose
  release, asked of it as it is launched (ADR-VSC-0031), is 4.1 or later, development builds
  included (`streamsEvents` in `runner/runner-invocation.ts`). A runner whose release is unknown
  is not asked. A check is not asked either: it calls no step, so its stream would say nothing the
  report does not. A development build of 4.1 from before the option reports the release that has
  it, and refuses it with a usage error and no report: a run asked for its events that ends so is
  launched once more without them, as a run that cannot draw is launched again without its drawing
  (ADR-VSC-0031). Nothing ran either time, so this costs one start of the runner (`relaunchWithout`).
  Each launch starts from no progress, so a launch again never shows the first one's.
- **The file is polled**, every 150 ms while the task runs and once more after it ends, reading
  from where the last read stopped. Only lines that end with `\n` are read, and UTF-8 is decoded
  across reads. A file not written yet is waited for; one that shrinks was emptied by a runner
  starting over, and is read again from its start. The file is removed before each launch, so a
  run launched again without its drawing never reads the first launch's lines.
- **Versioned as the report is.** Major version `1` is read; events and fields it does not know are
  ignored. A stream of another major version is not read, which the log says, and the run is shown
  when it ends, as before.
- **What the events say is kept on the run on show** (`progress` in `runner/run-state.ts`): every
  element's id in the report's order, the elements running, as a set, and those decided, each with
  its diagnostics and how long its step took. Polling is what limits how often it changes.
- **Results lists a run under way** below the row that says so, which now counts how many elements
  are decided: the problems validation found about no element, then the decided elements grouped
  as the report's rows are, then *Running*, then *Waiting*. An event's element is the report's, so
  the rows of a decided element are the ones the report will give it, and they open their files
  and steps during the run as they do after it. An element running or waiting is named by its label
  in the compiled model the run reads, which carries the ids the runner's events use.
- **The panel's verdict bar** says how far the run is (`2 of 4 decided`), its outcomes so far, each
  opening its group in Results as the verdict's counts do, and which step runs, by its label.
- **The report replaces it** when the run ends, and is the only thing read for the verdict, the
  counts and the rows. What the report cannot say, how long each step took, is kept from the
  events and shown beside each element.

The reading is in `runner/run-events.ts`, which imports no `vscode` and is tested against a stream
quoted from the runner's documentation and against files written while they are followed.

## Rationale

- **Polling, not a watcher.** VS Code's file watcher does not see the extension's storage, and
  `fs.watch` behaves differently on each platform and may miss writes to a file opened elsewhere.
  Polling every 150 ms reads the file at most seven times a second, which is also the most a fast
  run should redraw Results and the panel.
- **The report stays the authority**, because the runner says it is: a value an event records may
  differ from the report's (jpipe-runner#184), and a stream may stop short of `run.ended` when the
  run is stopped. Replacing the progress with the report at the end means the events can only ever
  be early, never wrong for longer than the run takes.
- **An unknown release gets no `--events`**, the reverse of the choice ADR-VSC-0031 makes for the
  drawing's option. There, the wrong option on a later runner stops every run. Here, the option on
  a runner that does not know it stops the run, while leaving it out only loses the preview.
- **No new minimum runner.** The events make a run nicer to watch; they change nothing it can do.
  Raising the minimum to 4.1 (ADR-VSC-0032) would stop working setups for that.
- **A set of running elements, and no order assumed** beyond the runner's promises, so that nothing
  here changes when the runner calls steps together (jpipe-runner#174).
- **Labels from the compiled model**, because `element.started` and `run.started` give ids only,
  and an id (`release:e1`) is not what a reader recognises. The runner reads its ids from that very
  file (jpipe-runner ADR-0001), so the two agree with no matching of names; an id the file does not
  have is shown as it is.

## Consequences

- **A run with jpipe-runner 4.1 or later shows each element as soon as it is decided**, in Results
  and in the panel's counts. Earlier runners, and runs whose events cannot be read, are shown as
  before. The drawing itself is still coloured only when the run ends: the runner draws it then
  (jpipe-mcscert/jpipe-runner#185, jpipe-vscode#112).
- **The extension reads a second contract of the runner's**, with its own version. A runner that
  moves its events to version 2 is shown when its runs end until this is updated.
- **A run writes one more file**, in its own folder, removed with it. A runner that cannot write
  it stops with the exit code of a runner that cannot draw, and is taken for one: launched again
  without its drawing, it stops the same way, and says so. The folder is the extension's own, so
  this is a disk that cannot be written at all.
- **Results is rebuilt at each poll that brings news.** The tree keeps expansion and selection by
  row id, which is stable from one poll to the next, and from the last poll to the report.
- **Polling the file and the tree's redraws need the editor**, and are checked by hand
  (ADR-VSC-0004); what they show is decided in tested modules.
