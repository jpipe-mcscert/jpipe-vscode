/**
 * Whether a result that has just come back is still the one the panel wants.
 *
 * Both preview paths run the compiler and then `await`, and during that await two things can
 * make the answer obsolete: the user toggles to the other view, or saves again and starts a
 * newer run that finishes first. Every `await` in this file is therefore followed by the same
 * question, and before this it was written out four times, in two orders and two shapes.
 *
 * Split out for the reason `preview-refresh.ts` and `export-target.ts` were: it needs nothing
 * from the editor, and it is worth testing — the failure is a panel showing the wrong view, or
 * an older diagram replacing a newer one, neither of which raises anything.
 */

import type { PreviewMode } from './preview-refresh.js';

export interface ResultContext {
    /** The mode this run was started for. */
    readonly startedIn: PreviewMode;
    /** The mode the panel is in now, having possibly been toggled while the run was in flight. */
    readonly currentMode: PreviewMode;
    /** This run's revision. */
    readonly revision: number;
    /** The revision of what the panel is already showing in `startedIn`, if anything. */
    readonly shownRevision: number | undefined;
}

export type ResultDisposition =
    /** Send it. */
    | 'deliver'
    /** The user is looking at the other view now; delivering would yank them back. */
    | 'mode-changed'
    /** Something newer is already on screen; delivering would go backwards. */
    | 'superseded';

/**
 * Decides what to do with a result whose work has finished.
 *
 * Mode is checked first, and the order matters: when the user has switched views the result is
 * irrelevant whatever its revision, and reporting it as `superseded` would put a misleading line
 * in the log about a race that did not happen.
 *
 * Revisions are compared with `<`, so a result carrying the revision already on screen is
 * delivered rather than dropped. That is what makes a re-render of the same revision — a
 * highlight refresh, a replay — land instead of being mistaken for a straggler.
 */
export function dispositionOf(context: ResultContext): ResultDisposition {
    if (context.currentMode !== context.startedIn) return 'mode-changed';
    if (context.shownRevision !== undefined && context.revision < context.shownRevision) {
        return 'superseded';
    }
    return 'deliver';
}
