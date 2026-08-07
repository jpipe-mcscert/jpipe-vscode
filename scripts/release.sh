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
                             before the tag exists. Read-only.

Options:
  --dry-run                  Show what would change without writing anything
                             (prepare only).
  --skip-verify              Skip the build and test run.
  -h, --help                 This message.

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
  git fetch --quiet origin
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
  git fetch --quiet origin main
  if git merge-base --is-ancestor HEAD origin/main; then
    pass "HEAD is on main — release.yml's branch check will pass"
  else
    fail "HEAD is not on main — release.yml refuses a tag that is not an ancestor of main"
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
  local version=$1
  if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
    fail "tag v$version already exists locally"
  elif [ -n "$(git ls-remote --tags origin "refs/tags/v$version" 2>/dev/null)" ]; then
    fail "tag v$version already exists on origin"
  else
    pass "tag v$version does not exist yet"
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
check_package() {
  local out
  if [ "$SKIP_VERIFY" -eq 1 ]; then
    warn "skipping vsce package (--skip-verify)"
    return
  fi
  command -v vsce >/dev/null || return
  out=$(mktemp -t jpipe-preflight-vsix).vsix
  if (cd packages/extension && vsce package -o "$out") >/dev/null 2>&1; then
    pass "vsce package succeeds ($(du -h "$out" | cut -f1) VSIX)"
    rm -f "$out"
  else
    fail "vsce package failed"
    (cd packages/extension && vsce package -o "$out" 2>&1 | tail -10 | sed 's/^/       /') || true
  fi
}

print_manual_checklist() {
  head2 "Manual checks — required, not housekeeping"
  cat <<'EOF'
  [ ] The CHANGELOG describes what a *user* gets, not what was committed
  [ ] The version number matches what the section actually contains
      (new capability -> minor, fixes/docs only -> patch)
  [ ] Compiler compatibility: any feature needing a newer jpipe compiler says so
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
