# ADR-VSC-0027: One jPipe menu, wherever a model is right-clicked

**Date:** 2026-11-11
**Status:** Accepted

## Context

A model can be right-clicked in three places: in the editor showing it, on its `.jd` file in the
Explorer, and on its row in the jPipe activity's Models view. Each place had grown its own menu.
The editor had a **jPipe** submenu — preview, every Download as…, exclude from validation. The
Explorer offered only Exclude and Include, directly in its menu. The Models view had its own
preview item and none of the rest, so exporting a model found in the activity meant opening it
first and right-clicking somewhere else.

Three menus maintained separately drift as separately: each new export format, each new action,
has to be remembered three times, and the one forgotten is found by a user looking for it where
it is not.

## Decision

There is one jPipe submenu, `jpipe.submenu`, and it is contributed to all three places: the
editor's context menu, the Explorer's for a `.jd` file, and every model row in Models. Its
commands accept whichever target they are invoked on — the editor's model at the cursor, a file
from the Explorer (its model, or the one picked when it declares several), or a row's model — so
one item means one action everywhere. Anything that belongs on a model's right-click is added to
that submenu, and so appears in all three places at once.

The places keep only what is theirs alone, outside the submenu: the Explorer's Exclude and Include
for a folder, which is not a model; and, on Models rows, the actions about the row's model in the
workspace — Run, New Justification Implementing This Template…, Scaffold Step Library….

## Rationale

- **Sharing the menu, rather than copying it, is what keeps it aligned.** A submenu is one list
  that every place shows; nothing can be added to one place and not the others. Three copies kept
  in step by a test would still have to be written three times.
- **A `when` clause per place handles what differs.** Whether to offer Exclude or Include is
  decided from the file's path in the editor and the Explorer, and from the row's `contextValue`
  in Models, where VS Code sets no path. The submenu's two items carry both conditions.
- **Commands that read their target are the cost of one menu.** Each submenu command takes the
  tree node, the file URI or nothing, and resolves it to a model. That is a few lines once, in
  `commands.ts`, against a menu edited three times.

## Consequences

- `test/menus.test.ts` holds the arrangement: the submenu is in all three places, and every jPipe
  command the Explorer offers for a `.jd` file is reached through it.
- A command added to the submenu must accept a Models row and an Explorer URI as well as the
  editor's context. One that cannot does not belong in the submenu.
- Excluding from a Models row excludes the model's file, since validation is per file. The row
  is the file's representative there, as the editor is.
