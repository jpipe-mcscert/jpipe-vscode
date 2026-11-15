# ADR-VSC-0027: The same jPipe items, wherever a model is right-clicked

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

Not everything on that menu is used alike, though. Opening the preview and excluding a file are
single actions, reached for often; behind a submenu each costs a second step. The export formats
are a list of seven that grows, and a list is what a submenu is for.

## Decision

Right-clicking a model offers the same three things in all three places, directly in the menu and
in this order:

1. **Open Diagram Preview**
2. **Export as…**, a submenu, `jpipe.exportAs`, holding one item per format
3. **Exclude from** or **Include in jPipe Validation**, whichever applies

The list of formats is written once, in `jpipe.exportAs`, and every place shows that submenu
rather than listing formats itself. The two commands and the submenu are contributed to each
place, since VS Code has no way to share top-level items between menus.

Their commands accept whichever target they are invoked on — the editor's model at the cursor, a
file from the Explorer (its model, or the one picked when it declares several), or a row's model
— so one item means one action everywhere.

The places keep what is theirs alone: the Explorer's Exclude and Include also apply to a folder,
which is not a model; and Models rows have the actions about the row's model in the workspace —
Run, New Justification Implementing This Template…, Scaffold Step Library….

## Rationale

- **The part that grows is the part that is shared.** A new export format is added to one
  submenu and appears in all three places at once. The three top-level entries are fixed, so
  repeating them per place is a cost paid once, and a test holds them equal.
- **Frequent single actions stay one step away.** A submenu around the whole set made the preview
  two steps from a right-click, to keep seven formats out of the way. Only the formats needed
  keeping out of the way.
- **A `when` clause per place handles what differs.** Whether to offer Exclude or Include is
  decided from the file's path in the editor and the Explorer, and from the row's `contextValue`
  in Models, where VS Code sets no path.
- **Commands that read their target are the cost of one meaning.** Each command takes the tree
  node, the file URI or nothing, and resolves it to a model. That is a few lines once, in
  `commands.ts`.

## Consequences

- `test/menus.test.ts` holds the arrangement: each place offers the same three entries in the
  same order, no place lists an export format itself, and Exclude and Include are never offered
  together.
- An action added to a model's right-click must be contributed to all three places, and its
  command must accept a Models row and an Explorer URI as well as the editor's context. The test
  fails when a place is missed.
- Excluding from a Models row excludes the model's file, since validation is per file. The row
  is the file's representative there, as the editor is.
- The editor's context menu has no jPipe submenu: its three entries sit in a group of their own.
