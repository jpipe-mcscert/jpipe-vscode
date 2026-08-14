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

## What follows, and what had to change

Two consequences look like separate decisions and are not — they fall out of the rule.

**A rule only the editor has can never be an error.** A check the compiler does not run cannot fail
a build, so it can only ever be a warning. That is the whole reason `no-empty-label` is one, and it
is now a derivation rather than a judgement.

**Severity can be attached to the code rather than the call site** — but only because the rule
removes the one code that needed two. `conclusion-supported` was deliberately emitted at both
severities, warning for "nothing supports this" and error for "supported, but not by a strategy".
The compiler rejects both, so both are errors, and message text becomes the only thing telling the
two branches apart. The two messages must therefore stay distinct, and a test in
`diagnostic-codes.test.ts` now pins them; that test previously pinned the severities.

Three diagnostics moved from warning to error: `has-abstract-support`, `strategy-supported`,
`conclusion-supported`. Four stayed warnings, each confirmed by running `jpipe diagnostic` and
seeing it exit 0: `no-empty-label`, `no-empty-unit` (both editor-only style rules the compiler does
not check), `unknown-config-key` (unrecognised keys are ignored), and the exception.

`has-abstract-support` also needed rewording. Its message was advisory prose — "Justifications
implementing this template are not required to override any elements" — which is exactly why it
looked like a warning. It now uses the compiler's own words, `Template 't' declares no abstract
supports`, per the message rule in ADR-VSC-0022's second amendment. The compiler's note for that
rule is the better explanation anyway: *a template with no abstract supports is a justification in
disguise.*

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
  today, a registry populated at startup. Adding a second instance needs an amendment here.
- **Choosing `'warning'` requires editing a list.** Compile-time exhaustiveness forces a decision;
  a test asserting the warning set is exactly the four documented codes forces the *right*
  decision, since adding one means confronting the sentence that says the compiler must accept the
  file.
- **`report()` replaced 23 `accept()` calls.** The severity literal is gone from every call site
  and the code is named once instead of twice. `issue()` still does the work underneath, so the
  `code` + `data.code` duality that quick-fix dispatch depends on is untouched, and
  `jpipe-code-action-provider.ts` needed no change.
- **This says nothing about which rules are checked.** The gaps listed in ADR-VSC-0022 are
  unchanged; `002_unsupported_elements.jd` still shows the compiler reporting
  `sub-conclusion-supported` where the editor is silent. Getting the severities right on the rules
  we do have does not add the ones we do not.
