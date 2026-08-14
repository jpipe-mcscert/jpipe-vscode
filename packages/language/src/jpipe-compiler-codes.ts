/**
 * The compiler's diagnostic vocabulary, vendored, and the part of ours that it does not cover.
 *
 * The extension and the compiler report the same defects, and jpipe-vscode ADR-VSC-0022 makes the
 * compiler's names canonical wherever both check the same rule. Nothing enforces that across two
 * repositories with no shared build, so the vocabulary is copied here and the partition below is
 * asserted in `test/diagnostic-codes.test.ts`.
 *
 * The point of the partition is not to detect what the compiler did — it cannot. It is to force
 * whoever adds the next code to *decide* whether the compiler already names that rule, at the
 * moment they add it, rather than discovering the answer after both names have shipped.
 *
 * SOURCE: jpipe-compiler v2.4.0 (b79b400), copied 2026-08-13 from
 *   jpipe-compiler/src/main/java/ca/mcscert/jpipe/compiler/model/DiagnosticCodes.java
 *   jpipe-model/src/main/java/ca/mcscert/jpipe/model/validation/ConsistencyValidator.java
 *   jpipe-model/src/main/java/ca/mcscert/jpipe/model/validation/CompletenessValidator.java
 * Refresh it by re-reading those three files; `npm run check:codes` does the comparison when a
 * jpipe-compiler checkout sits beside this one.
 */

/**
 * Every code the compiler can put in `Diagnostic.code()`.
 *
 * Two families sharing one field, as jpipe-compiler ADR-0016 has it: the constants of
 * `DiagnosticCodes`, which name failures, and the validation rule names reaching the same field
 * through `Violation.rule()` (jpipe-compiler ADR-0015), which name invariants in the positive.
 * The extension implements only a subset — see ADR-VSC-0022 for what it stays silent on.
 */
export const COMPILER_CODES = [
    // DiagnosticCodes.java
    'single-conclusion',
    'unresolved-override',
    'cyclic-implements',
    'implements-error',
    'reference-into-template',
    'invalid-support',
    'unknown-model',
    'unknown-element',
    'incompatible-unification',
    'execution-error',
    'unresolved-symbol',
    // ConsistencyValidator.java
    'no-duplicate-ids',
    'acyclic-support',
    'acyclic-implements',
    // CompletenessValidator.java
    'conclusion-present',
    'conclusion-supported',
    'strategy-supported',
    'sub-conclusion-supported',
    'no-abstract-support',
    'has-abstract-support'
] as const;

/**
 * Codes this extension coins, because the compiler has no rule of its own to adopt.
 *
 * Three reasons appear here, and the distinction matters when the compiler next gains a rule:
 *
 * - **It does not check this at all.** `no-empty-label`, `no-empty-unit`, `unknown-config-key`
 *   (the compiler ignores keys it does not recognise), `support-override-type`.
 * - **It checks it, but reports it as the `execution-error` catch-all**, so there is no name to
 *   adopt: `no-duplicate-model-names`, `unknown-operator`, `operator-arity`, `missing-config-key`,
 *   `unknown-unification-method`.
 * - **It reports it as `FATAL`, and a fatal carries no code by policy** (jpipe-compiler ADR-0016):
 *   the whole `load-*` family, and `cyclic-load`.
 *
 * A name that moves out of this list because the compiler grew a rule for it is a rename, and
 * ADR-VSC-0022 says the compiler's name wins.
 */
export const EXTENSION_ONLY_CODES = [
    'no-empty-label',
    'no-empty-unit',
    'no-duplicate-model-names',
    'unknown-operator',
    'operator-arity',
    'unknown-config-key',
    'unknown-unification-method',
    'missing-config-key',
    'support-override-type',
    'load-unresolved',
    'load-no-match',
    'load-malformed-pattern',
    'cyclic-load'
] as const;

/**
 * The shape every code on both sides has.
 *
 * Copied from the compiler's own report schema (`diagnostic-report-v1.schema.json`), which
 * constrains `code` to exactly this and would have rejected the `jpipe.`-prefixed names the
 * extension used before ADR-VSC-0022 — a dot is not in the class.
 */
export const CODE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
