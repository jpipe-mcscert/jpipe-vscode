import { describe, expect, test } from 'vitest';
import { dispositionOf, type ResultContext } from '../src/extension/preview/staleness.js';

/**
 * What to do with a compiler result that has just come back.
 *
 * Both failures this prevents are silent. Delivering after a toggle yanks the user from the
 * report they are reading back to the diagram; delivering a superseded revision puts an older
 * diagram on screen and — because the host records it as what the panel shows — points the
 * export at the wrong one.
 */

const context = (over: Partial<ResultContext> = {}): ResultContext => ({
    startedIn: 'diagram',
    currentMode: 'diagram',
    revision: 5,
    shownRevision: undefined,
    ...over
});

describe('dispositionOf', () => {

    test('delivers when the mode held and nothing newer is showing', () => {
        expect(dispositionOf(context())).toBe('deliver');
    });

    test('delivers the first result, when the panel is showing nothing yet', () => {
        expect(dispositionOf(context({ revision: 1, shownRevision: undefined }))).toBe('deliver');
    });

    test('delivers a newer revision over an older one on screen', () => {
        expect(dispositionOf(context({ revision: 7, shownRevision: 3 }))).toBe('deliver');
    });

    test.each([
        ['diagram result arriving in diagnostic mode', 'diagram', 'diagnostic'],
        ['diagnostic result arriving in diagram mode', 'diagnostic', 'diagram']
    ] as const)('drops a %s', (_label, startedIn, currentMode) => {
        expect(dispositionOf(context({ startedIn, currentMode }))).toBe('mode-changed');
    });

    test('drops a revision older than what is already shown', () => {
        expect(dispositionOf(context({ revision: 2, shownRevision: 6 }))).toBe('superseded');
    });

    test('delivers a result carrying the revision already on screen', () => {
        // `<` not `<=`, deliberately: a re-render of the same revision is a highlight refresh or
        // a replay, and dropping it would leave the panel stale rather than protect it.
        expect(dispositionOf(context({ revision: 4, shownRevision: 4 }))).toBe('deliver');
    });

    test('reports a mode change ahead of a stale revision when both apply', () => {
        // Order matters for the log, not the outcome: both drop the result, but calling this
        // `superseded` would describe a race that never happened. The user simply looked away.
        expect(dispositionOf(context({
            startedIn: 'diagram',
            currentMode: 'diagnostic',
            revision: 2,
            shownRevision: 9
        }))).toBe('mode-changed');
    });

    test('treats revision 0 as a real revision rather than as absent', () => {
        // Guards the `!== undefined` test: a truthiness check here would let revision 0 through
        // as "nothing shown yet" and deliver every straggler over it.
        expect(dispositionOf(context({ revision: 0, shownRevision: 0 }))).toBe('deliver');
        expect(dispositionOf(context({ revision: -1, shownRevision: 0 }))).toBe('superseded');
    });
});
