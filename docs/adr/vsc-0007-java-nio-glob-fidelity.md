# ADR-VSC-0007: `load` globs follow Java NIO, for fidelity with the compiler

**Date:** 2026-08-10
**Status:** Accepted

## Context

A `load` path in a `.jd` file may be a glob. The jPipe compiler expands it with
`FileSystems.getDefault().getPathMatcher("glob:" + pattern)` — Java NIO semantics — as recorded
in jpipe-compiler ADR-0022 and implemented in its `LoadResolver.java`.

The extension has to answer the same question, while the user types, to resolve references and
report unresolved ones. If the editor and the compiler disagree about which files a pattern
matches, the editor either reports errors on a model that compiles, or stays silent on a model
that does not. Both destroy trust in the diagnostics, and the second is worse because it is
invisible until build time.

The obvious implementation is `minimatch` or `picomatch`, either of which is one dependency away.
**Both are wrong here**, and not in an edge case: they treat `**` as significant only when it is
a complete path segment, so they read `models/**.jd` as `models/*.jd` and miss every nested file.
Under Java, `models/**.jd` matches at *every* depth including the top level, while
`models/**/*.jd` matches nested files only. A user following the compiler's documentation would
get different answers from the two tools on an ordinary pattern.

## Decision

`packages/language/src/jpipe-glob.ts` is a hand-written port of OpenJDK's
`sun.nio.fs.Globs.toUnixRegexPattern`. Its obligation is **to agree with the compiler**, not to
be a good general-purpose glob library. `test/glob-matcher.test.ts` ports its cases from the
compiler's own `LoadResolverGlobTest`, including the anchoring table from jpipe-compiler ADR-0022.

Anchoring (`anchorGlob`) splits a pattern at the last `/` before its first wildcard *character*.
The literal prefix is resolved like a literal load path — so a pattern may climb out of the
declaring file's directory (`../library/*.jd`) or be absolute — and the remainder is matched
relative to that anchor, which is also the only subtree walked. Cutting before the wildcard
character rather than at a segment boundary is what keeps `{foo/bar,baz}/*.jd` intact.

Four failure modes are errors, **worded exactly as the compiler words them**: a malformed
pattern, a `..` surviving anchoring, an anchor that is not a directory, and zero matches. A load
resolving to its own file is reported as `Circular load detected`. Results are sorted.

The port's cognitive complexity is accepted, not refactored. SonarCloud's `typescript:S3776` is
suppressed for `jpipe-glob.ts` alone, in `sonar-project.properties`:

```properties
sonar.issue.ignore.multicriteria.globPortComplexity.ruleKey=typescript:S3776
sonar.issue.ignore.multicriteria.globPortComplexity.resourceKey=packages/language/src/jpipe-glob.ts
```

## Deliberate deviations from the compiler

Two, both concessions to running inside an editor rather than once per build:

- **Expansion prunes** `node_modules`, `out`, `.git` and dot-directories. The compiler walks
  them. This runs on every keystroke, and the pruned directories cannot contain a legitimately
  loaded model.
- **Results are memoised**, with the cache cleared from `DocumentBuilder.onUpdate`.

Neither changes which files a well-formed pattern in a real project resolves to.

## Rationale

- Fidelity to the compiler is the whole requirement. A dependency that is 95% compatible is worse
  than a port that is exact, because the remaining 5% surfaces as diagnostics the user cannot
  explain.
- The `**` divergence is not obscure. `models/**.jd` is a pattern a user would plausibly write,
  and minimatch would silently under-match it.
- Porting the *test cases* from `LoadResolverGlobTest` matters as much as porting the algorithm:
  it is what makes divergence detectable rather than theoretical.
- Copying the compiler's error wording means a user searching for an error message finds one
  explanation, not two subtly different ones.
- The cost — a hand-maintained ~300-line matcher in a package that is otherwise about a DSL — is
  accepted deliberately.
- **The complexity is the algorithm's.** `parseCharacterClass` and `globToRegExp` are the most
  complex functions in the language package, because OpenJDK's `Globs.toUnixRegexPattern` is
  shaped that way and the port mirrors it. Refactoring them for a complexity score would trade
  the one property they must have, in the module where a divergence is hardest to notice: the
  symptom is a model loading different files in the IDE than in the compiler.
- **The suppression lives in the repository, not in the SonarCloud UI.** Marking the issues
  Accepted there would keep them visible on the dashboard and out of the gate, but the reason
  would live only in SonarCloud — invisible in the repository, absent from review, lost if the
  project is recreated. An exemption is a decision, and decisions here are recorded in
  `docs/adr/`.

## Consequences

- `jpipe-glob.ts` must be re-checked against `LoadResolver.java` whenever the compiler's glob
  behaviour changes. The two repositories are coupled here, and nothing automated enforces it —
  the test suite is the only signal, and only for cases someone thought to port.
- Any change to the matcher requires re-running `test/glob-matcher.test.ts`, whose cases exist to
  catch exactly this.
- The two deviations above must stay meaning-preserving. Adding a third needs to be argued the
  same way and recorded here.
- **The complexity debt does not appear anywhere in SonarCloud.** A reader of the dashboard alone
  would conclude `jpipe-glob.ts` is uncomplicated; this record is the counterweight, and the
  properties file points back at it.
- The suppression is one rule on one file. Any other rule firing on `jpipe-glob.ts` is an ordinary
  finding. The fidelity argument covers behaviour, not appearance: a suggestion that produces an
  identical string or regex — `String.raw` (`typescript:S7780`), say — is not exempt on the
  grounds that the port should read like the Java it mirrors.
- **Glob resolution powers hover but deliberately not go-to-definition.** F12 on a pattern returns
  nothing, because "go to definition" names one target and a pattern does not; the hover lists the
  matches as clickable links instead.
- The matcher is domain-free and currently lives in the language package. That placement is
  incidental rather than decided.

