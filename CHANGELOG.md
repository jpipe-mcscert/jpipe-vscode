## Changelog

### v1.9.0 (Unreleased)
- Leader: Sébastien Mosser
  - Features:
    - **A `refine` that hooks onto nothing is flagged as you write it.** The hook names an element of the model being refined, but it is written as a quoted string, so nothing checked it: a typo, or an element renamed afterwards, left a model that read perfectly and then failed the build with a message about an element not being found. It is now reported on the hook itself, in the compiler's own words, so the problem is on the line that causes it. Two things are deliberately not flagged, because the compiler accepts them: a bare name that reaches an element inherited from a template under its longer name, and a hook onto a model that is itself assembled or refined, whose elements only come into existence when that composition runs
  - Bug Fixes:
    - **Renaming an element updates the `refine` hooks that name it.** Renaming used to rewrite declarations and relations and leave hooks pointing at the old name — the one place the name is written as a string rather than as an identifier — so a rename could quietly break a composition that had been working. Hooks now follow, whether written as the plain name or with the template qualifier in front of it, and a same-named element in an unrelated model is left alone. The exception is a hook onto a composed model, which cannot be traced back to the element being renamed and keeps its old spelling
    - **A file that only loads other files is no longer called empty.** An aggregator — a `.jd` file whose whole content is `load` lines, with the models themselves living elsewhere — was flagged with a warning saying the justification file should not be empty. The compiler read the same file, resolved every load and said nothing, so the editor and the CLI disagreed about a file that is perfectly ordinary, which is what made it confusing: the warning was the only sign of a problem, and there was no problem. They now agree. What is still flagged is the file that genuinely declares nothing — blank, whitespace, or comments alone — and since the compiler refuses to build one of those, it is now an error rather than a warning (#70)

### v1.8.1 (2026-08-14)
- Leader: Sébastien Mosser
  - Bug Fixes:
    - **Format Document now works on a model.** Pressing `⇧⌥F`, or picking Format Document from the right-click menu, reported that no formatter was installed for jPipe — and the feature that would have laid the file out was sitting in the **Source Action…** menu instead, where almost nobody looks. Tidying a file is what Format Document is *for*, so that is where it belongs and where it now is: Format Document, Format Selection and format-on-save all lay a model out, and *jPipe: Auto-indent and Align* in the palette still does too. The layout itself is unchanged — comments stay beside what they describe, blank lines stay where you put them, and a model written on one line comes back on one line. **If you use format-on-save:** v1.7.0 said a format-on-save setting kept for another language would never re-space your models, and that is the part of it being in the wrong menu that was worth keeping. It no longer holds. To keep save quiet for models only, add `"[jpipe]": { "editor.formatOnSave": false }` to your settings
    - **The layout respects your indentation settings.** It used to be four spaces per level no matter what your editor was set to, so a model in a two-space project came back at four. It now uses your tab size, and tabs if that is what you indent with. The padding that lines the `is` keywords up in a column is still spaces either way — a tab jumps to the next tab stop rather than by a fixed width, so it cannot line anything up. Four spaces remain the default, so a project that has not set anything looks exactly as it did
    - **Format Selection lays out just the lines you selected**, padded to line up with the neighbours it leaves alone rather than only with each other, so formatting part of a body does not split its columns down the middle

### v1.8.0 (2026-08-14)
- Leader: Sébastien Mosser
  - Features:
    - **Browse for the compiler JAR instead of typing its path.** Running jPipe from a JAR meant hand-writing an absolute path into a settings text box — long, different on every machine, and easy to get subtly wrong, with the only symptom being a compiler that would not start and nothing pointing back at the setting that caused it. There is now a file dialog, reachable from a link in the setting itself or from the command palette, that opens where your current JAR is and fills the path in for you. It writes the path wherever you already keep it, so a project-specific JAR is not quietly overwritten by a machine-wide one, and if your execution mode is not set to JAR it tells you the file will be ignored and offers to switch — rather than saving a setting nothing would read
    - **A model claiming two conclusions says so, instead of complaining about the second one.** A justification argues for one thing, and the compiler has always rejected a second conclusion — but the editor used to report only that the extra conclusion had nothing supporting it. That was true and it was the wrong problem to be shown, because the compiler discards that conclusion entirely. You now get one error, on the extra declaration, saying what is actually wrong; the misleading warning is gone. Templates are held to the same rule
    - **A model with no conclusion is flagged as you write it.** An argument with nothing at its root is not an argument, and the compiler has always refused to build one — but the editor said nothing, so you found out at build time. It is now reported where you are typing. A conclusion inherited from the template you implement counts, so implementing a template that already has one is not flagged, and models assembled by a composition are left alone because their conclusion does not exist until the composition runs
  - Changes:
    - **A red squiggle now means the build will fail, and nothing else does.** Whether a problem showed as an error or a warning had drifted, so three problems that stop the compiler dead — a template with no `@support`, a strategy nothing supports, a conclusion nothing supports — were only warnings, while other build failures were errors. There was no way to tell from the colour whether a thing mattered. Errors are now exactly the problems the compiler rejects; warnings are the ones it builds anyway, like an empty label or a config key it ignores. The practical effect is that a model you are still writing shows errors sooner — it genuinely does not compile yet — and in exchange a clean Problems panel means a model that builds
    - **A problem has one name, wherever you read it.** The editor and the compiler each labelled the problems they found, and they had picked different words for the same thing — a conclusion nothing supports was reported one way in the Problems panel and another way in the diagram's diagnostic report, four inches apart in the same window. Filtering on the label you could see found nothing under the other one. The editor now uses the compiler's names throughout, so the label you search for, filter on, or quote in a bug report is the same one everywhere. The labels themselves have changed as a result: if you have one typed into the Problems panel filter box, retype it
  - Bug Fixes:
    - **The preview no longer takes your editor layout over.** Opening a diagram used to lock the editor group it landed in, so that side of the window would refuse to accept any other file — a setting the extension applied to your workspace silently and never undid, and one you may well have had your own view about. It now opens beside your model and leaves the layout to you. The trade-off is that a file opened while the diagram has focus can now cover it, as it would with any other preview; clicking the tab brings it straight back, with nothing recompiled. If you liked the old behaviour, it is a standard editor feature you can apply yourself and keep: **View: Toggle Editor Group Lock**
    - **Clicking a problem in the diagnostic view opens the file where it belongs.** It always opened in the first column, on the assumption that is where your model is. Whenever it was not — a three-column layout, or simply a different arrangement — the file landed on top of whatever you had on the left instead. It now opens where the file already is if you have it open, and beside the diagram otherwise
  - Maintenance:
    - **The extension ships only what it runs, and a check now enforces it.** Its package is built from a list of what belongs in it rather than a list of things to leave out, and every build compares the result against that list, so nothing drifts in unnoticed. Previously a test-coverage report left over from a local build could be packaged alongside the extension — no released version ever contained one, but nothing stood in the way. An unused 95 KB image has gone too, so the download is smaller and stays that way (nothing you do in the editor behaves differently)
    - **The extension downloads about a quarter smaller.** Its code is now compressed when packaged for release, taking the download from roughly 680 KB to 520 KB — quicker to install and to update, and a little quicker to start. Function names are deliberately kept readable in the process, so a crash report still says where it came from and problems you report stay as diagnosable as before (nothing you do in the editor behaves differently)

### v1.7.1 (2026-08-13)
- Leader: Sébastien Mosser
  - Bug Fixes:
    - **The preview works in a dark theme whichever Graphviz you have.** Whether the white sheet behind a diagram disappeared depended on which version of Graphviz was drawing it. On the version most Linux machines have — it is what `apt install graphviz` still gives you on Debian stable and on every Ubuntu LTS before 26.04 — the sheet stayed, so the whole panel was a white rectangle in the middle of a dark editor and the preview was effectively unusable. Nothing about the extension, the theme or the operating system made the difference, which is why it looked arbitrary: it was the compiler's own renderer, spelling one thing two ways. Both are now understood, so the diagram sits on your editor's background everywhere
    - **The preview's download button saves the model you are looking at.** When the file behind the preview could not be reopened — renamed, moved or deleted since it was drawn — the download quietly fell back to whichever `.jd` file your cursor was in and saved that instead, under the filename and format you asked for. Nothing reported it, so the export looked like it had worked and the mistake surfaced only when someone opened the file. It now says it could not reopen the document, and saves nothing. Relatedly, when a file holds several diagrams the download saves the one on screen rather than the one under your cursor: the two drift apart while you have unsaved edits, because the preview deliberately holds still until you save (#60)
    - **Exporting twice in a row no longer opens two save dialogs.** A second export starting while the first is still running is now ignored, instead of launching a second compiler run and stacking another dialog — offering the same default filename — on top of the one already waiting for an answer (#60)
    - **Switching to the diagnostic view no longer flips back to the diagram.** Toggling while a diagram was still being drawn let the finished drawing arrive afterwards and take the panel back with it, so the report you asked for appeared and then vanished. Whichever view you switched to now stays (#62)
    - **Export commands report honestly whether they have finished.** An export told the editor it was complete the moment it started, so the progress indicator cleared while the compiler was still running and the file was not yet written (#54)
    - **Update checks survive a clock change when the extension manages your compiler.** If your machine's clock was ahead when a check was recorded — or was later corrected backwards — the extension read the next check as permanently not-yet-due and stopped looking for new compiler releases, silently and potentially for weeks (#53)

### v1.7.0 (2026-08-10)
- Leader: Sébastien Mosser
  - Features:
    - **The lightbulb now fixes what it reports:** Where the editor flags a problem it knows how to repair, `⌘.` offers to do it. Write the declaration a template's `@support` demands — with the right qualified id and the label it refines, which is the fiddly part — or write all of them at once. Correct an override declared with the wrong keyword, a mistyped operator, or a config key the operator does not understand. Fill in a required config key, including on a composition that has no config block yet. Wire up a conclusion or strategy that nothing supports. Point a broken `load` at the file it most likely meant, or remove it
    - **Add the `load` you forgot:** Reference a template that lives in another file and the editor offers to import it, naming the file it found — with the `as` alias when you referred to it through one, so the reference actually resolves afterwards. Writing `implements Base` before loading the file that defines it is the ordinary way round to work, and until now the completion popup was the only thing that would add the `load` for you — a name typed by hand never got the offer
    - **Auto-indent and align:** Lay a file out the way the reference examples are written — nesting by braces, and each run of declarations padded so its ids and its `is` keywords start in the same column, with relations lined up on their supporters the same way. A body then reads down its columns instead of along its lines, which is what makes a large argument scannable. Available from **Source Action…** and the command palette, and offered only when it would actually change something. It rewrites lines and never moves anything between them: comments stay beside what they describe, blank lines stay where you put them (they are how a body is divided into sub-arguments), and a model written on one line comes back on one line, correctly indented. Deliberately not wired to Format Document, so a format-on-save setting you keep for another language cannot re-space your models without being asked
    - **Organize loads:** Sort and de-duplicate the `load` statements at the top of a file, from **Source Action…** or the command palette. It runs only when you ask: it is deliberately kept out of the standard organize-imports category, so an on-save setting you keep for another language will not quietly reorder your models. It never removes a `load` whose path does not resolve: a half-typed path is exactly the state a file is in while you are writing one
    - **Every refactoring has a name you can search for:** Converting a model, sorting its elements and extracting a template are each in the command palette under *jPipe*, as well as in the lightbulb and the right-click Refactor menu — so none of them depends on knowing a shortcut
    - **Reshape a model:** Convert a justification to a template and back — a conversion that would drop `@support` elements says how many before you accept it. Sort a model's declarations into the order the argument reads — the conclusion first, then down through what supports it, following each branch to its ground before starting the next, and putting a blank line wherever a new sub-argument begins. Or extract a template out of a justification, turning its evidence into the slots an implementer fills
    - **Only the models worth composing are suggested:** Filling in a composition's sources no longer offers the model you are defining — composing something out of itself is circular, and its name was sitting at the top of the list — nor any model already named in the same call. Both still work if you write them by hand; they are just not proposed
    - **Pick an operator, get the whole invocation:** Completing `assemble` or `refine` now writes the full call — its source models, named in order, and the config keys it cannot run without — laid out the way the examples are, with the shape shown in the popup before you accept it. The name on its own left you to look up how many models it takes, which keys are required, and the fact that an empty `{}` does not parse
    - **`unifyBy` completes:** Typing inside its quotes lists the relations available — the one jPipe ships marked as core, anything you declared marked as yours, so it is clear which the editor knows exists and which it has merely been told about
    - **A mistyped unification method no longer passes unnoticed:** `unifyBy` takes the name of an equivalence relation, and a name nothing registers fails the build. The editor now warns — a warning, not an error, since your build may register relations it has never heard of — and offers the names it knows. Declare your own under *Additional Unification Methods* and the warning stops, without a reload
    - **Help with `refine`:** The `hook` value now completes with the elements of the model being refined, showing each one's label. It was previously a plain string with nothing to suggest it, so the only way to find a legal value was to open the other model and read it
    - **Compositions are checked before you build:** Passing the wrong number of models to an operator is now reported in the editor. `refine` needs exactly two; previously `refine(a)` looked fine until the compiler rejected it
    - **An excluded file says so, and offers to come back:** Opening a file that jPipe is not validating now shows a line above the first line telling you why it is quiet — and clicking it stops excluding whatever is responsible, whether that is the file itself or the folder holding it. The Explorer badge only helps if you happen to be looking at the Explorer; open a counter-example from a search result or a `load` and the absence of squiggles is indistinguishable from a model that is simply correct
    - **Settings are one click from the preview:** A gear in the preview toolbar opens the jPipe settings, filtered to this extension — no need to know the identifier the Settings search wants
  - Bug Fixes:
    - **A failed compile says what went wrong.** When the compiler reports a problem but still manages to draw something, the preview used to signal it with nothing but a reddish tint behind the diagram — which told you *something* had happened without telling you the picture in front of you was no longer the whole truth. There is now a banner instead, like the unsaved-changes one, saying whether it was your model or the compiler that failed and that the diagram below is only what could still be drawn, with a button that takes you straight to the diagnostic view for the reasons. The tint is gone, so the diagram is easier to read than it was
    - **The preview's banners are legible whatever your colour vision.** They no longer set their text in the same colour their background is tinted with, which had left every one of them below the recommended contrast minimum — the unsaved-changes banner reached 2.4:1 on a light theme, against a floor of 4.5. The text now uses the editor's own foreground, at 7:1 or better in every shipped theme. And the two banners open with different symbols rather than being the same banner in amber and red, which is the pair hardest to tell apart with a red-green colour deficiency — and, it turns out, faint enough that nobody was telling them apart by colour anyway. Each also announces itself to a screen reader now
    - **Templates are readable in a dark theme.** Two things made them hard to read, and both came of the compiler drawing for a white page. A model that implements a template puts the inherited part on a pale yellow panel, and in a dark theme everything drawn over it is light — so that whole region came out washed out: sub-conclusions worst of all, an unfilled box being exactly what they are, but the abstract supports, the arrows between them and the region's own caption too. Separately, an `@support` is a dotted outline and a label and nothing else, and that outline was black, which on a dark background meant the label floated with no box around it at all. The panel is now a translucent wash and an unfilled outline follows your theme, so a template reads in the dark while keeping the shapes and colours that tell its elements apart
    - **The diagnostic view's controls stay on the right.** Copy, Report, Text and JSON slid from the right of the header over to the left edge the moment you switched to Text or JSON, and sat there from the outset for a report from a compiler with no structured output — both cases hide the tab strip those buttons were being spaced away from
    - **A half-written declaration is flagged where you are writing it.** Typing `evidence` and pausing put a red squiggle on the *next* line, blaming a line you had already finished, and explained itself as `Expecting token of type 'is' but found 'c'`. The marker now sits at the end of what you have written, and the message names what you are writing and how it finishes: *Unfinished evidence: expected a name after 'evidence'. Write it as `evidence <name> is "<label>"`.* An empty model or config block says so plainly too
    - **The diagnostic view follows the file you are in.** Moving to another model left the previous file's report on screen, looking like a current one — the view followed your cursor but never noticed it had crossed into a different file
    - **No more error popup while typing a model.** Adding support to an element could produce an edit pointing at a line the file did not have yet — which happened whenever the last line was the one being written, and which the editor reports rather than ignores. Insertions now anchor to a point that exists, and stay inside the model's braces
    - **The outline survives a half-written declaration.** Typing `justification ` or `evidence ` raised a "Request textDocument/documentSymbol failed — name must not be falsy" popup, once per keystroke, and emptied the Outline view while it did: a declaration has no name until you type one, and the editor rejects the whole response if any symbol in it is nameless. Something without a name is now simply not listed yet
    - **Two elements sharing an id are now reported.** The compiler rejects it, but the editor stayed quiet — and the model still parses, so a relation naming that id silently resolves to one of the two and the argument means something other than what it reads as
    - **`unifyBy` and `unifyExclude` are no longer flagged as errors.** Both are read by the compiler on every composition, but the editor accepted them nowhere — so a model that builds cleanly carried a red squiggle. They are now offered by completion as well
    - **Renaming a model now reaches everywhere its name is written.** Renaming a justification or template used to rewrite its uses and silently leave the declaration behind — and it never touched the places where its name is *part* of another name: the `T:abs` of every override refining it, and every relation naming one. A rename that stopped there left a file that still parsed and no longer meant anything. All of them are now rewritten, in every file that loads the model, and an `as` alias is kept rather than swallowed — `implements lib:T` becomes `implements lib:NewName`, not `implements NewName`. Renaming from a `load`'s alias is refused rather than quietly renaming the template instead
    - **Renaming an element works from the line declaring it, and carries downstream.** Renaming an element only worked from a `supports` relation naming it; on its own declaration the editor said it could not be renamed at all. Either works now. And renaming an element of a template — an `@support` above all, since every implementer is obliged to restate it — rewrites all of them: the overrides that repeat the name and every relation naming one, in every file that loads the template and through an `as` alias where one is used. Renaming an override where it is restated is declined instead, saying which template the name came from and that renaming it there brings the overrides with it — the editor's own "cannot rename" left you to work that out
    - **A config key the compiler ignores is now a warning, not an error.** It no longer claims a build will fail when it will not
    - **A `load` added for you lands in the right place.** On a file opening with a `/* … */` header — as the jPipe examples do — it was inserted above the header rather than below it
    - **Excluded paths are dimmed as soon as you open the window.** The `⊘` badge and the greying only appeared once you opened a `.jd` file, so a fresh window showed an Explorer where nothing looked excluded — the extension had not started yet, because it only ever woke on a jPipe file being opened. It now wakes when the workspace contains one. The right-click Exclude/Include entries and the Problems panel were held back by the same thing

### v1.6.0 (2026-08-10)
- Leader: Sébastien Mosser
  - Features:
    - **Jump to actual size:** Clicking the zoom percentage in the preview toolbar — or pressing `1` — shows the diagram at 100%, the size the compiler laid it out for. Useful on a large model, where the preview opens zoomed out to fit and you want a readable size in one click. The fit button, and `0`, still return you to that opening view
    - **Your trackpad behaves like a trackpad:** Two-finger scrolling now pans the diagram and pinching zooms it, which is what those gestures do everywhere else. A mouse wheel still zooms, as before. Previously every scroll gesture zoomed, which was fine with a wheel and unpleasant on a laptop
    - **Fit to window really fits:** The fit button now enlarges a small diagram to fill the panel, instead of stopping at 100% — which is what the button says it does, and what you are asking for by clicking it. The view the preview *opens* at is unchanged: it still caps at the diagram's own size, so a four-node justification does not start out filling a wide panel
    - **Zoom sensitivity is adjustable:** A new preview setting controls how far each scroll step zooms, for pointing devices that feel too fast or too slow
    - **A diagnostic view you can explore:** The diagnostic view is no longer one long wall of text. Problems, models, symbols and the command trace each get their own filterable table, with the counts on the tabs and sections that hold nothing greyed out. Click a problem or a symbol to jump straight to the line it names — including into a file your model only `load`s, or, for an element the compiler synthesized, to the composition that produced it. Macro expansions in the command trace are folded away, so a trace of hundreds of steps shows the handful of commands you actually wrote, with the rest one click away. Models list the template they implement and the models implementing them, which is the inheritance picture the old text buried in two separate sections. The symbol table follows your cursor as you move through the file. Where you were reading — the tab, the filter, the macros you opened, how far you had scrolled — survives a save. The compiler's own text report is still one click away, alongside the raw JSON. This needs compiler 2.4.0 or newer; with an older one the view shows the same text report as before, unchanged and with no error
    - **No more logo in the diagnostic view:** The diagnostic report no longer begins with the compiler's eight-line ASCII banner

### v1.5.0 (2026-08-09)
- Leader: Sébastien Mosser
  - Features:
    - **Pan and zoom that actually work:** Scroll to zoom and drag to move around — or pinch on a trackpad. Zooming now homes in on wherever your pointer is, and runs from a quarter of the diagram's own size up to four times it. That range used to be measured against whatever the panel had shrunk the diagram to, so a large justification could be magnified to three times an already-illegible size and no further — and whatever you did manage to magnify was clipped off the edge of the panel with no way to reach it. Hold Shift while scrolling to pan instead of zoom
    - **Keyboard navigation:** The diagram is a tab stop, and arrow keys pan it — hold Shift to move a screenful at a time. `+` and `−` zoom, `0` fits to window
    - **100% now means the diagram's own size:** The preview opens at the size the compiler laid the model out for, and only shrinks it when it is too big for the panel — a four-node justification no longer fills a wide panel at cartoon size. The reset control (the `0` key, the fit button, or clicking the percentage) returns you to exactly that view, and the `+` and `−` buttons step out from it
    - **Readable in dark themes:** Diagrams are drawn straight onto the editor background instead of on a white sheet, so panning feels like moving a canvas rather than shoving a page around. Node colours are untouched — they carry meaning — while the connecting arrows, and the labels of sub-conclusions, follow your theme so they stay legible. Sub-conclusions keep their outlined shape rather than gaining a background, since that outline is what tells them apart from everything else in the diagram
    - **Your view survives a save:** Zoom in on one corner of a large model, save the file, and the preview stays where you were looking instead of jumping back to the whole picture. It re-fits only when you move to a different diagram, and it holds its place across a trip to the diagnostic view and back
    - **An overview map for large models:** Once you are zoomed in, a small map of the whole diagram appears in the corner showing which part you are looking at; drag the box on it to jump somewhere else. It stays out of the way whenever the whole diagram already fits on screen
    - **The preview follows your cursor:** With highlighting turned on, putting the cursor on an element that has scrolled out of sight now brings it into view, instead of dimming everything around something you cannot see
    - **No more flicker:** Re-rendering no longer blanks the panel — the diagram stays on screen while the compiler runs, and a model that fails to compile leaves the last good picture up rather than replacing it
    - The Download menu is hidden in the diagnostic view, where there is no diagram to export
  - Bug Fixes:
    - Moving the cursor outside a diagram block no longer raises a background error on every keystroke
    - Preview toolbar tooltips appear below their buttons; they were previously drawn above, off the top of the panel, where they could never be seen
  - Maintenance:
    - The preview's interactive code moved into its own type-checked bundle, with the view geometry covered by unit tests, and the panel now runs under a content security policy (development-only; nothing you do in the editor should behave differently)

### v1.4.0 (2026-08-07)
- Leader: Sébastien Mosser
  - Features:
    - **Glob patterns in `load`:** The compiler accepts patterns such as `load "models/*.jd"`, and so does the editor — no more spurious "cannot resolve load path" on a line that builds cleanly. Templates pulled in by a pattern resolve for completion and `implements` just like a single file, and `as` puts every matched file under the one namespace. A pattern may also reach a sibling directory (`load "../library/*.jd"`) or an absolute location, exactly as a single-file path can. Note that `**` follows Java's rules, as the compiler does: `models/**.jd` matches every depth *including* the top level, while `models/**/*.jd` matches nested files only
    - **See what a pattern matched:** Hover a glob to get the list of files it resolved to, each a link you can click through to. Patterns that match nothing, are malformed, point at a directory that does not exist, or would load the file they are written in are all reported in the editor with the same wording the compiler uses, so a model that will not build says so before you build it
      > Requires a compiler newer than 2.3.0 for patterns that leave the declaring file's directory. Against an older compiler the editor will accept `../library/*.jd` while the build still rejects it
    - **Truly silent exclusions:** What you exclude from validation now produces no errors *and* no warnings — previously every file in an excluded folder still reported "this file is in an excluded directory". A folder of deliberately-broken counter-examples no longer fills the Problems panel, which is what compiler developers need
    - **Exclude a single file, not just a folder:** A lone counter-example living among good models can be silenced on its own, without excluding everything around it
    - **You can see what is excluded:** Excluded items are dimmed and marked with a `⊘` badge in the Explorer, on editor tabs and in Open Editors — so a file that isn't being checked always says so, without costing you a diagnostic. Only `.jd` files and the folders holding them are marked; a README sitting next to your counter-examples is left alone
    - **Right-click to exclude:** Exclude a folder or a `.jd` file straight from the Explorer, or from the editor's jPipe menu, and put it back the same way. A new "Remove Excluded Path" command drops an entry without hand-editing your settings
    - **Changes apply immediately:** Excluding or re-including something now takes effect at once — the "reload the window to apply" step is gone
  - Changed:
    - The "Excluded Directories" setting is now **"Excluded Paths"**, since it accepts individual files as well as folders. Your existing setting keeps working and needs no migration; it is simply shown as deprecated
  - Bug Fixes:
    - **Windows: the compiler is found again.** Previewing or exporting a diagram failed with `spawn jpipe ENOENT`, even though `jpipe` ran fine in a terminal. Windows can only start `.exe` files directly, and jPipe installs as a `.cmd` shim (via Scoop), which was therefore invisible to the extension. It is now located the same way Windows locates it, and run without handing your file paths to a command interpreter
    - A blank entry in the exclusions setting no longer silences validation for the entire workspace
    - Exclusions are re-resolved when workspace folders are added or removed
  - Maintenance:
    - **Only reviewed code can be published:** A release can now only be built from the project's main line of development. Previously nothing stopped a release built from an unreviewed branch from reaching the Marketplace, so this tightens what can end up in the extension you install
    - **Releases are cut by script:** Preparing a release — keeping the version numbers, the changelog and the dependency lockfile in step, then re-running the publication checks before anything is tagged — is now one command instead of a hand-followed checklist. A release can no longer go out half-versioned (development-only; nothing that ships to users changes)
    - The toolchain used to build the extension is now pinned and enforced, so what a contributor builds matches what CI publishes. Both test suites also run in CI ahead of packaging, so a failing test blocks the release rather than shipping alongside it
    - **Now requires VS Code 1.91 or newer** (June 2024) — older editors are no longer supported. This is what lets the extension move to the current versions of the language engine and the editor-integration libraries it is built on
    - Updated those libraries. Nothing you do in the editor should behave differently; the one visible change is that the jPipe Language Server output panel now has a log-level filter of its own
    - Cleared three security advisories in the extension's dependencies

### v1.3.0 (2026-07-16)
- Leader: Sébastien Mosser
  - Features:
    - **No-install setup:** You can now let the extension fetch and update the jPipe compiler for you, straight from GitHub Releases — no manual JAR downloads. Pick a version from a list that shows each release's date. Especially handy on Windows (closes #13)
    - **Choose how the compiler runs:** A single "execution mode" setting lets you use a `jpipe` command on your PATH, point at your own JAR, or let the extension manage it — with clearer messages when the compiler is missing or misconfigured
    - **Automatic update checks:** In managed mode the extension can check for newer compiler releases on a schedule you control, and optionally include pre-releases
    - **Better environment control:** New settings for a compiler timeout, extra Java (JVM) arguments, and additional folders to search for tools like `python3` and `dot` when they aren't on your PATH
    - **One-click export:** A new "Export" command uses your preferred format and can open the result automatically. Added JPEG, DOT, Python, and JPIPE to the download options
    - **Installation check** now tells you which compiler it's actually using
    - **Tidier settings page:** Options are grouped into clear sections — Compiler, Managed Compiler, Export, Validation, and Logging
  - Bug Fixes:
    - Hardened how the compiler is launched (no shell-injection, correct PATH handling, validated download source) and made update checks apply only in managed mode, with correct pre-release handling
    - Removed a couple of icons that weren't rendering next to settings links
  - Documentation:
    - Corrected the version-bump steps in the README so releases no longer hit an npm 404
  - Maintenance:
    - **Now requires VS Code 1.85 or newer** (November 2023) — older editors are no longer supported
    - Refreshed the build and test toolchain and cleared several security advisories in it (development-only; nothing that ships to users was affected)
    - Removed an unused dependency to keep the download smaller

### v1.2.0 (2026-07-15)
- Leader: Sébastien Mosser
  - Features:
    - **Language Server:** Surface unresolved `load` paths as diagnostics instead of failing silently
    - **Language Server:** Go-to-definition on a `load "..."` path navigates to the loaded document
    - **Extension:** Replace the diagnostic-view toolbar icon (magnifying glass → clipboard) to avoid confusion with the adjacent zoom controls
  - Bug Fixes:
    - **Language Server:** Resolve `load` imports via `URI.fsPath` so they work on Windows (drive-letter paths were malformed under `URI.path`, silently breaking imports and cross-references)
    - **Extension:** Diagnostic-view toggle no longer freezes when a render fails — resolve the document before switching modes and retain last-good render metadata on error
    - **Extension:** Add a 30s timeout to CLI/JAR invocations so a hung compiler can't freeze the preview panel

### v1.1.1 (2026-05-08)
- Leader: Sébastien Mosser
  - Features:
    - **Extension:** Route compiler errors to the jPipe output channel instead of notification popups
    - **Extension:** Gate the output-channel reveal on the configured `jpipe.logLevel` (panel no longer opens with no visible message)

### v1.1.0 (2026-04-28)
- Leader: Sébastien Mosser
  - Features:
    - **Language Server:** Implement qualified names, hierarchical outline, and namespace-aware scoping
    - **Language Server:** Remodel composition operators with proper grammar, scope, and completion
    - **Language Server:** Improve completion for `supports` relations, operator calls, and load paths
    - **Language Server:** Redesign outline with namespace grouping; prefix inherited elements with their source template id
    - **Language Server:** Semantic token provider with 5 keyword groups and TextMate scope fallbacks
    - **Extension:** Add `jpipe.excludedDirectories` setting to suppress validation in selected directories
    - **Extension:** Lock preview panel group using the tabGroups API
    - **Extension:** Grouped context menu, hover labels, shield logo, and export fallback
    - **CI/CD:** Overhaul pipelines with deduplication and automated release
  - Bug Fixes:
    - Restore last diagram when switching back from diagnostic mode
    - Fix silent early return in `updatePreview` when cursor is outside any diagram
    - Fix panel lock via resolved `viewColumn`; pass diagram name on fallback export

### v1.0.2 (2026-04-26)
- Leader: Sébastien Mosser
  - Bug Fixes:
    - Fix broken URL in README
    - Fix inconsistent version numbers across `package.json` files
  - Documentation:
    - Document version bump procedure in README

### v1.0.1 (2026-04-26)
- Leader: Sébastien Mosser
  - Contributors: Andrew Bovbel
  - Features:
    - **Grammar:** Migrated Langium grammar to match ANTLR grammar parity
    - **Grammar:** Support namespace-qualified `implements` with correct override validation
    - **Grammar:** Convert `Relation` `from`/`to` from qualified identifiers to cross-references
    - **Grammar:** Bumped to Langium 4.2
    - **Language Server:** Import scoping for `load` statements (transitive, BFS-based)
    - **Language Server:** `implements`-chain scoping for relations in justifications and templates
    - **Language Server:** Improved completion for nodes with labels and recursive file loading
    - **Language Server:** Structured logging with configurable log level
    - **Extension:** Overhauled image generation pipeline and preview panel
    - **Extension:** Diagnostic view toggle in the preview panel
    - **Extension:** Zoom controls via toolbar buttons and `+`/`-` keys
    - **Extension:** Preview panel diagram button and reopen fix
  - Bug Fixes:
    - Fix multi-level override validation for inherited abstract supports
    - Fix SVG node highlighting to use id-based lookup (not label)
    - Fix infinite loading loop when resolving transitive imports
    - Fix error notifications with reload on generation failure

### v0.2.10 (2025-06-21)
- Leader:  Sébastien Mosser
  - Features:
    - New compiler release
    - Add export format (dot, jpipe, runner)
    - slightly change graphical rendering (using different shapes and not only colors)

### v0.2.9 (2025-03-05)
- Leader: Cass Braun
  - Features:
    - Added go to definition from SVG
    - Updated composition in langium grammar

### v0.2.8 (2025-03-05)
- Leader: Sébastien Mosser
  - Features:
    - Fixing path issues for Windows
    - Added goToDefinition from SVG to textEditor

### v0.2.7 (2025-02-24)
- Leader: Cass Braun
  - Features:
    - Added ability to activate and deactivate installation checks on startup for Java and GraphViz
    - Added instruction description on code completion prompt
    - Fixed error with conclusion validation when justification implements pattern
    - Added QuickFix to add blank @support statement to pattern
    - Added QuickFix to add blank conclusion into pattern
    - Added validation for conclusion in pattern
    - Added completion support for variables loaded from other files
    - Added ability to set java version in settings

### v0.2.6 (2025-01-29)
- Leader: Sébastien Mosser
  - Features:
    - Support file path coming from windows

### v0.2.5 (2025-01-29)
- Leader: Sébastien Mosser
  - Features:
    - Fix path issues when they contain space (bugfix issue #99)

### v0.2.4 (2025-01-20)
- Leader: Sébastien Mosser
  - Features:
    - Fix dependencies vulnerabilities
    - Update to latest version of Langium

### v0.2.3 (2025-01-20)
- Leader: Cass Braun
  - Features:
    - Added ability to activate and deactivate installation checks on startup for Java and GraphViz
    - Added QuickFix to remove implemented element of justification, pattern, and composition when there is incorrect syntax
    - Added validation to throw error when there is no conclusion found in a justification diagram
    - Added QuickFix to add a conclusion to a justification diagram
    - Added GoToDefintion for load statements
 
### v0.2.2 (2024-08-13)
- Leader: Cass Braun
  - Features:
    - Added QuickFix to change justification to pattern if it includes an instruction labelled @support
    - Added QuickFix to change pattern to justification if it includes no instruction labelled @support
    - Added QuickFix to remove support statement line if it's instruction types do not match
    - Added QuickFix to add relative load statements for unresolved references
    - Added support for relative load statements
    - Added validation for declaration implementation rules

### v0.2.2 (2024-08-06)
- Leader: Cass Braun
  - Features:
    - Added patterns and compositions to grammar with basic language support
    - Added improved completion for justification diagrams and compositions
    - Added basic quick fix

### v0.2.0 (2024-07-19)

  - Leader: Cass Braun
  - Features:
    - New language server using Langium instead of LEVER
    - Downloading files with right click, as PNG or SVG
    - Configuration settings to select which JAR file to be used


### v0.1.0 (2024-04-20)

  - Leader: Nirmal Chaudhari
  - Features:
    - Language server for jPipe, using LEVER
    - VS Code extension with syntax highligthing
    - Preview of diagrams
