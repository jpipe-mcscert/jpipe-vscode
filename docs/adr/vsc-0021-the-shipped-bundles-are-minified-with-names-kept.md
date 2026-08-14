# ADR-VSC-0021: The shipped bundles are minified, with names kept

**Date:** 2026-08-13
**Status:** Accepted

## Context

jpipe-vscode ADR-VSC-0020 made the VSIX carry only what runs, and said plainly what it was not
addressing: `out/language/main.cjs` and `out/extension/main.cjs` are 77% of the artefact, "growth
there is features landing, and if the download becomes a problem that is where to look — not
here." This is that look.

The machinery already existed. `esbuild.mjs` has accepted `--minify` since it was written, and
ties source maps to it (`sourcemap: !minify`), but nothing passed the flag: `vscode:prepublish`
ran the ordinary `npm run build`, so every published VSIX has shipped unminified bundles.

Measured on this tree, as the deflate-compressed payload the VSIX actually stores:

| build | raw | compressed |
|---|---|---|
| plain | 3,255,927 | 530,284 |
| minified | 1,502,631 | 362,580 |
| minified, `keepNames` | 1,590,884 | 391,156 |

End to end the VSIX goes from 667,135 to 524,127 bytes — 21%, and 25% against published v1.7.1.

**The cost is diagnostic, not functional.** Minifying renames every function and class, and
ADR-VSC-0020 deliberately keeps `.map` files out of the VSIX, so nothing ships that could undo
it. A user's error report — the extension surfaces failures through notifications and a log
channel — would arrive as `main.cjs:1:73421` in mangled code.

**One claim that was made and withdrawn**, because the record should not repeat it: that
minifying would leave the shipped bundle untested. It would, but it already is. The extension
suite imports `../src/**` directly and the language suite runs against tsc output in
`packages/language/out`; neither has ever loaded the esbuild bundle. Coverage is identical before
and after, so it is not a cost of this decision. The defensible residue is narrower and is about
inference rather than coverage: plain bundling preserves identifiers, so passing tests on `src/`
are strong evidence about the artefact, while minification adds one failure class they cannot
speak to — code that reads names at runtime. On this codebase that exposure looks very small:
our source contains no `constructor.name`, and Langium dispatches on `$type` string literals and
explicit DI module keys, which a minifier does not touch. A dependency reflecting on names is the
part that cannot be ruled out by reading.

## Decision

The packaging path minifies; development does not.

`vscode:prepublish` calls a new `build:release` script that passes `--minify`, while `build` —
which `.vscode/tasks.json` runs for F5 — stays unminified and keeps its source maps. Minified
builds set `keepNames`, so function and class names survive into stack traces.

## Rationale

- **`keepNames` costs 28,576 bytes of the 167,704 that minifying saves.** Buying back legible
  crash reports for 17% of the saving is not a close call. It is load-bearing rather than
  decorative: without it this decision trades a smaller download for worse bug reports, which is
  a trade we would not have made.
- **Minifying the development build too** was rejected: F5 would step through mangled code, and
  the debuggability of the thing being developed matters more than the seconds saved building it.
- **Shipping source maps instead of keeping names** was rejected and is worse than it sounds. It
  contradicts ADR-VSC-0020, and it was measured: admitting `out/**` so the maps travel took the
  VSIX to **1.9 MB**, nearly three times the problem being solved.
- **Doing nothing** was the status quo by omission rather than by decision — the flag existed and
  was simply never passed. Recording it either way is the point of this file.

## The trap worth knowing before measuring this again

`vsce package` runs `vscode:prepublish`. Building minified by hand and then packaging measures
nothing, because vsce rebuilds over it — which is exactly how a first attempt here produced
"0 bytes saved" from a genuinely minified build. The flag has to live in the script vsce calls.

Two smaller ones from the same session: both bundles are named `main.cjs`, so copying them into
one directory to compare silently loses one; and minified-versus-plain must be compared
*compressed*, since the VSIX is a zip and raw sizes overstate the gain by roughly half.

## Consequences

- **The download is 21% smaller**, and activation marginally quicker for having less to parse.
- **Packaging leaves `out/` minified.** `vsce package` runs the prepublish script, so a plain
  `npm run build` is needed before F5, or the session steps through minified code. Previously
  packaging left `out/` plain, so this is new.
- **Nothing detects a regression to unminified output.** The ADR-VSC-0020 guard compares file
  *paths*, and minification changes bytes, not names — a package built with the flag lost passes
  `check-vsix.sh` cleanly. If `vscode:prepublish` is ever pointed back at `build`, the artefact
  quietly grows by 143 KB and every check stays green.
- **`keepNames` must not be removed as an optimisation.** It looks like 28 KB of waste and is the
  reason this decision is acceptable. Anyone dropping it is re-opening the trade, not tuning it.
- **The packaged bundle still has no automated coverage**, exactly as before. The difference is
  that it is now transformed more aggressively, so the F5 pass before a release carries a little
  more weight than it did.
