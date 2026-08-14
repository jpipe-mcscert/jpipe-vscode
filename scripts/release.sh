#!/usr/bin/env bash
#
# release.sh — drive a jpipe-vscode release from the command line.
#
# Two verbs, mirroring scripts/release.sh in jpipe-compiler. There is no
# post-release verb here: npm has no -SNAPSHOT, and this repo has no dev branch,
# so a release is prepared on main and tagged there.
#
#   prepare   X.Y.Z    on main: set all four versions, close out the CHANGELOG,
#                      reconcile the lockfile, verify and commit
#   preflight X.Y.Z    re-run release.yml's checks locally, before the tag exists
#
# The script never creates a tag, never pushes and never publishes. Those stay
# human actions.

set -euo pipefail

DRY_RUN=0
FAILURES=0
SKIP_VERIFY=0

# The remote a release is validated against. Deliberately *not* derived from
# @{upstream}: "is this commit on main" and "does this tag already exist" are questions
# about the canonical repository, and a local branch may track a fork. Overridable for a
# fork or mirror, e.g. RELEASE_REMOTE=upstream scripts/release.sh preflight 1.4.0
RELEASE_REMOTE=${RELEASE_REMOTE:-origin}

# ----------------------------------------------------------------------------
# output helpers
# ----------------------------------------------------------------------------

if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BOLD=''; C_OFF=''
fi

pass() { printf '  %sok%s   %s\n' "$C_GREEN" "$C_OFF" "$1"; }
warn() { printf '  %swarn%s %s\n' "$C_YELLOW" "$C_OFF" "$1"; }
fail() { printf '  %sFAIL%s %s\n' "$C_RED" "$C_OFF" "$1"; FAILURES=$((FAILURES + 1)); }
head2() { printf '\n%s%s%s\n' "$C_BOLD" "$1" "$C_OFF"; }
die() { printf '%serror:%s %s\n' "$C_RED" "$C_OFF" "$1" >&2; exit 1; }
note() { printf '       %s\n' "$1"; }

usage() {
  cat <<'EOF'
Usage: scripts/release.sh <verb> [options]

Verbs:
  prepare X.Y.Z              On main: set the version in all four places, close out
                             the CHANGELOG section, reconcile package-lock.json,
                             build, test and commit.
  preflight X.Y.Z            Check that everything release.yml validates would pass,
                             plus the SonarCloud gate on main, before the tag
                             exists. Read-only.

Options:
  --dry-run                  Show what would change without writing anything
                             (prepare only).
  --skip-verify              Skip the build and test run.
  -h, --help                 This message.

Environment:
  RELEASE_REMOTE             Remote treated as canonical when checking that HEAD is
                             on main and that the tag is free. Defaults to origin.

Neither verb tags, pushes or publishes. Pushing the tag triggers release.yml,
which packages the VSIX, creates the GitHub Release and publishes to the
Marketplace.
EOF
}

# ----------------------------------------------------------------------------
# small utilities
# ----------------------------------------------------------------------------

# A release version: X.Y.Z, optionally with a pre-release suffix (1.4.0-rc1).
valid_version() {
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
}

json_get() {
  node -p "require('$1')$2" 2>/dev/null
}

root_version() { json_get './package.json' '.version'; }
ext_version()  { json_get './packages/extension/package.json' '.version'; }
lang_version() { json_get './packages/language/package.json' '.version'; }
lang_dep()     { json_get './packages/extension/package.json' ".dependencies['jpipe-language']"; }

current_branch() { git rev-parse --abbrev-ref HEAD; }

# Entries under `### vX.Y.Z (Unreleased)`, excluding the `- Leader:` line, which is
# always present and therefore says nothing about whether there is anything to ship.
unreleased_entries() {
  awk -v heading="### v$1 (Unreleased)" '
    $0 == heading { inside = 1; next }
    inside && /^### v/ { exit }
    inside && /^ {4}- / { print }
  ' CHANGELOG.md
}

# The remote a branch tracks, which is not necessarily RELEASE_REMOTE.
tracking_remote() {
  local remote
  remote=$(git config "branch.$(current_branch).remote" 2>/dev/null || true)
  printf '%s' "${remote:-$RELEASE_REMOTE}"
}

# A failed fetch must be reported, not swallowed: every check below compares against a
# remote-tracking ref, and a stale one answers the wrong question.
fetch_remote() {
  local remote=$1; shift
  if git fetch --quiet "$remote" "$@" 2>/dev/null; then
    return 0
  fi
  fail "could not fetch from $remote — cannot verify against it"
  return 1
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  %s[dry-run]%s %s\n' "$C_YELLOW" "$C_OFF" "$*"
  else
    "$@"
  fi
}

# ----------------------------------------------------------------------------
# individual checks
# ----------------------------------------------------------------------------

check_clean_tree() {
  if [ -n "$(git status --porcelain)" ]; then
    fail "working tree is dirty — commit or stash first"
    git status --short | sed 's/^/       /'
  else
    pass "working tree is clean"
  fi
}

check_branch_is() {
  local expected=$1 actual
  actual=$(current_branch)
  if [ "$actual" = "$expected" ]; then
    pass "on branch $expected"
  else
    fail "on branch $actual, expected $expected"
  fi
}

check_in_sync() {
  local branch upstream
  branch=$(current_branch)
  if ! upstream=$(git rev-parse --abbrev-ref "@{upstream}" 2>/dev/null); then
    warn "$branch has no upstream — cannot check whether it is current"
    return
  fi
  # Fetch the remote this branch actually tracks — comparing against $upstream after
  # fetching some other remote would compare against a ref nothing just updated.
  fetch_remote "$(tracking_remote)" || return 0
  if [ "$(git rev-parse HEAD)" = "$(git rev-parse "$upstream")" ]; then
    pass "$branch is in sync with $upstream"
  elif git merge-base --is-ancestor "$upstream" HEAD; then
    warn "$branch is ahead of $upstream — remember to push"
  else
    fail "$branch is behind or diverged from $upstream — pull first"
  fi
}

# release.yml refuses a tag that is not an ancestor of main, so that a v*.*.* tag
# pushed from a feature branch cannot reach the Marketplace.
check_on_main() {
  fetch_remote "$RELEASE_REMOTE" main || return 0
  if git merge-base --is-ancestor HEAD "$RELEASE_REMOTE/main"; then
    pass "HEAD is on $RELEASE_REMOTE/main — release.yml's branch check will pass"
  else
    fail "HEAD is not on $RELEASE_REMOTE/main — release.yml refuses a tag that is not an ancestor of main"
  fi
}

# The toolchain is pinned with volta; an unpinned node breaks `langium generate`
# outright (jsonschema builds a URL that recent node rejects). See the README.
check_node_pinned() {
  local pinned actual
  pinned=$(json_get './package.json' '.volta.node')
  actual=$(node --version); actual=${actual#v}
  if [ "$pinned" = "$actual" ]; then
    pass "node $actual matches the pinned toolchain"
  else
    fail "node is $actual but package.json pins $pinned"
    note "install volta and run 'volta setup', then open a new shell"
  fi
}

# release.yml compares the tag against all four versions and fails the run — after
# the tag has been pushed. This is the same comparison, before that happens.
check_versions_match() {
  local version=$1 root ext lang dep ok=1
  root=$(root_version); ext=$(ext_version); lang=$(lang_version); dep=$(lang_dep)

  [ "$root" = "$version" ] || { fail "root package.json is $root, expected $version"; ok=0; }
  [ "$ext" = "$version" ]  || { fail "packages/extension is $ext, expected $version"; ok=0; }
  [ "$lang" = "$version" ] || { fail "packages/language is $lang, expected $version"; ok=0; }
  [ "$dep" = "$version" ]  || { fail "jpipe-language dependency is $dep, expected $version"; ok=0; }

  if [ "$ok" -eq 1 ]; then
    pass "all four versions are $version"
  else
    note "release.yml performs this exact comparison, and fails after the tag is pushed"
    note "fix with: scripts/release.sh prepare $version"
  fi
}

check_tag_absent() {
  local version=$1 remote_tag
  if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
    fail "tag v$version already exists locally"
    return
  fi
  # An unreachable remote must not read as "the tag is free" — that is the one answer
  # this check exists to rule out.
  if ! remote_tag=$(git ls-remote --tags "$RELEASE_REMOTE" "refs/tags/v$version" 2>/dev/null); then
    fail "could not reach $RELEASE_REMOTE — cannot tell whether tag v$version exists there"
  elif [ -n "$remote_tag" ]; then
    fail "tag v$version already exists on $RELEASE_REMOTE"
  else
    pass "tag v$version does not exist locally or on $RELEASE_REMOTE"
  fi
}

check_changelog_closed() {
  local version=$1
  if grep -qE "^### v$version \([0-9]{4}-[0-9]{2}-[0-9]{2}\)$" CHANGELOG.md; then
    pass "CHANGELOG has a dated v$version section"
  elif grep -q "^### v$version (Unreleased)$" CHANGELOG.md; then
    fail "CHANGELOG still marks v$version as (Unreleased)"
    note "run: scripts/release.sh prepare $version"
  else
    fail "CHANGELOG has no '### v$version (…)' section at all"
  fi
}

check_vsce() {
  if command -v vsce >/dev/null; then
    pass "vsce is on PATH"
  else
    fail "vsce not found — install it with: npm install -g @vscode/vsce"
  fi
}

# Read from sonar-project.properties rather than repeated here, so the key has one home.
#
# This must not be able to fail. It is called as `key=$(sonar_project_key)`, and a plain
# assignment from a command substitution carries that command's exit status — so under `set -e`
# a missing or unreadable file would abort preflight outright, before check_quality_gate could
# report it. Every path here yields a string (possibly empty) and returns 0; judging the empty
# case is the caller's job. `head -n 1` because a properties file with two projectKey lines is
# malformed, and one key is what the caller can act on.
sonar_project_key() {
  [ -r sonar-project.properties ] || return 0
  sed -n 's/^sonar\.projectKey=\(.*\)$/\1/p' sonar-project.properties 2>/dev/null | head -n 1 || true
}

# The quality gate blocks merges to main, so a release cut from a main whose gate is red ships
# code the project has already declined to accept. release.yml does not check this — the gate
# runs against main, not against the tag — which is exactly the sort of gap preflight exists to
# close. See docs/adr/vsc-0009-sonarcloud-as-mandatory-quality-gate.md.
#
# Unreachable SonarCloud is a warning, not a failure, on the same reasoning as check_in_sync's
# missing upstream: a release must not be blocked by somebody else's outage. The project is
# public, so no token is involved.
check_quality_gate() {
  local key url payload status
  key=$(sonar_project_key)
  if [ -z "$key" ]; then
    warn "could not read sonar.projectKey from sonar-project.properties — quality gate not verified"
    return
  fi

  url="https://sonarcloud.io/api/qualitygates/project_status?projectKey=$key&branch=main"
  if ! payload=$(curl -sS --fail --max-time 15 "$url" 2>/dev/null); then
    warn "could not reach SonarCloud — quality gate not verified"
    return
  fi

  # `|| true` for the same reason as sonar_project_key: with `set -o pipefail`, a body that is
  # not the JSON we expect — SonarCloud answering 200 with an error page, say — would fail the
  # pipeline and take preflight down with it, instead of falling through to the warning below.
  status=$(printf '%s' "$payload" \
    | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).projectStatus.status' 2>/dev/null \
    || true)

  case "$status" in
    OK)
      pass "SonarCloud quality gate is green on main"
      ;;
    NONE)
      # No analysis yet — true for a fresh project, and not something to block a release on.
      warn "SonarCloud has no gate result for main yet"
      ;;
    ERROR|WARN)
      fail "SonarCloud quality gate is $status on main"
      note "https://sonarcloud.io/dashboard?id=$key&branch=main"
      ;;
    *)
      warn "could not read the SonarCloud gate status — quality gate not verified"
      ;;
  esac
}

# The sequence release.yml runs, in the same order, so a failure surfaces here
# rather than on a tag that is already public.
check_build() {
  local log
  if [ "$SKIP_VERIFY" -eq 1 ]; then
    warn "skipping build and tests (--skip-verify)"
    return
  fi
  log=$(mktemp -t jpipe-release-verify)
  printf '  ..   running clean, langium:generate, build and tests\n'
  if npm run clean >"$log" 2>&1 &&
     npm run langium:generate >>"$log" 2>&1 &&
     npm run build >>"$log" 2>&1 &&
     npm test >>"$log" 2>&1; then
    pass "build and both test suites are green"
    rm -f "$log"
  else
    fail "build or tests failed — full log in $log"
    tail -20 "$log" | sed 's/^/       /'
  fi
}

# Packaging is the last thing release.yml does before publishing, and it can fail on
# its own (a bad .vscodeignore, a missing icon). Cheap to check, expensive to discover
# after the tag is public.
#
# The size alone used to be the whole check, and it was reassurance rather than a test:
# this runs on a developer's machine, where build artefacts CI never sees are lying
# around, so it was reporting on an artefact that is not the one that ships. Hence the
# inventory check — see jpipe-vscode ADR-VSC-0020.
check_package() {
  local out
  if [ "$SKIP_VERIFY" -eq 1 ]; then
    warn "skipping vsce package (--skip-verify)"
    return
  fi
  command -v vsce >/dev/null || return 0
  out=$(mktemp -t jpipe-preflight-vsix).vsix
  if (cd packages/extension && vsce package --no-dependencies -o "$out") >/dev/null 2>&1; then
    pass "vsce package succeeds ($(du -h "$out" | cut -f1) VSIX)"
  else
    fail "vsce package failed"
    (cd packages/extension && vsce package --no-dependencies -o "$out" 2>&1 | tail -10 | sed 's/^/       /') || true
    rm -f "$out"
    return
  fi

  if scripts/check-vsix.sh "$out" >/dev/null 2>&1; then
    pass "VSIX contains exactly the expected files"
  else
    fail "VSIX contents differ from packages/extension/vsix-contents.txt"
    scripts/check-vsix.sh "$out" 2>&1 | tail -20 | sed 's/^/       /' || true
  fi
  rm -f "$out"
}

print_manual_checklist() {
  head2 "Manual checks — required, not housekeeping"
  cat <<'EOF'
  [ ] The CHANGELOG describes what a *user* gets, not what was committed
  [ ] The version number matches what the section actually contains
      (new capability -> minor, fixes/docs only -> patch)
  [ ] Compiler compatibility: any feature needing a newer jpipe compiler says so
  [ ] Any SonarCloud issue accepted rather than fixed was accepted deliberately
  [ ] Smoke-test the VSIX in a real editor — CI never launches VS Code
EOF
}

# ----------------------------------------------------------------------------
# verbs
# ----------------------------------------------------------------------------

close_changelog() {
  local version=$1 today=$2 tmp
  tmp=$(mktemp)
  awk -v from="### v$version (Unreleased)" -v to="### v$version ($today)" '
    !swapped && $0 == from { print to; swapped = 1; next }
    { print }
  ' CHANGELOG.md >"$tmp"

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  %s[dry-run]%s CHANGELOG.md would change:\n' "$C_YELLOW" "$C_OFF"
    diff -u CHANGELOG.md "$tmp" | sed 's/^/       /' || true
    rm -f "$tmp"
  else
    mv "$tmp" CHANGELOG.md
    pass "CHANGELOG closed out as v$version ($today)"
  fi
}

cmd_prepare() {
  local version=$1 today entries
  today=$(date +%Y-%m-%d)

  head2 "Preparing the $version release"
  check_clean_tree
  check_branch_is main
  check_in_sync
  check_node_pinned
  check_tag_absent "$version"

  entries=$(unreleased_entries "$version")
  if [ -z "$entries" ]; then
    fail "CHANGELOG has no entries under '### v$version (Unreleased)'"
    note "either the section is missing, or the version you are releasing is not the one it names"
  else
    pass "CHANGELOG has $(printf '%s\n' "$entries" | wc -l | tr -d ' ') entries under v$version (Unreleased)"
  fi

  if [ "$FAILURES" -gt 0 ]; then
    printf '\n%s%d check(s) failed.%s Nothing was changed.\n' "$C_RED" "$FAILURES" "$C_OFF"
    exit 1
  fi

  head2 "Applying"
  # --no-workspaces-update is what keeps this from failing: without it npm tries to
  # resolve the still-old jpipe-language dependency against the registry, and 404s,
  # because that package is workspace-local and never published.
  run npm version "$version" --no-git-tag-version --workspaces \
    --include-workspace-root --no-workspaces-update
  [ "$DRY_RUN" -eq 1 ] || pass "root, extension and language set to $version"

  run npm pkg set "dependencies.jpipe-language=$version" --workspace packages/extension
  [ "$DRY_RUN" -eq 1 ] || pass "jpipe-language dependency set to $version"

  # Only now that all four agree can the lockfile be reconciled.
  #
  # `install`, and it must stay `install`, even though CI now uses `npm ci` everywhere
  # (docs/adr/vsc-0013-dependency-freshness-policy.md). The two commands do opposite things: `ci` installs what the lockfile
  # already says and fails if the manifests disagree with it, which is exactly the state three
  # lines above leave us in. Reconciling that is this line's whole job.
  run npm install --silent
  [ "$DRY_RUN" -eq 1 ] || pass "package-lock.json reconciled"

  close_changelog "$version" "$today"

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\n%sDry run — nothing was written.%s\n' "$C_YELLOW" "$C_OFF"
    return
  fi

  check_build
  if [ "$FAILURES" -gt 0 ]; then
    printf '\n%sBuild failed.%s The working tree holds the prepared changes; fix and commit yourself.\n' \
      "$C_RED" "$C_OFF"
    exit 1
  fi

  git add CHANGELOG.md package.json package-lock.json \
    packages/extension/package.json packages/language/package.json
  git commit -q -m "chore(release): $version"
  pass "committed: chore(release): $version"

  print_manual_checklist
  printf '\n%sPrepared.%s Next:\n' "$C_GREEN" "$C_OFF"
  printf '  git push\n'
  printf '  scripts/release.sh preflight %s\n' "$version"
}

cmd_preflight() {
  local version=$1
  head2 "Preflight for v$version"
  check_clean_tree
  check_in_sync
  check_on_main
  check_node_pinned
  check_vsce
  check_versions_match "$version"
  check_changelog_closed "$version"
  check_tag_absent "$version"
  check_quality_gate
  check_build
  check_package
  print_manual_checklist

  if [ "$FAILURES" -gt 0 ]; then
    printf '\n%s%d check(s) failed.%s Fix them before tagging.\n' "$C_RED" "$FAILURES" "$C_OFF"
    exit 1
  fi
  printf '\n%sReady.%s Tag on main — pushing the tag publishes to the Marketplace:\n' "$C_GREEN" "$C_OFF"
  printf '  git tag v%s && git push origin v%s\n' "$version" "$version"
}

# ----------------------------------------------------------------------------
# entry point
# ----------------------------------------------------------------------------

main() {
  local verb="" version="" arg

  for arg in "$@"; do
    case $arg in
      --dry-run) DRY_RUN=1 ;;
      --skip-verify) SKIP_VERIFY=1 ;;
      -h|--help) usage; exit 0 ;;
      -*) die "unknown option: $arg" ;;
      *)
        if [ -z "$verb" ]; then verb=$arg
        elif [ -z "$version" ]; then version=$arg
        else die "unexpected argument: $arg"
        fi
        ;;
    esac
  done

  [ -n "$verb" ] || { usage; exit 1; }

  cd "$(git rev-parse --show-toplevel)" || die "not inside a git repository"
  command -v node >/dev/null || die "node not found on PATH"
  command -v npm >/dev/null || die "npm not found on PATH"

  version=${version#v}
  case $verb in
    prepare|preflight)
      [ -n "$version" ] || die "$verb needs a version, e.g. scripts/release.sh $verb 1.4.0"
      valid_version "$version" || die "not a valid version: $version"
      ;;
  esac

  case $verb in
    prepare) cmd_prepare "$version" ;;
    preflight) cmd_preflight "$version" ;;
    *) die "unknown verb: $verb (expected prepare or preflight)" ;;
  esac
}

main "$@"
