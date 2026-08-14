# ADR-VSC-0022: One diagnostic vocabulary, and it is the compiler's

**Date:** 2026-08-13
**Status:** Accepted

## Context

Both tools name the defects they find, and they named them independently.

The compiler puts a bare kebab-case string in `Diagnostic.code()` — twenty of them, in two
families sharing one field, as jpipe-compiler ADR-0016 has it: eleven constants in
`DiagnosticCodes.java` that name failures (`unknown-model`, `invalid-support`), and nine
validation rule names reaching the same field through `Violation.rule()` (jpipe-compiler ADR-0015)
that name invariants in the positive (`conclusion-supported`, `no-duplicate-ids`). The extension
consumes those codes: they arrive in the JSON diagnostic report and become the filter chips in the
preview's Diagnostics tab.

The language server had twenty codes of its own, and they differed from the compiler's twice over.
They carried a `jpipe.` prefix, and they named the failure rather than the rule. So one defect —
a conclusion nothing supports — read as `jpipe.conclusion-unsupported` in the Problems panel and
as `conclusion-supported` in the preview, four inches apart in the same window. A user filtering
on one found nothing under the other, and a bug report quoting one was not searchable against the
other.

The prefix earned nothing. Langium already sets `source` to the language id on every diagnostic
it produces (`DefaultDocumentValidator.getSource()`), so VS Code was rendering
`jpipe(jpipe.load-circular)`. And the compiler's own report schema constrains `code` to
`^[a-z0-9]+(-[a-z0-9]+)*$` — a dot is not in that class, so the prefixed names were already
lexically foreign to the vocabulary they sat beside.

## Decision

The two vocabularies are one. Where both tools check the same rule, **the compiler's name is
canonical** and the extension adopts it verbatim; where only the extension checks something, it
coins a name in the compiler's style. The `jpipe.` prefix is gone. A diagnostic code is now the
same string in both tools, and `packages/language/src/jpipe-compiler-codes.ts` records which
family each belongs to.

## The correspondence, and how the coined names were chosen

Six codes are the compiler's, adopted:

| was | is | note |
|---|---|---|
| `jpipe.duplicate-element-id` | `no-duplicate-ids` | exact |
| `jpipe.template-without-support` | `has-abstract-support` | exact, inherited `@support` included on both sides |
| `jpipe.missing-support-override` | `no-abstract-support` | same rule from the opposite vantage — the compiler checks it after the override commands run, we check it before expansion |
| `jpipe.strategy-unsupported` | `strategy-supported` | exact |
| `jpipe.strategy-bad-supporter` | `invalid-support` | **we implement a subset**: the compiler's code covers every ill-typed support pair, we check only the strategy side |
| `jpipe.conclusion-unsupported` + `jpipe.conclusion-no-strategy` | `conclusion-supported` | two codes collapse into one — see below |

Thirteen are coined. Eight of those are the old name with nothing but the prefix removed. Five
were reworded as well: `jpipe.empty-label` and `jpipe.empty-unit` became `no-empty-label` and
`no-empty-unit`, `jpipe.duplicate-model-name` became `no-duplicate-model-names`,
`jpipe.bad-support-override-type` became `support-override-type`, and `jpipe.load-circular` became
`cyclic-load` to rhyme with the compiler's existing `cyclic-implements`.

Coining follows the compiler's own three habits rather than imposing a fourth: a rule the model
must satisfy is phrased as the positive invariant (`no-empty-label`, after `no-duplicate-ids`); a
name that failed to resolve joins the `unknown-*` family; a constrained property with no natural
positive phrasing is named for the property (`operator-arity`, after `single-conclusion`).

Two names were considered and rejected. `missing-config-key` was nearly renamed
`config-key-present` for symmetry with `conclusion-present`, but its natural pair
`unknown-config-key` has no positive phrasing, and splitting a pair to satisfy a rule is worse
than the asymmetry; composition failures are execution-level, which is exactly where the compiler
itself names failures. And `unknown-unification-method` was **not** folded into the compiler's
`incompatible-unification`: that code means unification merged a strategy with an evidence, while
this one means `unifyBy:` named a relation no registry has. Near neighbours, different rules.

**The whole `load-*` family is coined, and always will be.** The compiler reports load failures as
`FATAL`, and jpipe-compiler ADR-0016 states in as many words that a fatal carries no code. There
is nothing upstream to adopt here — not yet, but by policy. Worth saying so a future reader does
not go looking.

### The one collapse

`conclusion-unsupported` (a warning: nothing supports the conclusion) and `conclusion-no-strategy`
(an error: something does, but no strategy does) are one rule to the compiler, and provably so —
for `evidence e; e supports c` it emits `invalid-support` when the relation fails to attach, then
`conclusion-supported` from the completeness pass on the same input. Both now carry
`conclusion-supported`.

The collapse cost nothing to dispatch. Both payloads were already `{ targetId }`, so no
discriminant was needed, and `add-supporter.ts` branches on the AST node rather than on the code,
so it reaches both branches unchanged. Severity is what still tells them apart, and two new cases
in `diagnostic-codes.test.ts` assert exactly that, because nothing else in the suite would have
noticed the collapse quietly losing a branch.

No other pair was collapsed. In particular `load-unresolved` and `load-no-match` stay distinct:
no compiler rule forces them together, and `fix-load-path.ts` registers only the first, since
offering a corrected path is meaningless for a glob that matched nothing.

## Rationale

- **The user reads both surfaces in one window.** The Problems panel and the preview's Diagnostics
  tab are open at the same time on the same file. Two names for one defect is not a tidiness
  complaint; it is the tool contradicting itself where the contradiction is visible.
- **The compiler is the authority on what jPipe rejects.** It is the thing that fails the build.
  The editor's job is to predict it — the same argument that makes the glob matcher a port rather
  than a library (jpipe-vscode ADR-VSC-0007). A vocabulary the editor invents for rules the
  compiler already names is the same divergence in a different place.
- **Meeting in the middle was rejected.** Some extension names read better — `duplicate-element-id`
  says more than `no-duplicate-ids`. Adopting them would mean renaming codes the compiler has
  published in a schema-versioned report, breaking its consumers to improve ours. One repository
  changing is the cheaper half of a symmetric-looking choice.
- **Keeping both vocabularies with a documented mapping was rejected.** It is the cheapest option
  and it fixes nothing the user can see: they still read two names, and the mapping is a document
  no build consults.
- **The prefix was redundant, not merely verbose.** `source` already carries it, so dropping it
  removes a duplication rather than removing information — and it is what makes the two sides
  literally the same string, which is what a test can check.
- **Renaming the TypeScript constants as well as their values** (`DuplicateElementId` →
  `NoDuplicateIds`) doubles the diff. It is worth it: an identifier that no longer resembles its
  code is a second vocabulary, free to drift from the first, and the whole point here is not
  having two.

## Consequences

- **The vocabulary is now a cross-repository contract with no shared build.**
  `jpipe-compiler-codes.ts` vendors the compiler's twenty codes and declares our thirteen, and
  `diagnostic-codes.test.ts` asserts the two lists partition our codes exactly, with no overlap and
  no code left unplaced. That test cannot tell whether the vendored list is current — it does not
  know what the compiler did. What it does is **force the question to be answered when a code is
  added**: the build fails until the author declares whether the compiler already names that rule,
  which is the decision that actually drifts.
- **The vendored list goes stale silently when the compiler adds a rule.** `npm run
  check:codes` re-derives it from a sibling checkout and diffs, but it is **deliberately not a CI
  gate** — CI builds this repository alone, so the gate could never run, and a gate that never runs
  gets deleted. Staleness is caught by a human running the script, or not at all. A generated
  artifact published by the compiler would close this properly; it was rejected for now because it
  needs release plumbing that repository does not have, and because the extension supports a
  *range* of compiler versions, so pinning one version's vocabulary would fail against the others.
- **A code shape check now exists**, matching the compiler's report schema pattern. It is what
  makes the prefix drop permanent rather than a one-time edit.
- **Codes are now ambiguous between sources, by design.** Nothing pooling an exported Problems
  list with a compiler report can tell an LSP `conclusion-supported` from a compiler one by the
  code alone. The discriminators are `source: 'jpipe'` on one side and the report envelope on the
  other.
- **A user with `jpipe.load-unresolved` typed into the Problems panel filter sees it stop
  matching.** No code value was a public contract otherwise — no setting names one, no
  `codeDescription` exists, no suppression syntax puts one in a `.jd` file, and none appeared in
  the README, the CHANGELOG or any earlier ADR.
- **Immediately after an upgrade, a client may still hold diagnostics from the old server.**
  `issueCodeOf` returns `undefined` for a `jpipe.`-prefixed code, so the lightbulb is quiet on
  those problems until the document revalidates on the next keystroke. Degradation, not breakage.
- **The dispatcher needed no change at all.** `jpipe-code-action-provider.ts` builds its
  `MultiMap` from each fix's declared `codes` at runtime, so nineteen codes route exactly as twenty
  did. That is the design in jpipe-vscode ADR-VSC-0004 paying for itself.
- **Harmonizing the names did not harmonize the coverage, and this record should not be read as
  claiming it did.** The compiler errors and the editor stays silent on `conclusion-present`,
  `sub-conclusion-supported`, `acyclic-support`, `acyclic-implements`, `single-conclusion`,
  `unresolved-override`, `cyclic-implements`, `implements-error`, `reference-into-template` and
  `incompatible-unification`; `invalid-support` is implemented only for strategies. `unknown-model`
  and `unknown-element` *are* covered, but under Langium's own `linking-error`, a vocabulary we do
  not own — the seam `add-missing-load.ts` already keys on. Closing those gaps is separate work,
  and this record's value is that each of them now has a name to be filed under.
- **One finding belongs upstream, not here.** `ApplyOperator.java` and `Unifier.java` bake
  `"[execution-error] "` into their exception *messages*, which jpipe-compiler ADR-0016 forbids
  ("the code is data, not text"), so the human renderer prints the bracket twice. It is a
  compiler-repo bug and it is good evidence for this record: a shared vocabulary drifted from its
  own rule *inside a single repository*, which is why the one spanning two needs a check.

## Amendment (2026-08-13): `conclusion-present` is now implemented

The first of the gaps listed above is closed. `checkModelHasConclusion` reports a justification or
template whose elements include no conclusion, as an **error** — the compiler refuses to build such
a model, and this repository's rule is that a diagnostic is an error exactly when the build will
actually fail (the reasoning already written into `checkConfigKeys`).

Adding it cost one line in `JpipeIssue` and no thought at all about what to call it, which is the
first evidence that this record earns its keep: `conclusion-present` was already in
`COMPILER_CODES`, so the partition test went green without `jpipe-compiler-codes.ts` being touched.
The name was not a decision to be made — it had already been made, upstream, and the vocabulary
file said so.

Two subtleties, both settled by reading the compiler rather than by choosing:

- **Inherited conclusions count.** The compiler checks completeness *after* `implements` has
  inlined the parent's elements, so the check reads `getAllElements`, not `getLocalElements`.
- **Composed models are skipped.** `justification K is assemble(J, T) { … }` has no body; its
  elements exist only once the operator has run, and `assemble` synthesises a conclusion from
  `conclusionLabel`. The compiler judges the *result* and is satisfied. A first version of this
  check judged the source text and reported an error on a model that builds — caught by an existing
  fixture in `renaming.test.ts`, which is what that fixture's "nothing wrong with it" assertion is
  for. The cost is accepted and is the right way round: a composition whose result genuinely lacks
  a conclusion is caught by the compiler and not by the editor, and silence about a real problem
  beats noise about one that is not (the same trade jpipe-vscode ADR-VSC-0007 makes for globs).

No quick fix is offered. Writing a conclusion means writing the claim the argument exists to make,
and that is the one thing in a `.jd` file the editor cannot guess.

The remaining gaps are unchanged: `sub-conclusion-supported`, `acyclic-support`,
`acyclic-implements`, `single-conclusion`, `unresolved-override`, `cyclic-implements`,
`implements-error`, `reference-into-template`, `incompatible-unification`, and `invalid-support`
beyond strategies.

## Amendment (2026-08-13): `single-conclusion`, and a rule that removes a diagnostic

The second gap is closed, and it is the more interesting one, because most of its value is in what
the editor now *stops* saying.

On the compiler's own `examples/invalid/005_multiple_conclusion.jd` the editor used to report that
the second conclusion had no supporting strategy. That was true, and it was the wrong problem: the
compiler keeps the first conclusion a model declares and **discards** every later one
(`ActionListProvider.enterConclusion` returns without creating it), so it never asks whether the
second is supported. It reports one error, `single-conclusion`, on the extra declaration. The
editor was answering "you have written two conclusions" with a remark about an element that was
never going to exist.

So this amendment adds two things, and the second is not optional:

- `checkSingleConclusion` reports every conclusion after the first, anchored on the extra's id so
  the first is left unmarked — the shape `checkDuplicateElementIds` already uses, and the anchor
  the compiler already uses.
- `checkConclusionIncomingFromStrategy` now returns early for a conclusion that is not the first
  in its model. Suppressing a true statement needs justifying, and the justification is that the
  compiler's model does not contain the element the statement is about.

The two outputs are now identical on that file, down to the column:

```
[ERROR] 10:15 [single-conclusion] Model 'j' declares multiple conclusions
[ERROR] 21:15 [single-conclusion] Model 't' declares multiple conclusions
```

**Messages for shared rules copy the compiler's wording.** `conclusion-present` was written in the
previous amendment as `Justification 'J' has no conclusion`, following the extension's local habit
of naming the kind; it now reads `Model 'J' has no conclusion`, as the compiler words it. The
extension's own checks keep their own voice — the habit is right for a rule only the editor has.
For a rule both tools enforce, a user searching the message should find one explanation, which is
the argument jpipe-vscode ADR-VSC-0007 already makes about the glob errors.

**The cost is a coupling that nothing detects.** Suppressing `conclusion-supported` on later
conclusions is correct only for as long as the compiler discards them. If it ever kept both and
reported on both, the editor would go quiet about a real problem — the failure mode this record
elsewhere calls the worse one, because it is invisible. No test can see across the repository
boundary; the comment in `checkConclusionIncomingFromStrategy` names the assumption so that
anyone changing that behaviour upstream has a chance of finding it.

Remaining gaps: `sub-conclusion-supported`, `acyclic-support`, `acyclic-implements`,
`unresolved-override`, `cyclic-implements`, `implements-error`, `reference-into-template`,
`incompatible-unification`, and `invalid-support` beyond strategies.
