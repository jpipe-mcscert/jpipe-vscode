/**
 * String comparison used to rank suggestions.
 */

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
