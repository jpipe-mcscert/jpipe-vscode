/**
 * Reading a thrown value without widening it to `any`.
 *
 * A deliberate near-twin of `packages/extension/src/shared/errors.ts`. The two packages are
 * separately distributable (jpipe-vscode ADR-VSC-0002) and neither can import the other's
 * internals, so the alternative to three duplicated lines is making an error utility part of the
 * language server's public API — which would say something untrue about what that API is for.
 *
 * The extension's copy also carries subprocess helpers, because it is the side that runs the
 * compiler. This one narrows messages and nothing else, because that is all this package throws.
 */

/**
 * The message a thrown value carries.
 *
 * The same rule the four call sites applied by hand, so replacing them changed no log line.
 */
export function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
