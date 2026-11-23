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
the rules `conclusion-present`, `has-abstract-support`, `unknown-hook`, `ambiguous-id` and
`unique-identifiers`, and also completion, hover, rename and go-to-definition through such a
model. Until 2.0.1 some of these rules reported errors on models the compiler builds
(jpipe-compiler example 028, #126). The fix makes them stay silent on such models, which leaves
models the compiler refuses shown clean (#127).

There were two ways to give the editor those elements. One was to port the operators to
TypeScript, as `jpipe-glob.ts` ports Java NIO globs (jpipe-vscode ADR-VSC-0007). The other was
to ask the compiler, which already exports a built model as JSON. Since 4.0.0 (jpipe-compiler
#200), each element of that export carries its `origins`, the declaring model and id of every
source element it was built from, and its `aliases`.

## Decision

**Composition operators are implemented once, in the compiler. The language server never builds,
simulates or approximates what `refine`, `assemble` or unification produce. When a feature needs
the elements of a model built on a composition, they come from the compiler.**

They come through one polymorphic API, so a consumer never knows, or asks, which kind of model it
holds:

- **One question, one answer type.** A consumer asks for a model's contents
  (`ModelContents.contentsOf`, in `jpipe-model-contents.ts`) and receives either its effective
  elements, under the ids the compiler gives them, or *cannot tell*. Validation rules,
  completion, rename and definition all ask this question, as will hover once it shows a model's
  elements. None of them reads an element
  list around it: `getAllElements` and `expandedElements` are imported only by the declared
  implementation and by linking (below), which `test/model-contents.test.ts` holds.
- ***Cannot tell* lists what it can see.** It carries the elements the bodies show, and which of
  them the model declares itself. A consumer may find one of those by its exact id, since what a
  model declares replaces any element of that id it inherits; an inherited element may share its
  id with a hidden one. It may never conclude from them that an element is missing. That is what keeps
  a `refine` hook spelling an exact id renamed on a base built on a composition.
- **Two implementations behind it, chosen by the service.**
  - *Declared* contents serve a model whose `implements` chain is plain. They are read from the
    bodies (`expandedElements`).
  - *Compiled* contents serve a model that builds on a composition. They are read from the
    compiler's JSON export of that model.
- **Linking reads the declarations itself.** Langium resolves references synchronously while it
  builds documents, so the scope provider and the import service cannot await contents. They read
  the bodies, as before; a reference to an element only an operator builds is compiled contents'
  concern, served to linking from their cache.
- **Compiled elements are tied back to source.** Each element is linked to the AST declarations
  its `origins` name, so identity survives: renaming `@support abs2` in `pattern` reaches every
  element built from it, and go-to-definition lands on that declaration.
- **The compiler is reached through the client.** The extension host already knows which
  compiler to run and whether it is recent enough (jpipe-vscode ADR-VSC-0016, ADR-VSC-0032). The
  language server therefore sends the client a request and receives the export; it never starts
  a compiler itself. This keeps the language package free of the editor's settings and of any
  process launching.
- ***Cannot tell* is the answer whenever the compiler cannot give one:** no compiler, one older
  than 4.0.0, a model with errors the compiler refuses to build, or a request that fails. A
  consumer given that answer stays silent, exactly as every rule does on a composed model today.
  The declared implementation gives the same answer for a chain that does not resolve (#129), so
  consumers handle one case, not two.

## Rationale

- **The operators are the language's semantics, not a lookup.** The glob port is about 300 lines
  matching a frozen JDK algorithm. The operators carry most of the compiler's model-building logic:
  unification, alias registration, conclusion synthesis, inlining order. A second implementation
  would be a second definition of what a jPipe model means.
- **They change with the language, and globs do not.** Every change to an operator would have to
  land twice, in two languages and two repositories, with no shared build to catch a mismatch.
  jpipe-vscode ADR-VSC-0022 shows what that costs for a list of diagnostic codes, which is far
  smaller than an operator.
- **The compiler already publishes what the editor needs.** The JSON export is the built model,
  with provenance. Reading it costs an adapter, while porting the operators would cost a
  reimplementation.
- **Polymorphism keeps the boundary in one place.** If each consumer checked "is this composed?"
  and branched, every new feature would repeat that check and could forget it. A single API keeps
  the decision in one module, and a feature written against it works on both kinds of model.
- **Silence stays the fallback, not an error.** Without the compiler's answer, the editor knows
  nothing it did not know before. Reporting on a guess would put errors on models that build,
  which is the trade jpipe-vscode ADR-VSC-0022 refuses for composed models.
- **A stub that always says *cannot tell* was rejected as the end state.** It is what the editor
  did before this record, and what compiled contents answer until they read the compiler's
  export. It is correct, but it leaves features blind exactly where the language is hardest to
  follow.

## Consequences

- **The contents API is asynchronous for every model.** A compiled answer arrives from another
  process, so a plain model's answer is awaited too, to keep the API uniform. The validation
  checks, completion and rename that read contents become async. Langium allows that for all
  three.
- **Compiled contents follow the saved files.** The compiler reads its input and every file it
  loads from disk. Contents built on a composition are therefore as of the last save, while
  declared contents follow the buffer. Answers are cached for each model, and the cache is dropped
  when a file the model loads is saved.
- **Running the compiler costs a JVM start.** Requests are made only for models that build on a
  composition, are cached, and are never sent on a keystroke. A workspace without compositions
  never starts the compiler for this.
- **A composed model's features depend on a recent compiler.** With no compiler, or one older
  than 4.0.0, they stay silent. This does not raise the minimum compiler (jpipe-vscode
  ADR-VSC-0032): it is something a 4.0.0 compiler adds, and Check jPipe Installation says so.
- **The JSON export is now a contract.** The adapter reads `elements`, `relations`, `aliases` and
  `origins`. A change to that shape in the compiler breaks the editor, which is a reason to keep
  the adapter small and its tests fed with real exports.
- **No feature may reach around the API.** Reading `contents.body`, or calling `getAllElements` or
  `expandedElements` from a rule or a provider, is the bypass this record forbids. Those helpers
  become details of the declared implementation.
- **Checks decided by the source alone do not need contents.** These include an operator's name,
  arity and configuration keys, its sources resolving, an `implements` or operator cycle, and a
  repeated source (#128). They are written against the AST, as today.
