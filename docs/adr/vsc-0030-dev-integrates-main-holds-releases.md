# ADR-VSC-0030: `dev` integrates, `main` holds releases

**Date:** 2026-11-15
**Status:** Accepted

## Context

jpipe-vscode ADR-VSC-0012 made `main` the only long-lived branch. Work came back to it by pull
request, but the release commit did not: `scripts/release.sh prepare` committed it directly on
`main`, which is why branch protection on `main` was left bypassable by admins. That record named
routing the release through a pull request as the cleaner design, and deferred it.

The `jpipe-mcscert` organisation has since adopted one workflow for its repositories, described
in its [contributing guide](https://github.com/jpipe-mcscert/.github/blob/main/CONTRIBUTING.md):
`main` holds released code, `dev` is the integration branch and the default branch on GitHub,
work branches are cut from `dev` and come back to it by pull request, and a release is a pull
request from `dev` into `main`, merged and tagged by a maintainer. The guide exempts only
repositories that users install straight from their default branch.

## Decision

This repository follows the organisation's workflow, and states here only what is specific to it.

`scripts/release.sh prepare X.Y.Z` runs on a work branch cut from `dev` and refuses `main` and
`dev`. The release commit reaches `dev` by pull request, then `main` through the `dev` → `main`
release pull request. Once that has merged, a maintainer runs `scripts/release.sh preflight X.Y.Z`
on `main` and pushes the `vX.Y.Z` tag. `release.yml` still refuses a tag that is not on `main`.

A hotfix, in the organisation's sense, is prepared with `scripts/release.sh prepare --hotfix X.Y.Z`
on a fix branch cut from `main`. The branch must contain `main`, must not carry the unreleased
work of `dev`, and comes back into `main` through its own pull request; `main` is merged back into
`dev` after the tag.

`build.yml` runs on pushes to `main` and `dev` and on every pull request. `sonar.yml` runs on
every pull request and on pushes to `main`.

## Rationale

- One workflow across the organisation means a contributor, or an assistant, moving between
  repositories does not have to learn which one works which way. ADR-VSC-0012 rejected `dev`
  because, for this repository alone, it added a merge step without a question it answers; the
  question is now consistency, and it is answered at the organisation level.
- The release commit now goes through a pull request like every other change, which is the design
  ADR-VSC-0012 preferred and deferred. Its cost — a change to `release.sh`, to the README's
  release section, and to the habits of the person who cuts releases — is paid here.
- The main-only exemption does not apply. This extension reaches users from the Marketplace, and
  only on a tag; nobody installs it from the default branch, so `dev` cannot ship unreleased work.
- The tag check in `release.yml` stays keyed on `main`, not `dev`: `main` is still what is released.
- `dev` is not analysed on push. The SonarQube Cloud plan analyses the main branch and pull
  requests, not a second long-lived branch; every change reaches `dev` through a pull request
  that is analysed, and `preflight` checks the gate on `main` before the tag.

## Consequences

- A release takes two pull requests: the release commit into `dev`, then `dev` into `main`.
- The release no longer needs to bypass protection on `main`. Whether admins keep that bypass is a
  repository setting, which this record does not change.
- `dev`'s own quality is known only through the pull requests into it. A change pushed to `dev`
  without one is built but not analysed, and the gap shows up at the release pull request.
- Dependabot opens its pull requests against the default branch, so dependency updates now land
  on `dev` and ship with the next release, not on their own.
- `prepare` fails on a work branch that does not contain the current `dev`, so a release cannot
  silently leave out something already merged. With `--hotfix` the same check is made against
  `main`, so a patch cannot ship what `dev` holds, and the script stays the only way to move the
  version (jpipe-vscode ADR-VSC-0008).
