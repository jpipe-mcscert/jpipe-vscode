# ADR-VSC-0023: An error means the build fails

**Date:** 2026-08-13
**Status:** Accepted

## Context

The validator reported 23 diagnostics — 16 errors and 7 warnings — and nothing recorded how any of
them had been decided. Read together they looked arbitrary: a duplicate element id was an error, a
conclusion nothing supported was a warning, and a template with no `@support` was a warning whose
message read like a style note.

They were not quite arbitrary. Six checks explained themselves in comments, and all six said the
same thing in nearly the same words. `checkConfigKeys`: *"A missing required key is an error: the
compiler refuses to run without it. An unknown key is only a warning, because the compiler ignores
keys it does not recognise — flagging one as an error would claim a build failure that will not
happen."* The rule existed. It had simply never been written down, so the other nine checks were
decided by feel — including two added the same day this record was written.

The decisive fact is on the other side of the fence. **The compiler has no warning level at all.**
jpipe-compiler ADR-0016 removed it, reasoning that a level with no behavioural contract is worse
than none: it leaves undefined whether the thing affects the exit code, interrupts the pipeline, or
should be printed. `Diagnostic.Level` is `ERROR` and `FATAL`, and both exit 1. So for the compiler,
"noticed" and "rejected" are the same statement, and the question "is this an error?" has an
answer that is a fact about `jpipe`, not a matter of taste.

Measured against that fact, three of the seven warnings were simply wrong. Verified by running the
CLI over its own `examples/invalid/` fixtures: `has-abstract-support` (`007_template_no_abstract.jd`),
`strategy-supported` and `conclusion-supported` (both `002_unsupported_elements.jd`) all exit 1.
The editor was calling three build failures warnings.

## Decision

**A diagnostic is an error if and only if the compiler will reject the model. Otherwise it is a
warning.** Only two severities are used; there is no `info` and no `hint`.

One narrow exception: **when the editor cannot know what the compiler will do, it warns, and its
message claims only what the editor knows** rather than predicting a failure. Today the sole
instance is `unknown-unification-method`.

Severity is no longer a per-call-site decision. It is declared once per code in
`JpipeIssueSeverity`, with the reason beside it, and `report()` reads it there.

## What follows from the rule

**A rule only the editor has can never be an error.** A check the compiler does not run cannot fail
a build, so it can only ever be a warning. That is why `no-empty-label` is one: a derivation, not a
judgement.

**"Editor-only rule" and "warning" are not the same claim.** The derivation applies to rules the
compiler does not *run*, which is not the same as rules it has no *name* for. The compiler can
still reject a file through some other route — most often as a syntax error — and then the editor's
rule is an error, however editor-specific it looks. Absence of a code upstream is not absence of a
verdict; `jpipe-compiler-codes.ts` files such a rule with the `FATAL` family.

**Severity is attached to the code, not the call site.** One code may still have several branches.
`conclusion-supported` fires both for "nothing supports this" and for "supported, but not by a
strategy"; the compiler rejects both, so both are errors, and message text is the only thing
telling them apart. The two messages must stay distinct, and `diagnostic-codes.test.ts` pins them.

**The warning set is exactly three codes**, each confirmed by running `jpipe diagnostic` on a model
that triggers it and seeing it exit 0:

| Code | Why it is not an error |
|---|---|
| `no-empty-label` | editor-only style rule; nothing in the compiler checks a label's contents |
| `unknown-config-key` | the compiler ignores keys it does not recognise |
| `unknown-unification-method` | the exception: the method registry is populated at the compiler's startup, which the editor cannot see |

Every other code is an error, each confirmed against the compiler's own `examples/invalid/`
fixtures or a hand-written model. That includes three that read like advice —
`has-abstract-support`, `strategy-supported`, `conclusion-supported` — and `no-empty-unit`.

**`no-empty-unit` fires on a document that declares nothing**: empty, whitespace, comments only, or
text that does not parse. It reads both the unit's `load` statements and its body, so a file made
only of `load` statements is not empty; the compiler resolves such a file and exits 0, and tutorial
exercise stubs are written that way on purpose. A file that declares nothing, the compiler rejects
with `[FATAL] Compilation aborted due to syntax errors`.

The check is not redundant with the parse error. The grammar's `+` means an empty document cannot
parse, but Langium's error recovery still hands the validator a `Unit` with both lists empty. The
parser's own message is a token-set mismatch; this one says it in words, and it keeps a name in the
vocabulary jpipe-vscode ADR-VSC-0022 vendors.

**Messages for compiler-enforced rules use the compiler's words.** `has-abstract-support` reads
`Template 't' declares no abstract supports`, per the message rule in jpipe-vscode ADR-VSC-0022.
Advisory prose such as "implementing justifications are not required to override any elements" is
exactly what makes an error look like a warning. The compiler's note for that rule is the better
explanation anyway: *a template with no abstract supports is a justification in disguise.*

## Rationale

- **Red already means "this will not build" to every VS Code user.** Borrowing that meaning costs
  nothing to teach. Inventing a local one costs an explanation nobody reads.
- **A warning that means "your build will fail" destroys the warning.** Users learn the level is
  unreliable, start ignoring it, and then a real build failure is invisible. Three of seven were
  teaching exactly that.
- **The rule is decidable by experiment**, which is why it is worth having. Every entry in the
  table was settled by writing a `.jd` file and running `jpipe diagnostic` on it. A rule that can
  be checked is a rule that can be enforced; "is this serious enough to be an error?" cannot be.
- **A softer rule was considered and rejected**: error for what is actively wrong, warning for what
  is merely unfinished. It is kinder while typing and it reintroduces exactly the fuzziness this
  record exists to remove — "merely unfinished" is a judgement, and every diagnostic here can be
  reached by a model halfway through being written.
- **Three severities were considered and rejected**: error, information for "the build fails but
  you are probably not finished", warning for "builds but suspect". It is defensible, but it adds a
  level to adjudicate for a benefit VS Code renders faintly enough to be missed.
- **A `Record<JpipeIssueCode, JpipeSeverity>` rather than a lookup with a default**, so a new code
  with no declared severity fails to compile. A default would silently make the omission a policy
  decision.

## Consequences

- **A half-written model is red.** Type `justification J { conclusion c is "C" }` and the conclusion
  is an error until something supports it. That is the honest report — at that moment the file does
  not compile — but it is a visible change from warnings, and it is the cost of the rule.
- **The rule binds this repository to the compiler's judgement.** If the compiler ever starts
  accepting something it rejects today, our severity is silently wrong, and nothing here can detect
  it: no test can see across the repository boundary. The reasons in `JpipeIssueSeverity` name the
  upstream behaviour each entry depends on so that the assumption is at least findable — the same
  exposure, and the same mitigation, as the vendored vocabulary in ADR-VSC-0022.
- **The exception is a door, and it must not be widened casually.** "The editor cannot know" is
  true of a great deal if argued loosely, and it would become a way to downgrade anything
  inconvenient. It applies only where the compiler consults state the editor genuinely cannot see —
  today, a registry populated at startup. Adding a second instance means revising this record.
- **Choosing `'warning'` requires editing a list.** Compile-time exhaustiveness forces a decision;
  a test asserting the warning set is exactly the three documented codes forces the *right*
  decision, since adding one means confronting the sentence that says the compiler must accept the
  file.
- **Checks report through `report()`, never `accept()` directly.** No call site carries a
  severity literal, and each names its code once. `issue()` does the work underneath, so the
  `code` + `data.code` duality that quick-fix dispatch depends on is preserved.
- **A rule's fixture must be checked against the compiler, not only asserted.** A test that pins
  a diagnostic on a fixture only shows the editor is consistent with itself; whether the fixture
  really is a file the compiler rejects (or accepts) is settled by running `jpipe diagnostic` on
  it.
- **This says nothing about which rules are checked.** The gaps listed in ADR-VSC-0022 are
  unchanged; `002_unsupported_elements.jd` still shows the compiler reporting
  `sub-conclusion-supported` where the editor is silent. Getting the severities right on the rules
  we do have does not add the ones we do not.

