/**
 * Stable identities for the problems the validator reports, and the facts a fix needs to repair
 * each one.
 *
 * A code action has to recognise a diagnostic without reading its prose, or every reworded
 * message silently unhooks a fix. The payloads exist for the same reason in reverse: the
 * validator has already done the work of finding out *what* is wrong — which key is missing,
 * which id an override must carry — and recomputing that inside the fix means maintaining the
 * same reasoning twice, in two places that are free to disagree.
 */

export const JpipeIssue = {
    EmptyLabel:             'jpipe.empty-label',
    EmptyUnit:              'jpipe.empty-unit',
    DuplicateModelName:     'jpipe.duplicate-model-name',
    TemplateWithoutSupport: 'jpipe.template-without-support',
    UnknownOperator:        'jpipe.unknown-operator',
    UnknownConfigKey:       'jpipe.unknown-config-key',
    MissingConfigKey:       'jpipe.missing-config-key',
    MissingSupportOverride: 'jpipe.missing-support-override',
    BadSupportOverrideType: 'jpipe.bad-support-override-type',
    StrategyUnsupported:    'jpipe.strategy-unsupported',
    StrategyBadSupporter:   'jpipe.strategy-bad-supporter',
    ConclusionUnsupported:  'jpipe.conclusion-unsupported',
    ConclusionNoStrategy:   'jpipe.conclusion-no-strategy',
    LoadUnresolved:         'jpipe.load-unresolved',
    LoadNoMatch:            'jpipe.load-no-match',
    LoadMalformedPattern:   'jpipe.load-malformed-pattern',
    LoadCircular:           'jpipe.load-circular'
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
    [JpipeIssue.MissingSupportOverride]: {
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
    [JpipeIssue.BadSupportOverrideType]: {
        /** The keyword actually written, e.g. `strategy`. */
        actualKeyword: string;
        /** The keywords that may refine an `@support`. */
        allowedKeywords: readonly string[];
    };
    [JpipeIssue.UnknownOperator]: {
        actual: string;
        known: readonly string[];
    };
    [JpipeIssue.UnknownConfigKey]: {
        actual: string;
        operator: string;
        allowed: readonly string[];
    };
    [JpipeIssue.MissingConfigKey]: {
        missingKey: string;
        operator: string;
        allMissing: readonly string[];
        /** False when the composition has no `{ … }` at all — the grammar forbids an empty one,
         *  so a fix must write the block and its first entry in a single edit. */
        hasConfigBlock: boolean;
    };
    [JpipeIssue.StrategyUnsupported]:   { targetId: string };
    [JpipeIssue.ConclusionUnsupported]: { targetId: string };
    [JpipeIssue.ConclusionNoStrategy]:  { targetId: string };
    [JpipeIssue.StrategyBadSupporter]:  { targetId: string; supporterKind: string };
    [JpipeIssue.LoadUnresolved]:        { path: string };
    [JpipeIssue.LoadNoMatch]:           { path: string };
    [JpipeIssue.LoadMalformedPattern]:  { path: string };
    [JpipeIssue.LoadCircular]:          { path: string; resolved: string };
    [JpipeIssue.DuplicateModelName]:    { id: string };
    [JpipeIssue.TemplateWithoutSupport]: { id: string };
    // `Record<never, never>` rather than `Record<string, never>`: only the former has `keyof`
    // equal to `never`, which is what marks a code as callable through `issue(code)` alone.
    [JpipeIssue.EmptyLabel]:            Record<never, never>;
    [JpipeIssue.EmptyUnit]:             Record<never, never>;
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
 * `{ node, property: 'id', ...issue(JpipeIssue.EmptyLabel) }`.
 *
 * `code` is set as well as `data.code` on purpose. `data` is what dispatch reads — it is Langium's
 * own convention and never shown — while `code` is what surfaces in the Problems panel, so a user
 * can see and filter on the rule that fired.
 */
export function issue<C extends CodeWithoutPayload>(code: C): { code: C; data: JpipeIssueData<C> };
export function issue<C extends JpipeIssueCode>(
    code: C, payload: JpipeIssuePayloads[C]
): { code: C; data: JpipeIssueData<C> };
export function issue<C extends JpipeIssueCode>(
    code: C, payload?: JpipeIssuePayloads[C]
): { code: C; data: JpipeIssueData<C> } {
    return { code, data: { code, ...(payload ?? {}) } as JpipeIssueData<C> };
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
