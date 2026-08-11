# ADR-VSC-0004: Testability through a `vscode`-free seam, not API mocks

**Date:** 2026-08-10
**Status:** Accepted

## Context

The `vscode` module is not an npm package. It is injected by the extension host at runtime and
marked `external` in the bundle. Under Vitest there is no extension host, so **any module whose
import graph reaches `vscode` cannot be loaded at all** — not "fails its assertions", but throws
on import.

That leaves two ways to test extension code. Mock the `vscode` API surface, which means
hand-maintaining fakes for `window`, `workspace`, `commands`, `Uri`, `EventEmitter`,
`TextDocument` and more, and then trusting that the fakes behave like the real thing. Or arrange
the code so that the logic worth testing does not import `vscode` in the first place.

The real alternative to both is `@vscode/test-cli`, which downloads a VS Code build and runs
tests inside it. That gives genuine coverage of the editor surface, at the cost of a much slower
suite, a browser-sized download in CI, and a second test runner alongside Vitest.

## Decision

Logic worth testing is pushed into modules that import neither `vscode` nor the DOM. The
`vscode`-importing modules become thin adapters over them: they translate editor concepts into
plain data, call down, and translate back.

The seam modules today are `process-launcher.ts`, `release-selection.ts`,
`compiler-invocation.ts`, `exclusion-paths.ts`, `preview-refresh.ts`, `render-failure.ts`,
`diagnostic-model.ts`, `viewbox.ts` and `highlight.ts`. All are tested. The VS Code API is not
mocked anywhere in the suite.

`@vscode/test-cli` was considered and is **not** adopted.

## Rationale

- A mock of an API you do not control is a second implementation of it, and it drifts. When it
  drifts, the tests stay green and the extension breaks — the failure mode is worse than having
  no test.
- The seam makes the interesting logic ordinary: `process-launcher.ts` takes platform, env and
  filesystem as injected arguments, so the Windows `cmd.exe` quoting rules are exercised on the
  Linux CI runner. That is a better test than a mocked `vscode` could give.
- The pressure runs the right way. "Make this testable" means "move the decision out of the
  adapter", which is also what makes the adapter readable.
- `@vscode/test-cli` is declined *for now* on cost, not on principle. It is the only thing that
  can cover decorations, menu `when`-clauses and command registration, and adopting it remains
  the answer if those start breaking. Nothing in this decision blocks it.

## Consequences

- **Roughly half of the extension package has no automated coverage**, and cannot have any under
  the current runner. Ten modules import `vscode` or are environment entry points:
  `extension/main.ts`, `extension/logger.ts`, `extension/exclusions.ts`,
  `image-generation/{image-generator, preview-provider, release-manager, preview-shell}.ts`,
  `language/main.ts`, `webview/preview.ts` and `webview/minimap.ts`. This is the honest cost.
- It follows that any coverage measurement introduced here must exclude those modules, or the
  figure it reports is meaningless. The rule for that list is **uncoverable by construction, never
  merely untested** — a module belongs on it because it cannot be loaded without a VS Code host or
  a browser, not because covering it is inconvenient. That list will get its own record when
  coverage is actually wired up.
- The editor surface — decorations, menu `when`-clauses, command registration, the preview panel
  — is verified by hand in the Extension Development Host before a release. `scripts/release.sh`
  prints this as a manual checklist item precisely because CI never launches VS Code.
- A seam that stops absorbing logic silently re-grows the untestable area. The ratio to watch is
  the adapter's size against its seam module's: when an adapter is many times larger, logic has
  leaked back up.
- New extension logic goes in a `vscode`-free module by default. Reaching for a mock of the VS
  Code API is a signal that the split is in the wrong place, not that the rule needs an exception.
- One test works around the rule rather than within it: `preview-shell.test.ts` reads its target's
  *source text* and cross-checks element ids against `preview.ts` and `preview.css`, because the
  module itself cannot be imported. It is a deliberate compromise, not a pattern to copy.

## Amendment (2026-08-11): the directory names in Consequences have changed

`image-generation/` was split into `compiler/` and `preview/` by
jpipe-vscode ADR-VSC-0016. The modules this record names are the same ones; their paths are now
`compiler/{image-generator, release-manager}.ts` and
`preview/{preview-provider, preview-shell}.ts`.

Nothing about the decision changes — the set of modules that cannot be loaded without a VS Code
host is unaffected by which folder they sit in.
