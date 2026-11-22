# ADR-VSC-0008: A four-place version, moved only by the release script

**Date:** 2026-08-10
**Status:** Accepted

## Context

Because the extension pins `jpipe-language` to an exact version rather than `workspace:*` (see
jpipe-vscode ADR-VSC-0002), the release version lives in **four** places that must agree:

1. the root `package.json`
2. `packages/language/package.json`
3. `packages/extension/package.json`
4. the `jpipe-language` dependency pin *inside* `packages/extension/package.json`

Getting this wrong is not a build failure. It packages and publishes a VSIX whose manifest
disagrees with itself, and the discovery point is a user's editor.

Doing it by hand is worse than it looks. `npm version --workspaces` handles the first three, but
only with `--no-git-tag-version --no-workspaces-update`: without the latter, npm tries to resolve
the still-old `jpipe-language` dependency against the public registry and fails with a `404`,
because that package is workspace-local and has never been published. The dependency pin and then
`package-lock.json` have to be brought into line separately, in that order.

The release workflow itself only validates *after* a tag is pushed — and a public tag is the
awkward thing to undo.

## Decision

`scripts/release.sh` is the only supported way to move the version. It has two verbs and
**neither one tags, pushes, or publishes** — those stay deliberate human actions.

`prepare X.Y.Z` runs on a release branch, `release/X.Y.Z`, cut from `dev` (jpipe-vscode
ADR-VSC-0030): it refuses to start on a dirty tree, on any other branch, on a branch that does not
contain the remote's `dev`,
out of sync with the branch's upstream, on an unpinned Node, if the tag already exists, or if the
changelog has no entries under the named version. It then sets all four versions, reconciles the
lockfile, flips the changelog's `### vX.Y.Z (Unreleased)` heading to today's date, runs
`clean → langium:generate → build → test`, and commits `chore(release): X.Y.Z`. With `--hotfix`
it runs on a fix branch cut from `main` instead, which must contain the remote's `main` and not
the unreleased work of `dev`.

`preflight X.Y.Z` is read-only, and is run on `main` once the release has merged there. It
re-runs what `.github/workflows/release.yml` validates — the four-way version comparison and the
tag being an ancestor of `main` — plus a full clean build, both test suites, and a real
`vsce package`. It ends by printing a manual checklist for the
things CI structurally cannot check.

The remote it validates against is `RELEASE_REMOTE`, defaulting to `origin` and deliberately
**not** derived from `@{upstream}`: "is this commit on main", "does this branch contain dev" and
"does this tag exist" are questions about the canonical repository, and a local branch may track
a fork.

## Rationale

- The four-place invariant is exactly the kind of thing a human gets right nine times. The tenth
  ships.
- Both `release.sh` and `release.yml` check the four-way agreement, deliberately. The script
  catches it before the commit; the workflow catches it before the publish. The redundancy is the
  point — a contributor who bypasses the script still cannot ship a mismatch.
- Refusing to tag or push keeps the irreversible steps human. The script makes a *local commit*;
  everything after that is a decision someone types.
- A single command that also tagged and published was considered and rejected: it collapses
  "prepare a release" and "release" into one keystroke, and the second is not undoable.
- The script mirrors the compiler's `scripts/release.sh`, so the release procedure reads the same
  in both repositories. There is no `post-release` verb here, because npm has no `-SNAPSHOT`:
  nothing needs bumping once a release is out.

## Consequences

- **`check_build` in the script is written to mirror the sequence `release.yml` runs, in the same
  order.** They drift unless changed together: a new step in the release workflow needs a
  counterpart in the script, and vice versa.
- `check_clean_tree` uses `git status --porcelain`, which reports *untracked* files. Any new build
  output — coverage reports, generated artefacts — must be added to `.gitignore` in the same
  change that produces it, or `prepare` and `preflight` both refuse to run.
- `prepare` commits on a release branch, so the release commit reaches `main` through the release
  pull request, and `dev` when `main` is merged back; for a hotfix, by its own pull request into
  `main` (jpipe-vscode ADR-VSC-0030).
- The changelog gates the release: `prepare` refuses if there are no entries under
  `### vX.Y.Z (Unreleased)`. Closing that heading out is the script's job, not a manual edit.
- Node is pinned by Volta and checked by `prepare`. A contributor without Volta gets whatever
  `node` their `PATH` offers, which may not build this project — on Node 26,
  `npm run langium:generate` fails inside `langium-cli`'s configuration validation.
- The manual checklist exists because CI never launches VS Code. Smoke-testing the VSIX in a real
  editor is a human step and is stated as one (see jpipe-vscode ADR-VSC-0004).
