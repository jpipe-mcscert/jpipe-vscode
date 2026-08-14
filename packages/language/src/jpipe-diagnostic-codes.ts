/**
 * Stable identities for the problems the validator reports, and the facts a fix needs to repair
 * each one.
 *
 * A code action has to recognise a diagnostic without reading its prose, or every reworded
 * message silently unhooks a fix. The payloads exist for the same reason in reverse: the
 * validator has already done the work of finding out *what* is wrong — which key is missing,
 * which id an override must carry — and recomputing that inside the fix means maintaining the
 * same reasoning twice, in two places that are free to disagree.
 *
 * **These identities are shared with the compiler.** Six are the compiler's own rule names,
 * adopted verbatim so one defect reads the same in the Problems panel and in a compiler report;
 * the rest are coined in its naming style. `jpipe-compiler-codes.ts` records which is which, and
 * a test holds the partition. See jpipe-vscode ADR-VSC-0022 and jpipe-compiler ADR-0016.
 */

import type { AstNode } from 'langium';
import type { DiagnosticInfo, ValidationAcceptor } from 'langium';

export const JpipeIssue = {
    NoEmptyLabel:           'no-empty-label',
    NoEmptyUnit:            'no-empty-unit',
    NoDuplicateModelNames:  'no-duplicate-model-names',
    NoDuplicateIds:         'no-duplicate-ids',
    HasAbstractSupport:     'has-abstract-support',
    ConclusionPresent:      'conclusion-present',
    SingleConclusion:       'single-conclusion',
    UnknownOperator:        'unknown-operator',
    OperatorArity:          'operator-arity',
    UnknownConfigKey:       'unknown-config-key',
    UnknownUnificationMethod: 'unknown-unification-method',
    MissingConfigKey:       'missing-config-key',
    NoAbstractSupport:      'no-abstract-support',
    SupportOverrideType:    'support-override-type',
    StrategySupported:      'strategy-supported',
    InvalidSupport:         'invalid-support',
    ConclusionSupported:    'conclusion-supported',
    LoadUnresolved:         'load-unresolved',
    LoadNoMatch:            'load-no-match',
    LoadMalformedPattern:   'load-malformed-pattern',
    CyclicLoad:             'cyclic-load'
} as const;

export type JpipeIssueCode = typeof JpipeIssue[keyof typeof JpipeIssue];

/** The only two severities this language reports. See jpipe-vscode ADR-VSC-0023. */
export type JpipeSeverity = 'error' | 'warning';

/**
 * How severely each problem is reported, and why.
 *
 * The rule is one line: **a diagnostic is an error if and only if the compiler will reject the
 * model.** Otherwise it is a warning. The compiler has no warning level of its own — jpipe-compiler
 * ADR-0016 removed it — so "the compiler noticed" and "the build fails" are the same statement, and
 * every entry below is settled by asking what `jpipe` does with the file, not by taste.
 *
 * Two things follow, and are worth naming because they look like separate decisions and are not.
 * A rule only the editor has can never be an error, since a check the compiler does not run cannot
 * fail a build — that is the whole reason `no-empty-label` is a warning. And the one exception is
 * for what the editor *cannot know*: `unknown-unification-method` would fail the build, but the
 * editor cannot see the compiler's startup registry, so it warns and its message claims only the
 * limit of its own knowledge.
 *
 * This is a `Record`, not a lookup with a default: a new code that declares no severity **fails to
 * compile**, which is the point. Choosing `'warning'` additionally has to be justified against the
 * list in `test/diagnostic-codes.test.ts`.
 */
export const JpipeIssueSeverity: Record<JpipeIssueCode, JpipeSeverity> = {
    // Errors — verified against the compiler, mostly against its own `examples/invalid/` fixtures.
    [JpipeIssue.NoDuplicateModelNames]: 'error',   // `execution-error`: "Duplicate model name"
    [JpipeIssue.NoDuplicateIds]:        'error',   // rejected under this same code
    [JpipeIssue.HasAbstractSupport]:    'error',   // rejected under this same code
    [JpipeIssue.ConclusionPresent]:     'error',   // rejected under this same code
    [JpipeIssue.SingleConclusion]:      'error',   // rejected under this same code
    [JpipeIssue.NoAbstractSupport]:     'error',   // rejected under this same code
    [JpipeIssue.StrategySupported]:     'error',   // rejected under this same code
    [JpipeIssue.ConclusionSupported]:   'error',   // rejected under this same code
    [JpipeIssue.InvalidSupport]:        'error',   // rejected under this same code
    [JpipeIssue.SupportOverrideType]:   'error',   // surfaces upstream as `no-abstract-support`
    [JpipeIssue.UnknownOperator]:       'error',   // `execution-error` from `ApplyOperator`
    [JpipeIssue.OperatorArity]:         'error',   // `execution-error`: "requires exactly 2 sources"
    [JpipeIssue.MissingConfigKey]:      'error',   // `execution-error`: "were not provided"
    [JpipeIssue.LoadUnresolved]:        'error',   // FATAL from `LoadResolver`; aborts the pipeline
    [JpipeIssue.LoadNoMatch]:           'error',   // FATAL from `LoadResolver`
    [JpipeIssue.LoadMalformedPattern]:  'error',   // FATAL from `LoadResolver`
    [JpipeIssue.CyclicLoad]:            'error',   // FATAL from `LoadResolver`

    // Warnings — the compiler builds these files. Each was run through `jpipe diagnostic`, and each
    // exited 0.
    [JpipeIssue.NoEmptyLabel]:          'warning', // accepted: nothing checks a label's contents
    [JpipeIssue.NoEmptyUnit]:           'warning', // accepted: a file of only `load`s is legal
    [JpipeIssue.UnknownConfigKey]:      'warning', // accepted: unrecognised keys are ignored
    // The exception. The compiler *would* reject this, but its relation registry is populated at
    // startup and a project may register its own, so the editor cannot know. The message says what
    // the editor does not recognise rather than predicting a failure, and settings can widen it.
    [JpipeIssue.UnknownUnificationMethod]: 'warning'
};

const ALL_CODES: ReadonlySet<string> = new Set(Object.values(JpipeIssue));

/** Whether a string is one of this language's diagnostic codes. */
export function isJpipeIssueCode(value: unknown): value is JpipeIssueCode {
    return typeof value === 'string' && ALL_CODES.has(value);
}

/**
 * What each code carries beyond its identity.
 *
 * Everything here must survive `JSON.stringify` and come back unchanged: the payload rides in a
 * diagnostic's `data` field, out to the client and back on the next code-action request. AST
 * nodes, CST nodes, `Set`s and `URI`s cannot make that trip. Ranges deliberately do not either —
 * the diagnostic's own range is the one the client keeps adjusted as the user types, so anything
 * positional we stored alongside it would go stale while looking authoritative.
 */
export interface JpipeIssuePayloads {
    [JpipeIssue.NoAbstractSupport]: {
        /** The id the overriding declaration must carry, e.g. `T:abs` or `base:T:abs`. */
        expectedKey: string;
        /** The `@support`'s label, so the override reuses the wording it refines. */
        supportLabel: string;
        /** Local id of the `@support`, for the action's title. */
        supportId: string;
        sourceTemplateId: string;
        /** Every override still missing on this justification, for a fix-all action. */
        allMissing: ReadonlyArray<{ expectedKey: string; supportLabel: string }>;
    };
    [JpipeIssue.SupportOverrideType]: {
        /** The keyword actually written, e.g. `strategy`. */
        actualKeyword: string;
        /** The keywords that may refine an `@support`. */
        allowedKeywords: readonly string[];
    };
    [JpipeIssue.UnknownOperator]: {
        actual: string;
        known: readonly string[];
    };
    [JpipeIssue.OperatorArity]: {
        operator: string;
        /** Source models actually passed. */
        actual: number;
        min: number;
        /** Absent when the operator takes any number above `min`. */
        max?: number;
    };
    [JpipeIssue.UnknownConfigKey]: {
        actual: string;
        operator: string;
        allowed: readonly string[];
    };
    [JpipeIssue.UnknownUnificationMethod]: {
        actual: string;
        /** Every name this workspace recognises: the built-ins plus any declared in settings. */
        known: readonly string[];
    };
    [JpipeIssue.MissingConfigKey]: {
        missingKey: string;
        operator: string;
        allMissing: readonly string[];
        /** False when the composition has no `{ … }` at all — the grammar forbids an empty one,
         *  so a fix must write the block and its first entry in a single edit. */
        hasConfigBlock: boolean;
    };
    [JpipeIssue.StrategySupported]:     { targetId: string };
    /** Carries no discriminant between "no support at all" and "support, but none from a
     *  strategy": the two are one rule to the compiler, and the fix branches on the AST node
     *  rather than on the code. See jpipe-vscode ADR-VSC-0022. */
    [JpipeIssue.ConclusionSupported]:   { targetId: string };
    [JpipeIssue.InvalidSupport]:        { targetId: string; supporterKind: string };
    [JpipeIssue.LoadUnresolved]:        { path: string };
    [JpipeIssue.LoadNoMatch]:           { path: string };
    [JpipeIssue.LoadMalformedPattern]:  { path: string };
    [JpipeIssue.CyclicLoad]:            { path: string; resolved: string };
    [JpipeIssue.NoDuplicateModelNames]: { id: string };
    [JpipeIssue.NoDuplicateIds]:        { id: string; modelId: string };
    [JpipeIssue.HasAbstractSupport]:    { id: string };
    [JpipeIssue.ConclusionPresent]:     { id: string };
    [JpipeIssue.SingleConclusion]:      { modelId: string; id: string };
    // `Record<never, never>` rather than `Record<string, never>`: only the former has `keyof`
    // equal to `never`, which is what marks a code as callable through `issue(code)` alone.
    [JpipeIssue.NoEmptyLabel]:          Record<never, never>;
    [JpipeIssue.NoEmptyUnit]:           Record<never, never>;
}

/** The `data` a diagnostic of the given code carries. */
export type JpipeIssueData<C extends JpipeIssueCode = JpipeIssueCode> =
    { code: C } & JpipeIssuePayloads[C];

/** Codes whose payload is empty, so `issue()` may be called with one argument. */
type CodeWithoutPayload = {
    [C in JpipeIssueCode]: keyof JpipeIssuePayloads[C] extends never ? C : never
}[JpipeIssueCode];

/**
 * Builds the `code` and `data` fields of a diagnostic.
 *
 * Spread into a `DiagnosticInfo`, so attaching an identity to a check costs one line:
 * `{ node, property: 'id', ...issue(JpipeIssue.NoEmptyLabel) }`.
 *
 * `code` is set as well as `data.code` on purpose. `data` is what dispatch reads — it is Langium's
 * own convention and never shown — while `code` is what surfaces in the Problems panel, so a user
 * can see and filter on the rule that fired. It needs no `jpipe.` prefix to be unambiguous there:
 * Langium already sets `source` to the language id, so the panel reads `jpipe(no-empty-label)`.
 */
export function issue<C extends CodeWithoutPayload>(code: C): { code: C; data: JpipeIssueData<C> };
export function issue<C extends JpipeIssueCode>(
    code: C, payload: JpipeIssuePayloads[C]
): { code: C; data: JpipeIssueData<C> };
export function issue<C extends JpipeIssueCode>(
    code: C, payload?: JpipeIssuePayloads[C]
): { code: C; data: JpipeIssueData<C> } {
    return { code, data: { code, ...payload } as JpipeIssueData<C> };
}

/**
 * Reads the issue code off a diagnostic, or `undefined` if it carries none.
 *
 * Prefers `data.code`, which is where dispatch information belongs and where Langium puts its
 * own; falls back to the visible `code` so a diagnostic carrying only that still routes.
 */
export function issueCodeOf(diagnostic: { code?: unknown; data?: unknown }): JpipeIssueCode | undefined {
    const fromData = (diagnostic.data as { code?: unknown } | undefined)?.code;
    if (isJpipeIssueCode(fromData)) return fromData;
    return isJpipeIssueCode(diagnostic.code) ? diagnostic.code : undefined;
}

/** What a caller of `report` supplies: a `DiagnosticInfo` minus the two fields `issue()` fills. */
type IssueTarget<N extends AstNode> = Omit<DiagnosticInfo<N>, 'code' | 'data'>;

/**
 * Reports a problem at the severity its code declares.
 *
 * The severity is deliberately not a parameter. It used to be the first argument of every
 * `accept(...)`, which made it a judgement to be made afresh at each call site — and it was made
 * inconsistently, because nothing there says what the rule is. It now comes from
 * `JpipeIssueSeverity`, where the rule and the reason for each entry are written down once
 * (jpipe-vscode ADR-VSC-0023).
 *
 * Overloaded like `issue()`: one arity for codes carrying no payload, one for the rest.
 */
export function report<N extends AstNode, C extends CodeWithoutPayload>(
    accept: ValidationAcceptor, code: C, message: string, target: IssueTarget<N>
): void;
export function report<N extends AstNode, C extends JpipeIssueCode>(
    accept: ValidationAcceptor, code: C, message: string,
    target: IssueTarget<N>, payload: JpipeIssuePayloads[C]
): void;
export function report<N extends AstNode, C extends JpipeIssueCode>(
    accept: ValidationAcceptor, code: C, message: string,
    target: IssueTarget<N>, payload?: JpipeIssuePayloads[C]
): void {
    accept(JpipeIssueSeverity[code], message, {
        ...target,
        ...issue(code, payload as JpipeIssuePayloads[C])
    } as DiagnosticInfo<N>);
}
