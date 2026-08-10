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
}

/**
 * Config keys legal on *every* operator.
 *
 * `ApplyOperator` runs the `Unifier` over the config map of every composition, whatever the
 * operator, and `Unifier` reads these two out of it. So they are not `assemble` keys or `refine`
 * keys — they belong to the composition machinery itself.
 */
export const UNIVERSAL_CONFIG_KEYS = ['unifyBy', 'unifyExclude'] as const;

export const JPIPE_OPERATORS: readonly OperatorSpec[] = [
    {
        name: 'assemble',
        summary: 'combine models under a freshly synthesized conclusion',
        requiredKeys: ['conclusionLabel', 'strategyLabel'],
        optionalKeys: [],
        arity: { min: 1 }
    },
    {
        name: 'refine',
        summary: 'graft a model onto a hooked element of another',
        requiredKeys: ['hook'],
        optionalKeys: [],
        arity: { min: 2, max: 2 }
    }
];

const BY_NAME = new Map(JPIPE_OPERATORS.map(spec => [spec.name, spec]));

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
