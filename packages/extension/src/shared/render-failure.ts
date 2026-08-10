/**
 * What to say when the compiler failed but the panel still has a diagram to show.
 *
 * A render only reaches the page with an `error` attached when the compiler produced usable SVG
 * *anyway* — a total failure leaves the last good diagram up and says nothing. So the panel is
 * always showing something plausible at this point, and the whole job of the notice is to say that
 * what is on screen is not to be trusted, and where the actual reasons are.
 *
 * Split out of the page because it is a pure function of an exit code and worth pinning: a wrong
 * message here is worse than none, since it describes a diagram the user is about to act on.
 */

/** Exit codes the compiler uses. Anything else is a failure we have no account of. */
const MODEL_HAS_ERRORS = 1;
const COMPILER_CRASHED = 42;

export interface RenderFailure {
    exitCode?: number;
}

/**
 * The banner text for a failed render, or `null` when there is nothing wrong.
 *
 * Each variant says the same two things — what went wrong, and that the diagram is therefore not
 * the whole truth — because the reddish tint this replaces said only that *something* had
 * happened, which left the reader to decide whether the diagram in front of them was current.
 */
export function renderFailureNotice(error: RenderFailure | null | undefined): string | null {
    if (!error) return null;
    switch (error.exitCode) {
        case MODEL_HAS_ERRORS:
            return 'This model has errors — the diagram below is the most the compiler could draw.';
        case COMPILER_CRASHED:
            return 'The compiler failed while drawing this model — the diagram below may be out of date.';
        default:
            return 'The compiler reported a problem — the diagram below may be incomplete.';
    }
}
