# ADR-VSC-0028: Settings groups are named as a path

**Date:** 2026-11-13
**Status:** Accepted

## Context

The extension drives two tools: the jPipe compiler, behind previews, exports and validation, and
jpipe-runner, behind the ▶ button. Their settings should read as two families, each with its own
groups — a compiler tree and a runner tree.

VS Code's Settings editor gives an extension one level of groups: each entry of
`contributes.configuration` is a category, listed by its `title` under the extension's name. There
is no nesting, so a tree cannot be declared.

## Decision

A settings group is titled as the path it would have in that tree:

```
jPipe › <Tool> › <Group>
```

- **`<Tool>`** is `Compiler` or `Runner`: the tool the settings configure.
- **`<Group>`** names what they are about. Each tool has a `General` group, holding how the tool
  is reached and run; it is that tool's first group.
- Groups of one tool are listed together, the compiler's before the runner's, by the `order` of
  each category.

The groups are:

| Title | Holds |
|---|---|
| `jPipe › Compiler › General` | execution mode, paths, timeout, Java options |
| `jPipe › Compiler › Managed mode` | updates of the compiler the extension downloads |
| `jPipe › Compiler › Export` | default format, opening the result |
| `jPipe › Compiler › Preview` | the diagram preview |
| `jPipe › Compiler › Validation` | exclusions, extra unification methods |
| `jPipe › Compiler › Logging` | the log level |
| `jPipe › Runner › General` | execution environment, runner command, step libraries |
| `jPipe › Runner › Development` | a local copy of the runner, for work on the runner itself |

A new group takes a title of this form under the tool it belongs to. A third tool would add a
third `<Tool>`. `test/settings.test.ts` holds the manifest to it.

Setting identifiers are not part of the convention and do not change with a group's title:
`jpipe.cliPath` stays where users' settings files have it.

## Rationale

- **The title is the only lever.** With one level of categories, the hierarchy can only be
  written into the names. The separator is `›` (U+203A): the one Pylance titles its own groups
  with (`Python › Analysis and Diagnostics`), and the one the Settings editor puts between the
  parts of a setting's name, so a group's title and the settings under it read as one notation. The list, kept in order, shows
  the two families one after the other.
- **Two tools, said first.** A user looking for a setting knows which tool misbehaves before
  knowing which group it is in. Naming the tool second, right after the extension, makes the
  list scannable by that.
- **`General` rather than a bare tool name.** `jPipe › Compiler` beside
  `jPipe › Compiler › Export` would read as a parent and its child, which the editor does not
  render; every title having three parts keeps them siblings in name as they are on screen.
- **Validation and logging sit under the compiler.** Neither is the runner's, and a third family
  for two small groups would cost more in the list than it explains. Validation shares the
  compiler's vocabulary and verdicts (ADR-VSC-0022, ADR-VSC-0023).
- **Identifiers stay.** Renaming a setting silently drops every value users have saved for it. A
  group's title is presentation and can change freely.

## Consequences

- Titles are long, and repeat `jPipe` under the extension's own name in the list.
- The grouping is by convention only: nothing folds, and the editor's search and "modified"
  filters know nothing of the two families.
- Should VS Code offer nested categories, the titles map onto them directly, and this record is
  superseded.
