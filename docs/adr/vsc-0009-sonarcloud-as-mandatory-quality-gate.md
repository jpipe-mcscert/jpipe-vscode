# ADR-VSC-0009: SonarQube Cloud as a mandatory quality gate

**Date:** 2026-08-10
**Status:** Accepted

## Context

Until now the only automated gate on a change to this repository was `tsc -b` and the test
suites. There is no linter and no formatter, so anything the compiler tolerates and the tests
do not reach — an unused export, a needlessly complex function, a copy-pasted block, a
security-sensitive pattern — was caught only if a reviewer happened to notice it.

The sibling compiler already runs SonarQube Cloud, and its **jpipe-compiler ADR-0004** states
that "SonarCloud is mandatory for the jPipe project" and that pull requests failing the Quality
Gate must not be merged. That is a project-wide claim this repository did not satisfy.

The repository is public, so the free plan applies. A project already existed in the
`jpipe-mcscert` organisation, analysed once by Automatic Analysis in April 2026 and stale ever
since — it had never seen a coverage figure, and by August it was measuring roughly a fifth of
the code that now exists.

## Decision

SonarQube Cloud analyses every push to `main` and every pull request, from
`.github/workflows/sonar.yml`. The scanner runs with `-Dsonar.qualitygate.wait=true`, and the
job **`Build and analyze` is a required status check on `main`**. A pull request whose gate
fails cannot be merged.

The default **Sonar way** gate is used unchanged, and New Code is defined by reference branch
`main`.

Analysis is CI-based; **Automatic Analysis is disabled**. The two are mutually exclusive — the
scanner fails hard when both are on.

## Rationale

- `-Dsonar.qualitygate.wait=true` is what makes this enforceable. Without it the scanner
  uploads and exits 0 regardless of the verdict, the gate is computed asynchronously, and the
  Actions job is green on a failing gate. With it, the job itself turns red, so the required
  check is an ordinary Actions job — re-runnable from the Actions UI, and not dependent on a
  third-party GitHub App's check run staying healthy.
- **The default gate judges New Code only, which is what makes day-one enforcement reasonable.**
  The first analysis of `main` baselines everything already in the tree as overall-code debt:
  the 264-line `activate()`, the 878-line `diagnostic-view.ts`, the existing duplication. None
  of it is a gate condition. Nothing currently in the repository can fail the gate. A green gate
  therefore means "this change did not make things worse", **not** "this codebase is clean", and
  it should never be read as the latter.
- A separate workflow rather than a step inside `build.yml`, because the VSIX that `build.yml`
  uploads is what a reviewer installs to try a branch by hand. A Sonar outage, an expired token
  or a failing gate should block the merge without also withholding the artefact. It also keeps
  the required check a single nameable thing: requiring `build` would conflate "it compiles",
  "it packages" and "it passes the gate" into one signal.
- The compiler uses `-Dsonar.qualitygate.wait=false`. That is deliberately not copied: it makes
  the gate advisory, and this repository is adopting it as binding.
- Weakening the gate on day one was considered and rejected. There is nothing to weaken it
  *for* — the existing debt is already excluded by the New Code model.

## Consequences

- `SONAR_TOKEN` must exist as a repository secret. If it is revoked or expires, every pull
  request is blocked until it is replaced.
- **Pull requests from forks cannot be analysed.** GitHub does not expose secrets to
  `pull_request` runs from a fork, so the scanner fails to authenticate and, with the gate
  required, the pull request cannot be merged by anyone who does not bypass protection. This is
  accepted rather than worked around: every current contributor has write access and works on
  branches in this repository. An external contribution is handled by a maintainer re-pushing
  the branch here and retargeting the pull request. `pull_request_target` was rejected outright —
  it runs untrusted code with `SONAR_TOKEN` in the environment.
- CI time per pull request roughly doubles: `sonar.yml` repeats the clean build and both suites,
  because the scanner reads the lcov from the working tree and so the tests must have run in the
  same job. `concurrency` blocks were added to both workflows to claw that back on branches that
  are pushed to repeatedly.
- Duplication is a live constraint from the first day. The gate allows 3% duplicated lines on
  new code, and there are known duplicate helpers in the language package — a change touching
  `sort-elements.ts` or `convert-model-kind.ts` may well trip it. That is the gate working, and
  the answer is to remove the duplication rather than to raise the threshold.
- Enabling a required check has an unavoidable ordering: the check name does not appear in
  GitHub's branch-protection UI until the workflow has run at least once. The gate is therefore
  advisory for the few minutes between this landing on `main` and the protection rule being
  added.
- Contributors get pull-request decoration — issues shown inline on the diff — only while the
  SonarQube Cloud GitHub App remains installed on the organisation. The gate does not depend on
  it, but most of the day-to-day value does.
