# ADR-VSC-0024: Laying a model out is a formatter, not a source action

**Date:** 2026-08-14
**Status:** Accepted

## Context

Laying a `.jd` file out in the house style — nesting by braces, and each run of declarations padded
so its ids and its `is` keywords start in the same column — shipped in v1.7.0 as a **source code
action**, `source.jpipe.autoIndent`. The algorithm lived, and still lives, in `jpipe-layout.ts` as a
pure function over a document; the code action was a 35-line wrapper around it.

That wrapper carried the reasoning for the choice in its header, and the reasoning was deliberate:

> Its kind sits under `source.jpipe.` rather than being a formatting provider, for the same reason
> `organizeLoads` avoids `source.organizeImports`: `editor.formatOnSave` is a setting people carry
> across every language they use, and re-spacing someone's argument the moment they hit save is a
> decision they should make deliberately for this language, not inherit from another.
>
> It also means the action is only ever offered when it would change something, which a formatting
> provider cannot express — `Source Action…` on an already-tidy file simply does not list it.

Both halves are true. What they left out is the cost on the other side. `⇧⌥F` is the gesture every
VS Code user already has for "lay this file out", and on a `.jd` file it did nothing at all — no
formatter was registered, so the editor reported that none was available. The feature existed, and
the one motion that would have found it was the motion that failed. Discovering it instead required
knowing that **Source Action…** exists, which is a menu most users have never opened, or knowing
the command by name.

The record was never written as an ADR, so the decision lived only in a source comment on a file
that this change deletes.

## Decision

**The layout is bound as `lsp.Formatter`. The `source.jpipe.autoIndent` code action is removed.**

There is one route, not two: `Format Document`, `Format Selection`, and `editor.formatOnSave` all
run `jpipe-layout.ts`. The `jpipe.autoIndent` command survives with its id intact and now delegates
to `editor.action.formatDocument`, so a keybinding anyone already has keeps working.

Three points settled along with it:

- **The indent unit follows the editor** (`tabSize` / `insertSpaces`), falling back to the house
  four spaces. **The column padding does not** — it stays spaces whatever the setting, because a
  tab advances to the next tab stop rather than by a width and so cannot line anything up. Tabs to
  indent, spaces to align.
- **Format Selection formats the selected lines**, by laying out the whole document and dropping
  the edits outside the range. Langium advertises `documentRangeFormattingProvider` from the same
  service binding, so the menu entry exists whether or not it is given a meaning, and an entry that
  silently does nothing is worse than one that works.
- **Format-on-type is not offered.** `formatOnTypeOptions` returns `undefined`.

This ships as a **patch** release, not a minor one. Nothing here is a new capability: the layout
existed and did the same work, in a menu that was the wrong place for it. What changed is where the
editor looks for it.

`JpipeFormatter` implements Langium's `Formatter` interface rather than extending
`AbstractFormatter`. The abstract base builds edits by declaring what whitespace sits between one
token and the next; the house layout is defined as much by what it refuses to move — a blank line,
a trailing comment, a model written on one line — and those refusals are not expressible as token
spacing.

## Rationale

- **A formatter is what this is.** It takes a document and returns the same document laid out. The
  previous packaging was a workaround for a consequence of the packaging, not a description of the
  thing.
- **The opt-out exists and is per-language.** `"[jpipe]": { "editor.formatOnSave": false }` is one
  line, it is the same line users already write for other languages they do not want reformatted,
  and it is discoverable in a way that "name this code action kind in `editor.codeActionsOnSave`"
  is not. The v1.7.0 reasoning protected users from a setting they had chosen, at the price of
  hiding the feature from everyone who had not.
- **"Only offered when it would change something" was worth less than it looked.** It is a real
  property, and it is the one thing genuinely lost here — but its beneficiary was a user already in
  the **Source Action…** menu, who is not the user this feature was failing.
- **Keeping both was considered and rejected.** Two routes to one edit is two things to keep in
  step, two places a change to the layout has to be re-verified, and a `Source Action…` entry that
  duplicates `⇧⌥F` without saying so. A test in `server-capabilities.test.ts` now asserts no
  advertised kind starts with `source.jpipe.autoIndent`, so the pair cannot quietly return.
- **This does not cross the package boundary ADR-VSC-0002 warns about.** A formatter needs no
  client-side registration; binding the service is the whole of it. The extension's only change is
  the command's target and a `defaultFormatter` default.

## Consequences

- **A format-on-save setting kept for another language now applies to `.jd` files.** This is a
  behaviour change against what v1.7.0 promised in writing, it is the point of the change, and the
  changelog says so plainly and names the opt-out.
- **`Format Document` on an already-tidy file is a no-op** rather than an absent menu entry. The
  formatter still returns no edits, so nothing is rewritten and no undo entry appears — but the
  editor no longer tells the user, by omission, that there was nothing to do.
- **Format Selection had to be given a meaning**, and the meaning is not "lay out these lines in
  isolation". Column widths are a property of a run, so a selection of three lines out of a run of
  six is padded to the run's widest id. Laying the range out on its own would split the run down
  the middle, which is why the implementation filters rather than scopes.
- **The layout is no longer unconditionally four spaces.** A `.jd` file edited with `tabSize: 2`
  now lays out at two, and the reference examples' convention is a default rather than a rule. A
  project that wants the house style everywhere sets it in `.editorconfig` or in workspace
  settings, as it would for any other language.
- **`source.jpipe.organizeLoads` is untouched, and its reasoning still stands.** The
  organize-imports argument was never the same argument: `source.organizeImports` is a *specific
  well-known kind* that on-save settings name directly, whereas format-on-save is the general
  gesture for "lay this out", which is exactly what the layout does and is not what reordering
  `load` statements does.
- **The parse-error guard is now load-bearing in a new way.** `layoutEdits` declines on a file that
  does not parse, which as a code action meant "not offered" and as a formatter means "saving a
  half-typed file leaves it alone". That is the right behaviour, and it is now reached on every
  save rather than only when asked.
