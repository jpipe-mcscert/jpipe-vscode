/**
 * Which model the preview panel's download button should export.
 *
 * Split out of `preview-provider.ts` for the reason `preview-refresh.ts` was: the decision needs
 * nothing from the editor beyond two URIs, and it is worth testing, because getting it wrong
 * hands the user a correctly-formatted export of the wrong model with nothing to say so.
 *
 * The rule this encodes is **not** the one `PreviewProvider.resolveExportContext` uses, and the
 * difference is deliberate. That method serves the palette and menu commands, where the user is
 * editing a `.jd` file and means "export this one". Here the user clicked a button *inside the
 * panel*, so they mean "export what I am looking at" — and the active editor is frequently a
 * different `.jd` file, since a webview does not take text-editor focus.
 */

/** Everything the decision depends on. */
export interface PanelExportContext {
    /** The active editor's document, if it holds a `.jd` file. Undefined otherwise. */
    readonly activeJpipeUri: string | undefined;
    /** The document the panel is showing, if it has shown one. */
    readonly renderedUri: string | undefined;
    /** The diagram the panel is showing, when it is showing one of several. */
    readonly renderedDiagram: string | undefined;
}

export type ExportTarget =
    /** Export this document — the one the panel is displaying. */
    | { readonly kind: 'rendered'; readonly uri: string; readonly diagramName: string | undefined }
    /** Export whatever the active editor holds; the panel has nothing of its own to offer. */
    | { readonly kind: 'activeEditor' }
    /** There is nothing to export. */
    | { readonly kind: 'none' };

/**
 * Decides what the panel's download button exports.
 *
 * - **What the panel rendered wins**, whenever it has rendered anything. This is the whole point
 *   of the rule: the button lives in the panel, so it means the panel's model, even when the
 *   active editor has moved on to a different file.
 * - **With nothing rendered**, the active `.jd` file is the only sensible reading of the click,
 *   and it is what the button did before this rule was written down.
 * - **Otherwise nothing**, which the caller reports. It must never quietly become "the active
 *   editor" — that is the wrong-model export this module exists to prevent.
 *
 * Note what is absent: there is no case for "the rendered document could not be reopened". That
 * is a failure for the caller to report, not a reason to export something else.
 */
export function panelExportTarget(context: PanelExportContext): ExportTarget {
    if (context.renderedUri !== undefined) {
        return { kind: 'rendered', uri: context.renderedUri, diagramName: context.renderedDiagram };
    }
    if (context.activeJpipeUri !== undefined) {
        return { kind: 'activeEditor' };
    }
    return { kind: 'none' };
}
