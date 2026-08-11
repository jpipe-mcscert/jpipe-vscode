# ADR-VSC-0012: A single `main` branch, protected but bypassable by admins

**Date:** 2026-08-11
**Status:** Accepted

## Context

The sibling compiler runs two long-lived branches, `main` and `dev`
(jpipe-compiler ADR-0024). This repository has only ever had `main`, and
`scripts/release.sh` says so in its header: there is no post-release verb here because npm has
no `-SNAPSHOT` and there is no `dev` to return to.

Adopting the quality gate (jpipe-vscode ADR-VSC-0009) forced a decision that had been implicit.
A gate that fails a job is only a gate if something refuses to merge on that failure, which
means branch protection on `main`. But `main` had never been protected, and the documented
release procedure depends on that: `release.sh prepare X.Y.Z` commits `chore(release): X.Y.Z`
**directly on `main`**, and the README's next step is a bare `git push`. Under a rule that
requires status checks, a direct push is rejected — the pushed commit has no checks, because it
does not exist on the remote yet to be checked.

So the two could not both be taken literally. Either the release flow changes, or the
protection admits an exception.

## Decision

`main` is the only long-lived branch. Work happens on short-lived branches merged into it by
pull request.

`main` is protected: status checks are required (`build` and `Build and analyze`), and branches
must be up to date before merging. **"Do not allow bypassing the above settings" is deliberately
left off**, so repository admins can still push directly.

`scripts/release.sh` keeps committing the release on `main`, and the README keeps documenting
`git push` as the step after `prepare`.

## Rationale

- The protection exists to stop an unreviewed or failing *contribution* reaching `main`. The
  release commit is neither: it is a mechanical version bump produced by a script that has
  already run a clean build and both test suites, by the one person who cuts releases.
- Routing the release commit through a pull request is the cleaner design and was the
  alternative. It costs a change to `release.sh`, to the README's release section, and to the
  habits of the person who uses them — and it buys a review of a diff that is four version
  strings and a changelog heading. Not worth bundling into the change that introduced the gate.
- Leaving bypass off is a trade with a real downside, and writing it down is the point of this
  record: without it, the next person to read the protection rule concludes that the README's
  release section is stale and "fixes" one of them to match the other.
- A `dev` branch was not adopted. The compiler needs one because it publishes snapshots between
  releases; this repository publishes only on a tag, and a second integration branch would add a
  merge step without a question it answers.

## Consequences

- **An admin can push to `main` without a green gate.** Nothing mechanical prevents a release
  commit landing on a red `main`; that is what the bypass permits. `release.sh preflight`
  therefore checks the gate itself and fails on a red one — the only guard on this path, and the
  reason it exists.
- Because the gate runs against `main` and `release.yml` runs against a tag, the workflow cannot
  make this check. It has to live in `preflight`, and so it is one more thing that must stay in
  step between the script and CI (jpipe-vscode ADR-VSC-0008).
- A contributor without admin rights cannot cut a release, since `prepare` ends in a commit on
  `main`. That matches who actually cuts releases today; it would need revisiting if that
  changed.
- The bypass is a standing permission, not a per-use approval. It is available for any admin
  push, not only the release commit, and nothing records when it is used.
- Required checks apply to pull requests from branches in this repository. A pull request from a
  fork cannot pass `Build and analyze` at all, for the reasons in jpipe-vscode ADR-VSC-0009, so
  those are handled by re-pushing the branch here.
