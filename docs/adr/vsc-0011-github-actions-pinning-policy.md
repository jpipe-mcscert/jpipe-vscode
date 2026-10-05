# ADR-VSC-0011: GitHub Actions are pinned by major tag

**Date:** 2026-08-10
**Status:** Accepted

## Context

A third-party GitHub Action runs with access to the workflow's environment, including its
secrets. A `uses:` reference is therefore a supply-chain dependency, and how tightly it is
pinned decides what an upstream compromise can do.

There are two coherent policies. Pinning by **major tag** (`actions/checkout@v5`) accepts
whatever that tag currently points at, so upstream fixes arrive automatically — and so would a
malicious retag. Pinning by **commit SHA** (`actions/checkout@34e11487…`) is immutable and
immune to retagging, but freezes the action until someone advances the SHA by hand.

This repository and the compiler both pin by major tag today. When SonarQube Cloud analysis was
being added, the draft workflow arrived SHA-pinned — which would have left one SHA-pinned action
among six tag-pinned ones, in two different workflows.

## Decision

All GitHub Actions in this repository are pinned by **major version tag**, uniformly, in every
workflow.

Dependabot's `github-actions` ecosystem (jpipe-vscode ADR-VSC-0013) proposes the tag moves.
SHA pinning is **not** adopted at this time.

## Rationale

- **A mixed policy is worse than either consistent one.** One SHA-pinned action among six
  tag-pinned ones signals a threat model the rest of the file does not honour, and it invites a
  reader to assume the repository is SHA-pinned when it mostly is not.
- SHA pinning is only a defence while the SHAs are maintained; unmaintained, they decay from
  "pinned to a known version" into "pinned to a version with a known vulnerability", which is
  strictly worse than tracking a maintained major tag. Dependabot would now maintain them, so
  maintenance is **not** an objection to SHA pinning here. What keeps major tags in place is the
  first point: the switch must be made for every action at once, and it has not been made. The
  choice between the two is open, and whoever revisits it should settle it on the threat model
  rather than on maintenance cost.
- The actions in use are all first-party `actions/*` or `SonarSource/*`. That is not a guarantee
  — a first-party account can be compromised — but it materially changes the risk relative to an
  unmaintained third-party action.
- Consistency with the compiler, which pins the same way, keeps one convention across the
  project.
- **Adopting SHA pinning supersedes this record**, and is done for every action in every
  workflow in one change.

## Consequences

- A compromised or retagged upstream action would run in this repository's CI with access to
  `SONAR_TOKEN` and, in the release workflow, `VS_CODE_MARKETPLACE_SECRET`. This is the accepted
  risk, and it is the reason the decision is written down rather than merely followed.
- The blast radius is limited by keeping `permissions:` minimal per workflow — `contents: read`
  for `build.yml` and `sonar.yml`, `contents: write` only in `release.yml`.
- Upstream fixes to actions arrive without a pull request, and so do upstream behaviour changes
  within a major version. A workflow can break without anything in this repository changing.
- Dependabot proposes only major tag moves (`@v5` → `@v6`), which are the updates worth a human
  look.
- Adding an action means picking a major tag, not a SHA, and existing entries should not be
  "helpfully" converted one at a time — that recreates the mixed state this decision exists to
  avoid.

