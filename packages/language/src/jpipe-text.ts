/**
 * String comparison used to rank suggestions, and to order results deterministically.
 */

/**
 * Orders strings by UTF-16 code unit — what `Array.prototype.sort()` does by default, said out
 * loud so that it is a decision rather than an accident.
 *
 * Deliberately not `localeCompare`. That orders by the runtime's locale, which would make the
 * result depend on the machine it ran on; where this matters most is glob expansion, which has
 * to agree with the compiler's `LoadResolver` about the order a model's files load in, and the
 * compiler sorts Java strings — by code unit. See jpipe-vscode ADR-VSC-0007.
 *
 * (`nearestTo` below does use `localeCompare`, correctly: it only breaks ties between equally
 * near suggestions for display, where locale order is the friendlier one and nothing downstream
 * depends on it.)
 */
export function byCodeUnit(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/**
 * Levenshtein distance between two strings.
 *
 * Used only to order a handful of candidates — operator names, config keys, load paths — so the
 * straightforward two-row implementation is the right size for the job.
 */
export function editDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
        const current = [i, ...new Array<number>(b.length).fill(0)];
        for (let j = 1; j <= b.length; j++) {
            const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
            current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
        }
        previous = current;
    }

    return previous[b.length];
}

/** The candidates within `maxDistance` of `value`, nearest first. */
export function nearestTo(value: string, candidates: readonly string[], maxDistance: number): string[] {
    return candidates
        .map(candidate => ({ candidate, distance: editDistance(value, candidate) }))
        .filter(({ distance }) => distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
        .map(({ candidate }) => candidate);
}
