/**
 * The composition operators the compiler knows, and the config keys each accepts.
 *
 * This is the single source of truth: the validator decides what to flag from here, and the
 * completion provider offers exactly what is listed here. The two used to carry independent
 * copies of the same tables, which is how `unifyBy` came to be offered by neither and rejected
 * by one.
 *
 * Mirrors `CompilerFactory.builtInOperators()` and each operator's `requiredArguments()` in the
 * jPipe compiler. Keep it in step with them: this table is what tells a user, while typing,
 * whether a build will accept their model.
 */

/** A composition operator and the shape of its invocation. */
export interface OperatorSpec {
    readonly name: string;
    /** One-line gloss, shown as completion detail. */
    readonly summary: string;
    /** Keys the compiler refuses to run without. */
    readonly requiredKeys: readonly string[];
    /** Keys this operator understands but does not demand. */
    readonly optionalKeys: readonly string[];
    /** Number of source models the operator accepts; `max` omitted means unbounded. */
    readonly arity: { readonly min: number; readonly max?: number };
    /**
     * What each source model is called, in order — `refine(base, refinement)` reads very
     * differently from `refine(a, b)`, and the order is not interchangeable. Used to name the
     * placeholders when completion writes an invocation.
     */
    readonly paramNames: readonly string[];
}

/**
 * Config keys legal on *every* operator.
 *
 * `ApplyOperator` runs the `Unifier` over the config map of every composition, whatever the
 * operator, and `Unifier` reads these two out of it. So they are not `assemble` keys or `refine`
 * keys — they belong to the composition machinery itself.
 */
export const UNIFY_BY_KEY = 'unifyBy';
export const UNIFY_EXCLUDE_KEY = 'unifyExclude';
export const UNIVERSAL_CONFIG_KEYS = [UNIFY_BY_KEY, UNIFY_EXCLUDE_KEY] as const;

export const JPIPE_OPERATORS: readonly OperatorSpec[] = [
    {
        name: 'assemble',
        summary: 'combine models under a freshly synthesized conclusion',
        requiredKeys: ['conclusionLabel', 'strategyLabel'],
        optionalKeys: [],
        arity: { min: 1 },
        paramNames: ['model']
    },
    {
        name: 'refine',
        summary: 'graft a model onto a hooked element of another',
        requiredKeys: ['hook'],
        optionalKeys: [],
        arity: { min: 2, max: 2 },
        paramNames: ['base', 'refinement']
    }
];

const BY_NAME = new Map(JPIPE_OPERATORS.map(spec => [spec.name, spec]));

/**
 * How many source models an operator takes, in words: "exactly 2", "at least 1",
 * "between 1 and 3". `max` is undefined for an operator with no upper bound.
 *
 * Lives here rather than in the validator that phrases the message, because it reads the
 * `arity` shape declared above and has to keep step with it. The bounded case is unreachable
 * through the validator today — no shipped operator declares a `max` above its `min` — which
 * is why it is tested directly.
 */
export function arityPhrase(min: number, max: number | undefined): string {
    if (max === min) return `exactly ${min}`;
    if (max === undefined) return `at least ${min}`;
    return `between ${min} and ${max}`;
}

export function operatorSpec(name: string): OperatorSpec | undefined {
    return BY_NAME.get(name);
}

export function isKnownOperator(name: string): boolean {
    return BY_NAME.has(name);
}

export function knownOperatorNames(): readonly string[] {
    return JPIPE_OPERATORS.map(spec => spec.name);
}

export function requiredConfigKeys(operator: string): readonly string[] {
    return operatorSpec(operator)?.requiredKeys ?? [];
}

/**
 * Every key the given operator accepts: its own, plus the universal unification keys.
 *
 * Returns an empty list for an unknown operator, so a caller that has already reported the
 * operator itself does not then report each of its keys as well.
 */
export function allowedConfigKeys(operator: string): readonly string[] {
    const spec = operatorSpec(operator);
    if (!spec) return [];
    return [...spec.requiredKeys, ...spec.optionalKeys, ...UNIVERSAL_CONFIG_KEYS];
}

/**
 * The whole invocation an operator needs, laid out the way the language's own examples are.
 *
 * Completing an operator writes this rather than the bare word: the parameters are positional and
 * not interchangeable, the required keys are not guessable, and an empty config block does not
 * parse — so the word on its own leaves three separate things still to look up.
 *
 * `placeholder` wraps each editable part — it is handed the tab-stop number and the default text,
 * so one description renders both the snippet an editor inserts and the plain preview shown
 * beside it.
 */
export function renderInvocation(
    spec: OperatorSpec,
    indent: string,
    placeholder: (index: number, text: string) => string
): string {
    const params = spec.paramNames
        .map((name, i) => placeholder(i + 1, name))
        .join(', ');
    const keys = spec.requiredKeys
        .map((key, i) => `${indent}    ${key}: "${placeholder(spec.paramNames.length + i + 1, '')}"`)
        .join('\n');
    const block = keys ? ` {\n${keys}\n${indent}}` : '';
    return `${spec.name}(${params})${block}`;
}
