# ADR-VSC-0022: One diagnostic vocabulary, and it is the compiler's

**Date:** 2026-08-13
**Status:** Accepted

## Context

Both tools name the defects they find, and they named them independently.

The compiler puts a bare kebab-case string in `Diagnostic.code()`, in two families sharing one
field, as jpipe-compiler ADR-0016 has it: the constants in `DiagnosticCodes.java`, which name
failures (`unknown-model`, `invalid-support`), and the validation rule names reaching the same
field through `Violation.rule()` (jpipe-compiler ADR-0015), which name invariants in the positive
(`conclusion-supported`, `no-duplicate-ids`). The extension consumes those codes: they arrive in
the JSON diagnostic report and become the filter chips in the preview's Diagnostics tab.

The language server had codes of its own, and they differed from the compiler's twice over. They
carried a `jpipe.` prefix, and they named the failure rather than the rule. So one defect — a
conclusion nothing supports — read as `jpipe.conclusion-unsupported` in the Problems panel and as
`conclusion-supported` in the preview, four inches apart in the same window. A user filtering on
one found nothing under the other, and a bug report quoting one was not searchable against the
other.

The prefix earned nothing. Langium already sets `source` to the language id on every diagnostic
it produces (`DefaultDocumentValidator.getSource()`), so VS Code was rendering
`jpipe(jpipe.load-circular)`. And the compiler's own report schema constrains `code` to
`^[a-z0-9]+(-[a-z0-9]+)*$` — a dot is not in that class, so the prefixed names were lexically
foreign to the vocabulary they sat beside.

## Decision

The two vocabularies are one. Where both tools check the same rule, **the compiler's name is
canonical** and the extension uses it verbatim; where only the extension checks something, it
coins a name in the compiler's style. Codes carry no prefix and match the compiler's schema
pattern. A diagnostic code is the same string in both tools.

For a rule both tools enforce, **the message uses the compiler's wording too**, not only its
code. Rules only the editor has keep the editor's own voice.

`packages/language/src/jpipe-compiler-codes.ts` vendors the compiler's codes and declares the
ones this extension coins. `npm run check:codes` compares the vendored list with a sibling
jpipe-compiler checkout, and `scripts/release.sh preflight` runs it.

## The vocabulary, rule by rule

**Adopted from the compiler:**

| Code | How the editor's check relates to the compiler's |
|---|---|
| `no-duplicate-ids` | exact |
| `has-abstract-support` | exact, inherited `@support` included on both sides |
| `no-abstract-support` | same rule from the opposite vantage — the compiler checks it after the override commands run, the editor before expansion |
| `strategy-supported` | exact |
| `invalid-support` | **a subset**: the compiler covers every ill-typed support pair, the editor only the strategy side |
| `conclusion-supported` | one code over two checks — see below |
| `conclusion-present` | inherited conclusions count; composed models are skipped — see below |
| `single-conclusion` | exact, down to the anchor column |

**Coined by the extension**, for one of three reasons. The distinction matters when the compiler
next gains a rule, and `jpipe-compiler-codes.ts` keeps each code under its reason:

- *The compiler does not check it at all:* `no-empty-label`, `unknown-config-key`,
  `support-override-type`.
- *The compiler checks it, but reports it as the `execution-error` catch-all,* so there is no name
  to adopt: `no-duplicate-model-names`, `unknown-operator`, `operator-arity`,
  `missing-config-key`, `unknown-unification-method`, `unknown-hook`.
- *The compiler reports it as `FATAL`, and a fatal carries no code by policy*
  (jpipe-compiler ADR-0016): the whole `load-*` family, `cyclic-load`, and `no-empty-unit`. There
  is nothing upstream to adopt for these, by policy rather than by omission.

Coining follows the compiler's own three habits rather than imposing a fourth: a rule the model
must satisfy is phrased as the positive invariant (`no-empty-label`, after `no-duplicate-ids`); a
name that failed to resolve joins the `unknown-*` family; a constrained property with no natural
positive phrasing is named for the property (`operator-arity`, after `single-conclusion`).
`cyclic-load` rhymes with the compiler's `cyclic-implements`.

A coined name that the compiler later gains a rule for is renamed to the compiler's name.

**`conclusion-supported` covers two checks** — nothing supports the conclusion, or something does
but no strategy does — because they are one rule to the compiler: for `evidence e; e supports c`
it emits `invalid-support` when the relation fails to attach, then `conclusion-supported` from the
completeness pass on the same input. Both payloads are `{ targetId }`, and `add-supporter.ts`
branches on the AST node rather than the code, so one fix serves both. Both are errors
(jpipe-vscode ADR-VSC-0023), so only the messages tell them apart, and `diagnostic-codes.test.ts`
pins them as distinct.

No other pair is collapsed. `load-unresolved` and `load-no-match` stay distinct: no compiler rule
forces them together, and `fix-load-path.ts` registers only the first, since offering a corrected
path is meaningless for a glob that matched nothing.

**`conclusion-present` reads `getAllElements`**, because the compiler checks completeness after
`implements` has inlined the parent's elements. **It skips composed models**:
`justification K is assemble(J, T) { … }` has no body, its elements exist only once the operator
has run, and `assemble` synthesises a conclusion from `conclusionLabel`. The compiler judges the
result, and so cannot be predicted from the source text. No quick fix is offered — writing a
conclusion means writing the claim the argument exists to make, which the editor cannot guess.

**`single-conclusion` fires on every conclusion after the first**, anchored on the extra one's
id, leaving the first unmarked — the anchor the compiler uses. The compiler keeps the first
conclusion a model declares and discards every later one (`ActionListProvider.enterConclusion`
returns without creating it), so it never asks whether a later conclusion is supported. The
editor therefore does not report `conclusion-supported` on a later conclusion either.

**Rules the editor does not check.** The compiler reports, and the editor is silent on:
`sub-conclusion-supported`, `acyclic-support`, `acyclic-implements`, `unresolved-override`,
`cyclic-implements`, `implements-error`, `reference-into-template`, `incompatible-unification`,
and `invalid-support` beyond strategies. `unknown-model` and `unknown-element` *are* covered, but
under Langium's own `linking-error`, a vocabulary this repository does not own — the seam
`add-missing-load.ts` keys on.

**`unique-identifiers` is out of reach, not merely undone.** It is not `no-duplicate-ids`
renamed: that rule covers element ids within a model, while `unique-identifiers` covers every
identifier an *exported* model can be addressed by — the ids plus the aliases a merge leaves
behind, since every id unified into an element keeps addressing it. A key landing on two elements
gives a consumer no way to choose, and `jpipe-runner` discards the whole model rather than guess.
Aliases are created only by `CompositionOperator` and `Unifier`, as `RegisterAlias` commands, so
no `.jd` file names one and none exists until an operator has run. Checking the rule would mean
executing unification in the language server — the boundary `conclusion-present` declines to
cross for composed models. It is vendored to be filed, and its entry in `COMPILER_CODES` says so.

## Rationale

- **The user reads both surfaces in one window.** The Problems panel and the preview's Diagnostics
  tab are open at the same time on the same file. Two names for one defect is not a tidiness
  complaint; it is the tool contradicting itself where the contradiction is visible.
- **The compiler is the authority on what jPipe rejects.** It is the thing that fails the build.
  The editor's job is to predict it — the same argument that makes the glob matcher a port rather
  than a library (jpipe-vscode ADR-VSC-0007). A vocabulary the editor invents for rules the
  compiler already names is the same divergence in a different place.
- **Shared messages follow from shared codes.** A user searching a message should find one
  explanation, which is the argument jpipe-vscode ADR-VSC-0007 makes about the glob errors. The
  editor's habit of naming the kind (`Justification 'J' …`) stays right for its own rules; for a
  shared one, the compiler's `Model 'J' …` wins.
- **Meeting in the middle was rejected.** Some editor names read better — `duplicate-element-id`
  says more than `no-duplicate-ids`. Adopting them would mean renaming codes the compiler publishes
  in a schema-versioned report, breaking its consumers to improve ours.
- **Keeping both vocabularies with a documented mapping was rejected.** It is the cheapest option
  and it fixes nothing the user can see: they still read two names, and the mapping is a document
  no build consults.
- **The prefix was redundant, not merely verbose.** `source` already carries it, so leaving it off
  removes a duplication rather than information — and it is what makes the two sides literally the
  same string, which is what a test can check.
- **The TypeScript constants are named after their codes** (`NoDuplicateIds` for
  `no-duplicate-ids`). An identifier that does not resemble its code is a second vocabulary, free
  to drift from the first.
- **Two names were considered and rejected.** `missing-config-key` was nearly renamed
  `config-key-present` for symmetry with `conclusion-present`, but its natural pair
  `unknown-config-key` has no positive phrasing, and splitting a pair to satisfy a rule is worse
  than the asymmetry. `unknown-unification-method` was **not** folded into the compiler's
  `incompatible-unification`: that code means unification merged a strategy with an evidence,
  while this one means `unifyBy:` named a relation no registry has.
- **Suppressing `conclusion-supported` on a later conclusion withholds a true statement**, and the
  justification is that the compiler's model does not contain the element the statement is about.
  Reporting it answers "you have written two conclusions" with a remark about an element that was
  never going to exist.
- **Skipping composed models trades a miss for a false alarm, deliberately.** A composition whose
  result lacks a conclusion is caught by the compiler and not the editor; judging the source text
  would instead report an error on a model that builds. Silence about a real problem beats noise
  about one that is not — the same trade jpipe-vscode ADR-VSC-0007 makes for globs.
- **The vocabulary check runs at release, not in CI and not in `npm test`.** CI builds this
  repository alone, so a CI gate could never run, and a gate that never runs gets deleted. In
  `npm test`, an unrelated change would go red because of the state of a sibling checkout.
  Fetching the compiler's sources over the network would gate the build on somebody else's
  availability and still have to pick a version. A release is the one moment the answer has
  consequences: it is when this repository decides which compiler it claims to work with.
- **A generated vocabulary published by the compiler was rejected** for now. It needs release
  plumbing that repository does not have, and the extension supports a *range* of compiler
  versions, so pinning one version's vocabulary would fail against the others.

## Consequences

- **The vocabulary is a cross-repository contract with no shared build.** `diagnostic-codes.test.ts`
  asserts that the vendored and coined lists partition this extension's codes exactly, with no
  overlap and no code left unplaced, and that every code matches the schema pattern. It cannot
  tell whether the vendored list is current. What it does is **force the question when a code is
  added**: the build fails until the author declares whether the compiler already names that rule,
  which is the decision that actually drifts.
- **Between releases, the vendored list can go stale silently.** The release preflight is a
  trigger, not a guarantee. A missing jpipe-compiler checkout makes it warn rather than fail,
  because releasing from a machine without one is legitimate and a check that could not run must
  never read as one that passed; a stale checkout still reports `ok`.
- **`check:codes` finds compiler codes with two globs**, and errors only when a glob matches
  nothing. A rule added to a file it already reads is caught; a validator outside
  `model/validation/`, or a code declared away from `DiagnosticCodes`, would be missed in silence.
  jpipe-compiler ADR-0016 requires every code to be a `DiagnosticCodes` constant, so the globs are
  sound by upstream policy — and inherit that policy's fate.
- **Some correctness here rests on compiler behaviour no test can see.** Suppressing
  `conclusion-supported` on later conclusions is right only while the compiler discards them; if
  it ever kept both, the editor would go quiet about a real problem. The comment in
  `checkConclusionIncomingFromStrategy` names the assumption so that it is findable.
- **Codes are ambiguous between sources, by design.** Nothing pooling an exported Problems list
  with a compiler report can tell an LSP `conclusion-supported` from a compiler one by the code
  alone. The discriminators are `source: 'jpipe'` on one side and the report envelope on the
  other.
- **A code value is not otherwise a public contract.** No setting names one, no `codeDescription`
  exists, and no suppression syntax puts one in a `.jd` file. `issueCodeOf` returns `undefined`
  for a code it does not know, so a stale diagnostic simply gets no quick fix.
- **Renaming or merging codes needs no dispatcher change.** `jpipe-code-action-provider.ts` builds
  its `MultiMap` from each fix's declared `codes` at runtime — jpipe-vscode ADR-VSC-0004 paying for
  itself.
- **One vocabulary is not one coverage.** The rules the editor does not check are listed above,
  and this record should not be read as claiming otherwise; its value there is that each gap has a
  name to be filed under.
- **One defect belongs upstream.** `ApplyOperator.java`, `Unifier.java` and `RefineOperator.java`
  bake `"[execution-error] "` into their exception *messages*, which jpipe-compiler ADR-0016 forbids
  ("the code is data, not text"), so the human renderer prints the bracket twice. A shared
  vocabulary drifting from its own rule inside a single repository is the strongest argument for
  checking the one that spans two.
