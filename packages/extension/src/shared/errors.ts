/**
 * Reading a thrown value without widening it to `any`.
 *
 * `strict` implies `useUnknownInCatchVariables`, so a `catch` binding arrives as `unknown` and
 * has to be narrowed before anything can be read off it. Ten `catch (e: any)` blocks used to opt
 * out of that check instead, which is a broader concession than it looks: `any` disables
 * checking of everything reached through it, so `e.mesage` would have compiled too.
 *
 * The functions here are the narrowing those sites actually needed, written once. Every one
 * takes `unknown` and returns something definite, so a caller never has to assert.
 *
 * No `vscode` and no DOM: both bundles use this (jpipe-vscode ADR-VSC-0005), and unlike its
 * callers it is therefore testable — see `test/errors.test.ts`.
 */

/**
 * The message a thrown value carries.
 *
 * Deliberately the same rule the codebase already applied by hand in fifteen places —
 * `err instanceof Error ? err.message : String(err)` — so replacing them changes nothing about
 * what a user sees. A non-`Error` keeps going through `String`, which is what produces
 * `"[object Object]"` for a thrown object literal: ugly, but honest, and unchanged.
 */
export function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * The message to *show someone*, when a thrown value might be anything.
 *
 * Differs from `messageOf` in the last branch, and deliberately: this one ends at
 * `'[unknown error]'` rather than `String(err)`, because it feeds notifications and the output
 * channel, where `"[object Object]"` tells a user nothing and looks like a bug in the extension
 * rather than a report about their model.
 *
 * Both rules already existed in the codebase; keeping them apart preserves what each site
 * showed, and naming them says which one a new site wants.
 */
export function displayMessageOf(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return '[unknown error]';
}

/**
 * What a failed child process leaves on the thrown error.
 *
 * Every field is optional, because whether any of them is present depends on how the process
 * failed: a compiler that ran and exited non-zero carries output and a code, one that could not
 * be spawned at all carries neither.
 */
export interface ProcessFailure {
    /** Anything the process wrote to stdout before failing. */
    readonly stdout?: string;
    /** Anything the process wrote to stderr before failing. */
    readonly stderr?: string;
    /** The process's exit code, from `exitCode` or, failing that, a numeric `code`. */
    readonly exitCode?: number;
    /** Set when the failure was a user cancelling, not the process going wrong. */
    readonly cancelled: boolean;
}

/** `value` if it is a string, otherwise undefined. */
function stringOf(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/** `value` if it is a number, otherwise undefined. */
function numberOf(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
}

/**
 * View a thrown value as a failed process.
 *
 * Reads only fields that carry the expected type, so a value that is not a process failure at
 * all — a string, null, an unrelated Error — yields a `ProcessFailure` with everything absent
 * rather than throwing or lying.
 *
 * `exitCode` falls back to a numeric `code` because the two arrive from different layers: the
 * compiler wrapper sets `exitCode`, while a spawn failure surfaces Node's `code`. A non-numeric
 * `code` (`'ENOENT'`) is deliberately not an exit code and is left out.
 */
export function asProcessFailure(err: unknown): ProcessFailure {
    const source: Record<string, unknown> =
        typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};

    return {
        stdout: stringOf(source.stdout),
        stderr: stringOf(source.stderr),
        // `??` rather than a conditional chain: `numberOf` has already turned "wrong type" into
        // undefined, so the fallback from exitCode to code is just the absence of the first.
        exitCode: numberOf(source.exitCode) ?? numberOf(source.code),
        cancelled: source.cancelled === true
    };
}

/**
 * The most specific text a failed process offers: what it printed, or failing that its message.
 *
 * stderr first, then stdout, then the message — a compiler that rejected a model explains itself
 * on stderr, and only a process that never ran leaves nothing but a message.
 */
export function detailOf(err: unknown): string {
    const { stderr, stdout } = asProcessFailure(err);
    return (stderr ?? stdout ?? messageOf(err)).trim();
}
