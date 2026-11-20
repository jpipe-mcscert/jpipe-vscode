# ADR-VSC-0031: A run is drawn in a panel of its own, beside the editor

**Date:** 2026-11-15
**Status:** Accepted

## Context

▶ runs a justification with jpipe-runner and lists its report in the Results view, by outcome
(ADR-VSC-0029). A list cannot show the argument's shape: an evidence shared by two strategies is one
node with two arrows, and a failure is read most quickly where it sits in the argument. The runner
already draws a run, in two views (jpipe-runner ADR-0022): the **argument**, exactly as the compiler
draws it, with each element's status over it; and the **dataflow**, which adds the files each
evidence observes and the variables the steps produce and consume. A check (`--dry-run`) draws both
from what the steps declare, without calling any step (jpipe-runner ADR-0024), so the dataflow
exists before anything has run.

The argument alone is what the preview already draws, from the compiler. The dataflow is not: it
is the same argument with the files and values the steps declare added to it, and, once steps ran,
each element's status drawn over it.

Two places could show a run. The preview already draws diagrams beside the editor, and could gain
a run mode. Or a run could have a panel of its own. The two differ in what they are
about and when they change: the preview follows the cursor across every model, templates included,
and is redrawn by the compiler on every save; a run is of one justification, is redrawn only when
asked for, since it may call every step of a project, and stops being true as soon as the model or
a library changes.

## Decision

A run is shown in a **run panel**, a webview beside the editor, of its own.

- **One panel, the last run.** It is opened, without taking the focus, by every ▶ — a `.jd`
  editor's title, a justification's row in the Models view, a checked library's ▶ menu — and by
  every ✓ Check, which a justification's context menu in the Models view now offers too. It is
  reused for every run, never locks its editor group (ADR-VSC-0019), and keeps the last run in
  memory only: it is not restored after a window reload.
- **Its own ▶ and ✓** run again, or check, the justification it shows, with the libraries checked
  when the button is pressed. **■** stops a run under way.
- **The dataflow, and only it.** The runner is asked to draw the dataflow as SVG, read before the
  run's folder is removed. The argument view is not asked for: the dataflow is the argument, with
  the statuses and the declared data on it, and the argument alone is the preview's. The option
  depends on the runner's release. jpipe-runner 4.0 draws the dataflow with `--dataflow` and the
  argument with `--diagram`; the releases after it draw only the dataflow, with `--diagram`, and
  refuse `--dataflow` (jpipe-runner ADR-0029). So 4.0.x is asked for `--dataflow`, and every other
  release for `--diagram`. That includes a release the extension cannot know, a runner named in
  the settings or a source checkout without a version, because `--diagram` runs on every release
  where `--dataflow` would stop the later ones.
  When the runner cannot draw, most often because Graphviz is missing, it stops before any step with
  exit code 4 and no report, and the run is launched once more without the drawing; the panel then
  says why it has none.
- **What stops a run is said in the panel**, with the one thing to do about it on a button: no
  library checked (Show Libraries), a model that does not compile (Show Problems), no environment
  that can run steps (its fix, after which the run goes ahead), a runner that wrote no report (Show
  Output). These were dialogs. A run that ends this way takes the previous drawing with it: its
  colours were another run's.
- **A verdict bar** opens with what was done — **Execution**, which called every step, or **Check ·
  no step called** — then the verdict, its counts, when, and which libraries were loaded. Each count
  opens its group in Results. A banner says when the run is **out of date**: a jPipe file or a
  library it loaded was saved since, or the libraries checked changed. Nothing is run again unasked.
- **One run, two views.** The panel and the Results view show the same run, held in one place
  (`runner/run-session.ts`), and come forward together, neither taking the focus: the panel beside
  the editor, Results in the bottom panel. Until there is a report, Results lists one row saying the
  run is under way, or why it ended without one. A run started while another is under way takes both
  over; the earlier one's result is dropped.
- **A click follows the flow.** Clicking a node — an element, an observed file, a variable — lights
  it and everything its arrows lead to, up to the conclusion, and dims the rest; the walk is read
  from the drawing's own edges (`webview/flow.ts`). Clicking it again, clicking the background or
  pressing Escape clears the selection. An element's click also selects its row in Results, and
  selecting an element's row in Results lights its node the same way. Double-clicking an element
  opens it in its `.jd` file. The runners after 4.0 draw a template's `@support` slot as a node of
  its own in the template's cluster, named after the element that fills it with `@abstract`
  added. Clicking or double-clicking that node acts on the filling element.
- **The canvas is the preview's.** Panning, zooming, the minimap and following the theme move
  from `webview/preview.ts` into `webview/canvas.ts`, which both pages use, and the run panel wears
  the preview's stylesheet with one of its own on top. The decisions — what the page is told, when
  a run is out of date, where an element is declared — are in `runner/run-state.ts`, and the page's
  logic in `webview/run-view.ts`; both are tested.

## Rationale

- **What follows, not the node alone**, because the question a dataflow is clicked for is what
  depends on this: which claims a file feeds, which steps a value reaches. A node on its own is
  already visible.
- **A panel of its own, because a run is not a view of the cursor.** A run mode in the preview
  would either stop following the cursor, which is what the preview is for, or drop the run as soon
  as the cursor moved. Two panels keep two behaviours that each read simply: the preview is always
  current, the run panel is a snapshot that says when it is out of date.
- **The last run only**, because that is what Results shows (ADR-VSC-0029), and two views of one
  run is the only arrangement in which they cannot disagree. Keeping one report per justification
  would mean keeping files and choosing which one to show; nothing asks for it yet.
- **Opened by ▶, not by opening a file.** A check imports the step libraries, which runs their
  top-level code (ADR-VSC-0025); a run calls every step. Neither may happen as a side effect of
  looking at a model.
- **The dataflow only**, because it is the view that exists before anything ran, the one that shows
  what validation stops a run for — a variable with no producer, a file that cannot be read — and it
  carries the statuses too. A second view of the argument alone would repeat the preview.
- **Execution or check, said first**, because both can end green, and only one of them called the
  steps: a valid check read as a passed execution would claim what was never tested.
- **Results with the panel**, because the drawing says where a run failed and Results says why; a
  reader should not have to look for the second after reading the first.
- **Notices in the panel rather than dialogs**, because the panel is where the reader is looking
  once ▶ is pressed, and a notice stays until the next run where a dialog is gone with one key.
- **Drawn by the runner**, as the compiler draws the preview: one notation across jPipe's tools
  (jpipe-runner ADR-0022), and nothing to lay out in the extension. Asking it again without the
  drawing when it cannot draw keeps every run that worked without Graphviz working.

## Consequences

- **A run draws an SVG**, which costs a Graphviz layout; on a large model that is felt before the
  verdict appears. A runner that cannot draw costs a second launch, in which no step runs.
- **The argument alone, with statuses, is not shown anywhere.** jpipe-runner 4.0 can draw it, and
  its later releases cannot. A reader who wants the statuses without the data has the dataflow, or
  the preview for the argument without the statuses.
- **A runner whose release is unknown, if it is 4.0, draws the argument without its files and
  values**, since it is asked for `--diagram`. A development build of the runner from between 4.0
  and the change to `--diagram` reports a later release but still wants `--dataflow`: it stops with
  a usage error and no report, which the panel says, pointing at the terminal.
- **Two report versions and two options are read and passed** until the minimum runner moves past
  4.0 (jpipe-vscode ADR-VSC-0032). Then the `--dataflow` branch and version 1 go.
- **The panel shows nothing while a run is under way** but a busy overlay over the last drawing:
  the report arrives whole. Statuses appearing as steps finish, and clickable file and variable
  nodes in the dataflow, wait for jpipe-runner (#169).
- **`preview.ts` lost its canvas to `canvas.ts`.** A change to how the preview pans or zooms now
  changes the run panel too, which is the point, and is tested in `test/canvas.test.ts`.
- **The panel itself needs the editor**, so its round trip through the extension host is checked by
  hand (ADR-VSC-0004); `run-session.ts`, `run-panel.ts`, `run-shell.ts` and `webview/run.ts` are
  coverage-excluded on that ground (ADR-VSC-0010).
- **Out of date is approximate.** Any jPipe file saved counts, whether the model loads it or not,
  and an observed artifact that changed does not count at all; `jpipe-runner status` could say the
  latter once reports are kept.
