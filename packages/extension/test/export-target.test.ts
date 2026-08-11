import { describe, expect, test } from 'vitest';
import { panelExportTarget, type PanelExportContext } from '../src/extension/preview/export-target.js';

/**
 * What the preview panel's download button exports.
 *
 * Worth testing because the failure is silent and plausible-looking: the user gets a file of the
 * right format, named after a real diagram, containing the wrong model. Nothing errors, nothing
 * is logged, and the export they asked for looks like it worked.
 */

const context = (over: Partial<PanelExportContext> = {}): PanelExportContext => ({
    activeJpipeUri: undefined,
    renderedUri: undefined,
    renderedDiagram: undefined,
    ...over
});

describe('panelExportTarget', () => {

    test('exports what the panel rendered', () => {
        expect(panelExportTarget(context({ renderedUri: 'file:///a.jd', renderedDiagram: 'D' })))
            .toEqual({ kind: 'rendered', uri: 'file:///a.jd', diagramName: 'D' });
    });

    test('prefers the rendered model over a different active .jd file', () => {
        // The case the whole module exists for. A webview takes no text-editor focus, so the
        // active editor is routinely some other file; the button still means "what I see".
        expect(panelExportTarget(context({
            activeJpipeUri: 'file:///other.jd',
            renderedUri: 'file:///shown.jd',
            renderedDiagram: 'Shown'
        }))).toEqual({ kind: 'rendered', uri: 'file:///shown.jd', diagramName: 'Shown' });
    });

    test('still exports the rendered model when it is also the active editor', () => {
        // Same answer, so the caller can skip the reopen as an optimisation without the policy
        // depending on which document happens to hold focus.
        expect(panelExportTarget(context({
            activeJpipeUri: 'file:///a.jd',
            renderedUri: 'file:///a.jd',
            renderedDiagram: 'D'
        }))).toEqual({ kind: 'rendered', uri: 'file:///a.jd', diagramName: 'D' });
    });

    test('carries an undefined diagram name through rather than inventing one', () => {
        // A single-diagram file has no forced name; `generate` derives it from the cursor.
        expect(panelExportTarget(context({ renderedUri: 'file:///a.jd' })))
            .toEqual({ kind: 'rendered', uri: 'file:///a.jd', diagramName: undefined });
    });

    test('falls back to the active editor only when nothing has been rendered', () => {
        expect(panelExportTarget(context({ activeJpipeUri: 'file:///a.jd' })))
            .toEqual({ kind: 'activeEditor' });
    });

    test('reports nothing to export when neither exists', () => {
        // Must be its own outcome. Collapsing it into `activeEditor` is precisely the bug this
        // replaced: with no jPipe file anywhere, "just use the active editor" exports whatever
        // unrelated document happens to be open.
        expect(panelExportTarget(context())).toEqual({ kind: 'none' });
    });

    test('never answers activeEditor while something is rendered', () => {
        // Property, over the four combinations that matter: a rendered document always wins, so
        // no input can route an export away from the model on screen.
        for (const activeJpipeUri of [undefined, 'file:///same.jd', 'file:///other.jd']) {
            for (const renderedDiagram of [undefined, 'D']) {
                const target = panelExportTarget(context({
                    activeJpipeUri, renderedUri: 'file:///same.jd', renderedDiagram
                }));
                expect(target.kind).toBe('rendered');
            }
        }
    });
});
