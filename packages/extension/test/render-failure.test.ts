/**
 * What the preview says when the compiler failed but still drew something.
 *
 * The panel reaches this state only when usable SVG came back *anyway* — a total failure leaves
 * the last good diagram up and says nothing at all. So there is always a plausible-looking diagram
 * under the notice, which is what makes a wrong or missing one costly: the reader is about to act
 * on a picture that is not the whole truth.
 */
import { describe, expect, test } from 'vitest';
import { renderFailureNotice, showsFailureNotice } from '../src/shared/render-failure.js';

describe('renderFailureNotice', () => {

    test('says nothing when nothing went wrong', () => {
        expect(renderFailureNotice(null)).toBeNull();
        expect(renderFailureNotice(undefined)).toBeNull();
    });

    // Exit 1 is the compiler's "your model has errors", which is the common case and the one a
    // user can act on — so it names the model, not the compiler.
    test('blames the model on exit 1', () => {
        expect(renderFailureNotice({ exitCode: 1 })).toBe(
            'This model has errors — the diagram below is the most the compiler could draw.');
    });

    // Exit 42 is the compiler's own crash. Telling someone their model is wrong when it is not is
    // worse than saying nothing, so these two must not share wording.
    test('blames the compiler on exit 42', () => {
        expect(renderFailureNotice({ exitCode: 42 })).toContain('The compiler failed');
    });

    test('the two are not the same message', () => {
        expect(renderFailureNotice({ exitCode: 1 })).not.toBe(renderFailureNotice({ exitCode: 42 }));
    });

    // A failure we have no account of still has to produce a notice: the diagram is equally
    // untrustworthy either way, and silence here is the bug this replaces.
    test.each([
        ['an exit code with no meaning attached', { exitCode: 7 }],
        ['no exit code at all', {}]
    ])('still says something for %s', (_label, error) => {
        expect(renderFailureNotice(error)).toBeTruthy();
    });

    // The point of the banner: every variant says the diagram is not to be trusted. The tint it
    // replaces said only that *something* had happened.
    test('every notice says the diagram is not the whole truth', () => {
        for (const error of [{ exitCode: 1 }, { exitCode: 42 }, { exitCode: 7 }, {}]) {
            expect(renderFailureNotice(error), `for ${JSON.stringify(error)}`)
                .toMatch(/diagram below/);
        }
    });
});

/**
 * A notice describes the diagram under it. The panel has modes where there is no diagram under
 * it, and the banner has to know the difference — otherwise it says "the diagram below" over the
 * diagnostic report, and offers a button to the view the reader is already looking at.
 */
describe('showsFailureNotice', () => {

    const notice = renderFailureNotice({ exitCode: 1 });

    test('shows over the diagram it describes', () => {
        expect(showsFailureNotice(notice, 'diagram')).toBe(true);
    });

    // The reported case: switching modes left the banner up, describing a layer that is not there
    // and pointing at where the reader had just arrived.
    test.each(['diagnostic', 'empty'] as const)('stays out of %s mode', mode => {
        expect(showsFailureNotice(notice, mode)).toBe(false);
    });

    test('nothing to show is nothing to show, in any mode', () => {
        for (const mode of ['diagram', 'diagnostic', 'empty'] as const) {
            expect(showsFailureNotice(null, mode)).toBe(false);
        }
    });
});
