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

export const JpipeIssue = {
    NoEmptyLabel:           'no-empty-label',
    NoEmptyUnit:            'no-empty-unit',
    NoDuplicateModelNames:  'no-duplicate-model-names',
    NoDuplicateIds:         'no-duplicate-ids',
    HasAbstractSupport:     'has-abstract-support',
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
