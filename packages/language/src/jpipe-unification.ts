/**
 * The equivalence relations `unifyBy` may name.
 *
 * jPipe core ships exactly one, `sameLabel`. But the registry it is looked up in is populated at
 * compiler startup, so a build can carry relations this extension has never heard of — a project
 * with its own is not doing anything wrong, and an editor that called its models broken would be
 * simply mistaken. Extra names are therefore configurable, and an unrecognised one is a warning
 * rather than an error: the editor is reporting the limit of what it knows, not a defect.
 */

/** Registered by `CompilerFactory.builtInUnificationEquivalences`. */
export const BUILT_IN_UNIFICATION_METHODS: readonly string[] = ['sameLabel'];

/** What `unifyBy` falls back to when a composition does not set it. */
export const DEFAULT_UNIFICATION_METHOD = 'sameLabel';

/**
 * Holds the relation names this workspace knows about: the built-ins, plus whatever the user has
 * declared for relations their own build registers.
 *
 * A service rather than a constant because the extra names arrive from client configuration and
 * change without a restart, the same way excluded paths do.
 */
export class JpipeUnificationService {
    private additional: readonly string[] = [];

    /** Replaces the user-declared names. Blank entries and duplicates are dropped. */
    setAdditionalMethods(names: readonly string[]): void {
        this.additional = [...new Set(
            names.map(name => name.trim()).filter(name => name.length > 0)
        )];
    }

    /** Every name `unifyBy` may take here, built-ins first. */
    known(): readonly string[] {
        return [...BUILT_IN_UNIFICATION_METHODS, ...this.additional.filter(
            name => !BUILT_IN_UNIFICATION_METHODS.includes(name)
        )];
    }

    isKnown(name: string): boolean {
        return this.known().includes(name);
    }
}
