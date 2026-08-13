# ADR-VSC-0019: The preview does not lock the editor group

**Date:** 2026-08-13
**Status:** Accepted

## Context

The diagram preview is a single webview panel, opened with `ViewColumn.Beside`. Since April 2026
`openPreview` has also run `workbench.action.lockEditorGroup` against whichever group the panel
landed in, so that group refuses to accept new editors and VS Code opens them elsewhere.

The problem it addresses is real. Without it, anything that opens a file while focus sits in the
preview's group — quick-open, go-to-definition, a row in the diagnostic view, a `load` hover link
— opens *into* that group and buries the diagram behind a text editor. The panel is a singleton
and redrawing it costs a compiler invocation, so that is not a cheap accident to recover from.

It has never sat comfortably. The lock was added, removed again as a "non-working panel lock",
and reintroduced in a different form, all on 2026-04-27 (`aa5c2e4`, `73b93ad`, `dc72cb6`). What
survives is the third attempt, and the cost has settled in three places.

**It writes global editor state that is never cleared.** Group locking is a first-class VS Code
feature with its own lock icon, command and keybinding; users have their own view of which groups
are locked. `openPreview` flips it silently, and `onDidDispose` clears the panel references
without unlocking. Whether a locked group outlives the panel depends on whether the editor
disposes the now-empty group — undetermined here, because there is no VS Code host in the test
environment (jpipe-vscode ADR-VSC-0004) and this was established by reading rather than running.
Either way, no code path unlocks, so surviving the panel would be accident rather than design.

**It guesses at a time where an event exists.** `ViewColumn.Beside` is a request, not an answer:
`panel.viewColumn` resolves only once the editor has laid the group out, and nothing is emitted
when that happens. So `lockPreviewGroup` waits 100 ms, focuses the preview's group, locks it, and
focuses back. If the panel has not landed by then the function returns silently and the group is
simply never locked — the behaviour is nondeterministic rather than merely delayed, and it fails
in the direction of doing nothing on exactly the loaded machines where a stray editor is most
disruptive. It also walks a hardcoded nine-entry table of column names and gives up past the
ninth. `onDidChangeViewState` reports the change the sleep is waiting for; this file never uses
it.

**Its layout assumption has already gone wrong once.** Because the lock encodes "the preview is
beside, so the editor is column one", `revealLocation` hardcodes `viewColumn: vscode.ViewColumn.One`
when opening a diagnostic's source. In a three-column layout — another file on the left, the `.jd`
in the middle, the preview on the right — clicking a diagnostic row opens the source over whatever
occupied the left column. The same function's caller already captures `editor.viewColumn` correctly
in order to restore focus, so the file holds the right answer in one place and assumes it in
another.

The decisive comparison is VS Code's own Markdown preview. It solves the same problem — one
preview panel beside a text editor, reused rather than recreated — and does not lock its group.

## Decision

The preview opens beside the active editor and leaves the group's lock state alone. Editor layout
belongs to the user.

Where the extension opens a document of its own accord, it targets the column of the editor the
model is actually in, rather than assuming column one.

## Rationale

- **The lock buys protection against one annoyance and pays for it in three currencies** — global
  state the extension does not own, a race, and a hardcoded layout. A user whose diagram is buried
  presses one key to bring it back. A user whose left-hand column is overwritten by a diagnostic
  reveal loses whatever was there.
- **Keeping the lock and fixing its three defects** was the serious alternative: unlock on
  dispose, replace the sleep with `onDidChangeViewState`, and derive the reveal column. That is
  strictly more code, still untestable, still overriding a preference the user can express
  themselves — to preserve a behaviour the platform's own preview does without.
- **Making it a setting** was rejected for the same reason plus one: it converts a decision into a
  question every user must answer, and the honest default would be off, which is this decision
  with extra machinery.
- **The reveal-column fix is not conditional on any of this.** Assuming column one is wrong
  whether or not the group is locked; the lock only made it easy to believe otherwise. It is
  stated here rather than left implicit precisely so that a future reinstatement of the lock does
  not carry the assumption back in with it.
- **The Markdown preview is the strongest available evidence.** It is the same problem, solved by
  the people who own the API, in a component every VS Code user has seen.

## Consequences

- **The diagram can be buried again.** This is the cost, and it is not hypothetical: opening a file
  while focus is in the preview's group will replace it. Recovering is one quick-open or one click
  on the tab, and the panel keeps its contents (`retainContextWhenHidden`), so nothing is
  recompiled — but the interruption is real, and anyone who preferred the old behaviour should be
  pointed at VS Code's own group lock, which they can apply and keep.
- **`lockPreviewGroup` goes, and with it the 100 ms sleep, the focus round trip and the nine-entry
  column table.** The one piece of timing-sensitive layout code in the extension is removed rather
  than fixed.
- **`revealLocation` must derive its target column** from the editor holding the model, falling
  back to `ViewColumn.One` only when there is none. Until that is done the reveal bug outlives the
  lock that motivated it.
- **None of this is covered by the suite**, before or after — `preview-provider.ts` imports
  `vscode` and is coverage-excluded (jpipe-vscode ADR-VSC-0010). The change is verified by hand in
  the Extension Development Host, and a regression would surface as a user report rather than a
  red build. Removing the sleep at least removes a failure mode that depended on machine load,
  which is the kind manual testing is worst at finding.
- **The code does not yet match this record.** The decision is taken; `openPreview`,
  `lockPreviewGroup` and `revealLocation` still carry the old behaviour at the time of writing.
