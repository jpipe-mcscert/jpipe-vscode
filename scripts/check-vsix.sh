#!/usr/bin/env bash
#
# Assert that a packaged VSIX contains exactly the files it is supposed to.
#
# The packaging configuration and the artefact are two halves that never meet: `.vscodeignore`
# is a set of glob rules, the VSIX is a zip, and until now the only thing between them was
# somebody remembering to look. That gap shipped a 667 KB test-coverage report — 34 files,
# including HTML renderings of our own source — into any VSIX built on a machine where the
# coverage task had been run. See jpipe-vscode ADR-VSC-0020.
#
# The check runs in both directions on purpose. Over-inclusion is the failure we had; but an
# allow-list fails the other way too, and a missing runtime asset is worse — it produces an
# extension that installs cleanly and quietly does not work.
#
# Usage: scripts/check-vsix.sh <path-to-vsix>

set -euo pipefail

# Sort in C collation, always. `sort` orders by the caller's locale, and the default differs
# between a macOS developer machine (case-insensitive: `language-configuration.json` before
# `LICENSE.txt`) and a Linux CI runner (ASCII: `LICENSE.txt` first). The two produce the same
# *set* of files in a different order, so an inventory generated on one platform can never match
# on the other — which is precisely how this check first failed, on identical contents.
export LC_ALL=C

here=$(cd "$(dirname "$0")/.." && pwd)
expected="$here/packages/extension/vsix-contents.txt"

vsix=${1:-}
if [ -z "$vsix" ]; then
  echo "usage: scripts/check-vsix.sh <path-to-vsix>" >&2
  exit 2
fi
if [ ! -f "$vsix" ]; then
  echo "error: no such VSIX: $vsix" >&2
  exit 2
fi
if [ ! -f "$expected" ]; then
  echo "error: missing expected inventory: $expected" >&2
  exit 2
fi

actual=$(mktemp)
trap 'rm -f "$actual"' EXIT
unzip -Z1 "$vsix" | sort > "$actual"

# Guards the guard: an empty listing would make the comparison below pass against an empty
# expectation, and read as success.
if [ ! -s "$actual" ]; then
  echo "error: $vsix listed no files at all" >&2
  exit 1
fi

if diff -u "$expected" "$actual" > /dev/null; then
  echo "VSIX contents match $(basename "$expected") ($(wc -l < "$actual" | tr -d ' ') files)"
  exit 0
fi

echo "error: VSIX contents differ from packages/extension/vsix-contents.txt" >&2
echo >&2
diff -u --label "expected (vsix-contents.txt)" --label "actual ($(basename "$vsix"))" \
  "$expected" "$actual" >&2 || true
echo >&2
echo "A '+' line is something new being shipped: exclude it in packages/extension/.vscodeignore," >&2
echo "or, if it genuinely belongs in the extension, add it to vsix-contents.txt deliberately." >&2
echo "A '-' line is something expected that is missing, which usually means an allow-list entry" >&2
echo "no longer matches — that ships an extension which installs and does not work." >&2
exit 1
