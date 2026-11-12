/**
 * Which step of the checked libraries implements which element of a model — as the runner would
 * decide it, worked out ahead of a run so the Outline can show it.
 *
 * The rules are jpipe-runner's (its ADR-0007, "Binding: how an id designates an element" in its
 * authoring guide). An element's id is the one the compiler exports, `release:e1` for `e1` in
 * `justification release`, and a step id designates it by the first rule that matches:
 *
 * 1. **exact** — it is the element's id;
 * 2. **qualified** — it is `<justification>:<element id>`;
 * 3. **suffix** — it is a strictly shorter tail of the element's id, cut at `:`. A tail shared by
 *    two elements designates neither.
 *
 * This is an indication, not the runner's verdict. It sees the elements the model declares
 * itself, not the ones it inherits or that a composition produces, and not the aliases the
 * compiler adds; the runner, which has the compiled model, remains the authority.
 */
import type { StepKind } from './library-scan.js';

/** A step of a checked library, as the binding needs it. */
export interface LibraryStep {
    kind: StepKind;
    ids: readonly string[];
    functionName?: string;
    /** The library file declaring it. */
    libraryUri: string;
    /** Zero-based line of its decorator. */
    line: number;
}

/** The element a step id designates among `elementIds` (the compiler's ids), if exactly one. */
export function designates(stepId: string, modelName: string, elementIds: readonly string[]): string | undefined {
    if (elementIds.includes(stepId)) return stepId;
    const qualified = elementIds.find(id => `${modelName}:${id}` === stepId);
    if (qualified) return qualified;
    const tails = elementIds.filter(id => id.length > stepId.length && id.endsWith(`:${stepId}`));
    return tails.length === 1 ? tails[0] : undefined;
}

/**
 * For each of the model's elements (by its id in the model, `e1`), the steps implementing it.
 *
 * An element with two steps is reported by the runner (`JP007`); it is kept here with both, so
 * the Outline can say so rather than pick one.
 */
export function bindSteps(
    modelName: string,
    localIds: readonly string[],
    steps: readonly LibraryStep[]
): Map<string, LibraryStep[]> {
    const exported = localIds.map(id => `${modelName}:${id}`);
    const bound = new Map<string, LibraryStep[]>();
    for (const step of steps) {
        const designated = new Set(step.ids
            .map(id => designates(id, modelName, exported))
            .filter((id): id is string => id !== undefined));
        for (const id of designated) {
            const local = localIds[exported.indexOf(id)];
            bound.set(local, [...(bound.get(local) ?? []), step]);
        }
    }
    return bound;
}

/** Element kinds the runner requires a step for (`JP005`); the others take their status from below. */
const REQUIRED = new Set(['evidence', 'strategy']);

/**
 * What an Outline row says about its step, or `undefined` for nothing.
 *
 * Nothing at all until a library is checked: without one there is no run to prepare for, and
 * "no step" on every row would be noise. After that, a required element without a step says so,
 * since the runner will refuse the model.
 */
export function stepNote(
    elementKind: string,
    steps: readonly LibraryStep[] | undefined,
    anyLibraryChecked: boolean
): string | undefined {
    if (!anyLibraryChecked) return undefined;
    if (steps && steps.length > 1) return `${steps.length} steps`;
    if (steps && steps.length === 1) return steps[0].functionName ? `${steps[0].functionName}()` : 'step';
    return REQUIRED.has(elementKind) ? 'no step' : undefined;
}
