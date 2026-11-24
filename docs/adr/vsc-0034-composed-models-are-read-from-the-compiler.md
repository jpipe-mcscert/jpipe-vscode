# ADR-VSC-0034: A composed model's elements are read from the compiler, never recomputed

**Date:** 2026-11-22
**Status:** Accepted

## Context

A composed model has no body: `template T is refine(P, Q) { hook: "a" }` and
`justification K is assemble(J, T) { … }` are built by the compiler's `CompositionOperator`
subclasses and its `Unifier`. They create elements under ids no `.jd` file declares (`P:b`,
`l:top:h`), aliases registered by `RegisterAlias` commands, and, for `assemble`, a conclusion
synthesised from `conclusionLabel`. `implements` then hands those elements down to every model
below the composition.

The language server reads bodies only, so none of this is visible to it. Every feature that needs
a model's whole element list therefore cannot handle a model built on a composition. That covers
the rules `conclusion-present`, `has-abstract-support`, `no-abstract-support`, `unknown-hook`
and `ambiguous-id`, and also completion, hover, rename and go-to-definition through such a model.
Until 2.0.1 some of these rules reported errors on models the compiler builds (jpipe-compiler
example 028, #126). The fix makes them stay silent on such models, which leaves models the
compiler refuses shown clean (#127).

There were two ways to give the editor those elements. One was to port the operators to
TypeScript, as `jpipe-glob.ts` ports Java NIO globs (jpipe-vscode ADR-VSC-0007). The other was
to ask the compiler, which already reports every model it builds.

It reports them in two places. `jpipe process -f json` exports one model, and since 4.0.0
(jpipe-compiler #200) each element carries its `origins`, every source element it was built from.
`jpipe diagnostic -f json` reports a whole file, under a published schema (`schemaVersion` 1,
since 2.4.0), and the preview's diagnostics view already reads it. For every model it lists the
elements under the ids the compiler gives them in that file, with their kinds, where each is
declared, and the model's aliases. Its diagnostics say where each problem is.

When any model of a file fails, the compiler exits with an error and still writes both. A model
that failed to build appears in them as far as it got, with the elements after the failure
missing (jpipe-compiler example 035: `twice`, `once`). Read as whole, such a model is missing
elements, and rules then report what is not wrong.

## Decision

**Composition operators are implemented once, in the compiler. The language server never builds,
simulates or approximates what `refine`, `assemble` or unification produce. When a feature needs
the elements of a model built on a composition, they come from the compiler's diagnostic report
of the file asking.**

They come through one polymorphic API, so a consumer never knows, or asks, which kind of model it
holds:

- **One question, one answer type.** A consumer asks for a model's contents
  (`ModelContents.contentsOf`, in `jpipe-model-contents.ts`) and receives either its effective
  elements, under the ids the compiler gives them, with the kind each has there, or *cannot
  tell*. Validation rules, completion, rename and definition all ask this question, as will hover
  once it shows a model's elements. None of them reads an element list around it:
  `getAllElements` and `expandedElements` are imported only by the declared implementation and by
  linking (below), which `test/model-contents.test.ts` holds.
- ***Cannot tell* lists what it can see.** It carries the elements the bodies show, and which of
  them the model declares itself. A consumer may find one of those by its exact id, since what a
  model declares replaces any element of that id it inherits; an inherited element may share its
  id with a hidden one. It may never conclude from them that an element is missing, nor that an
  id names only one element. That is what keeps a `refine` hook spelling an exact id renamed on a
  base built on a composition, and a `@support` the bodies show required of a justification
  below one.
- **Two implementations behind it, chosen by the service.**
  - *Declared* contents serve a model whose `implements` chain is plain. They are read from the
    bodies (`expandedElements`), which bind each override as the compiler binds it: by its exact
    id, or by the one inherited `@support` its id ends.
  - *Compiled* contents serve a model that builds on a composition. The composed model nearest
    it on its chain is read from the report, and the bodies of the models between are read on
    top of it, as for a plain chain.
- **The report is the asking file's, and ids are the ones it gives.** A model of a file loaded
  under a namespace is named there as the compiler names everything of such a file: `lib:T`,
  `lib:pattern:abs2`. The report of the file asking gives exactly those, so the editor never
  works out how an operator's result is renamed under a namespace.
- **A model is read from the report only when it was built whole.** No failure the report
  locates may lie in the composed model or in any model it is built from. A failure located
  nowhere, under a code, may concern any of them. Diagnostics of the compiler's validation rules
  (`RULE_CODES`) are not failures: they run on a model already built, and may lie in another
  model (`no-abstract-support` lies on the `@support`). Nor are those the compiler recovers from
  while reading a model (`RECOVERED_CODES`): `inherited-conclusion` drops a conclusion, and the
  model is built whole without it.
- **A model is read from the report only while its files read as saved.** The report places
  elements and failures where the saved files have them. A file the composed model is built from
  must therefore read as saved, in the editor, up to the last of those models it holds: an edit
  above them moves every line the report names, and one below moves none.
- **Compiled elements are tied back to source.** Each element is linked to the declaration the
  report places it at, so identity survives: go-to-definition lands on that declaration, and a
  rename reaches a hook naming an element built from it. An element an operator merged from
  several is marked so, since its one location cannot say which of them a name means, and a
  rename leaves a hook naming it alone. One an operator made up has no declaration.
- **The compiler is reached through the client.** The extension host already knows which
  compiler to run and whether it is recent enough (jpipe-vscode ADR-VSC-0016, ADR-VSC-0032). The
  language server therefore sends the client a request and receives the report; it never starts
  a compiler itself. This keeps the language package free of the editor's settings and of any
  process launching.
- ***Cannot tell* is the answer whenever the compiler cannot give one:** no compiler, one older
  than 4.0.0, a model it did not build whole, a file edited since, a request that fails, or a
  report still on its way. A consumer given that
  answer stays silent, exactly as every rule did on a composed model before. The declared
  implementation gives the same answer for a chain that does not resolve (#129), so consumers
  handle one case, not two.
- **Linking reads the declarations itself.** Langium resolves references synchronously while it
  builds documents, so the scope provider and the import service cannot await contents. They read
  the bodies, and so does completion of a relation's ends, which must offer exactly what linking
  resolves.

## Rationale

- **The operators are the language's semantics, not a lookup.** The glob port is about 300 lines
  matching a frozen JDK algorithm. The operators carry most of the compiler's model-building logic:
  unification, alias registration, conclusion synthesis, inlining order. A second implementation
  would be a second definition of what a jPipe model means.
- **They change with the language, and globs do not.** Every change to an operator would have to
  land twice, in two languages and two repositories, with no shared build to catch a mismatch.
  jpipe-vscode ADR-VSC-0022 shows what that costs for a list of diagnostic codes, which is far
  smaller than an operator.
- **The diagnostic report is the export that says whether to trust it.** The model export carries
  richer provenance, but a failed model's export cannot be told from a whole one without a second
  run or reading the compiler's text output. The report locates its own failures, under a schema
  the compiler publishes as a contract, and one run answers for every composed model of a file.
  What it lacks, every origin of a merged element, no feature needs: such an element is marked
  merged instead.
- **Polymorphism keeps the boundary in one place.** If each consumer checked "is this composed?"
  and branched, every new feature would repeat that check and could forget it. A single API keeps
  the decision in one module, and a feature written against it works on both kinds of model.
- **Silence stays the fallback, not an error.** Without the compiler's answer, the editor knows
  nothing it did not know before. Reporting on a guess would put errors on models that build,
  which is the trade jpipe-vscode ADR-VSC-0022 refuses for composed models.
- **A stub that always says *cannot tell* was rejected as the end state.** It is what the editor
  did before this record, and what compiled contents answer without a compiler. It is correct,
  but it leaves features blind exactly where the language is hardest to follow.

## Consequences

- **The contents API is asynchronous for every model.** A compiled answer arrives from another
  process, so a plain model's answer is awaited too, to keep the API uniform. The validation
  checks, completion, rename and code actions that read contents are async. Langium allows that
  for all of them.
- **Compiled contents follow the saved files.** The compiler reads its input and every file it
  loads from disk. Contents built on a composition are therefore as of the last save, while
  declared contents follow the buffer, and an edit above a composed model's sources silences them
  until it is saved. Reports are cached for each file asking, and dropped when that file, or one
  it loads, changes on disk, or when the compiler or its settings change; the documents that read
  them are checked again. An answer without a report is asked again after a minute, since a
  compiler may have been installed outside the editor.
- **Running the compiler costs a JVM start, and nothing waits for it.** A report is asked only
  for a file with a model that builds on a composition, once until a file it reads changes, two
  at a time, and never on a keystroke. Checking a file never waits for one: Langium checks
  documents one after the other, and every file would stand behind each JVM start. Until a
  report arrives, the file is checked as *cannot tell*, and it is checked again when it does,
  under the workspace lock, as every build is. A workspace without compositions never starts the
  compiler for this.
- **A composed model's features depend on a recent compiler.** With no compiler, or one older
  than 4.0.0, they stay silent. This does not raise the minimum compiler (jpipe-vscode
  ADR-VSC-0032): 4.0.0 becomes the recommended release, and Check jPipe Installation says what
  it adds.
- **The diagnostic report is now a contract twice over.** The preview renders it, and compiled
  contents read each model's `symbols` and `aliases`, and the `diagnostics`. A change to that
  shape in the compiler is a new schema version, which the editor does not read until it knows
  it. The adapter is small, and its tests are fed with reports captured from the compiler.
- **A reference to an element only an operator builds does not link.** Linking cannot await the
  report, so a relation naming such an element is reported as unresolved. The compiler refuses it
  too, as `reference-into-template`: a model implementing a template may reference only the
  template's `@support` elements, which it overrides.
- **No feature may reach around the API.** Reading `contents.body`, or calling `getAllElements` or
  `expandedElements` from a rule or a provider, is the bypass this record forbids. Those helpers
  become details of the declared implementation.
- **A `refine` hook is bound as the compiler binds it.** The base's contents tell what a hook
  names, so the editor reports what the compiler refuses there: a hook naming several elements
  (`ambiguous-hook`) or one that is no leaf (`hook-not-leaf`), on any base, as well as one naming
  nothing.
- **Checks decided by the source alone do not need contents.** These include an operator's name,
  arity and configuration keys, its sources resolving, an `implements` or operator cycle, and a
  repeated source (#128). They are written against the AST, as today.
