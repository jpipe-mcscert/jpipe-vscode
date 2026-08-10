/**
 * The message contract between the preview panel's extension side and its webview.
 *
 * Types only — this module is imported by both the extension-host bundle and the browser
 * bundle, so it must pull in neither `vscode` nor the DOM.
 *
 * The panel used to rebuild `webview.html` from scratch on every render, which threw away the
 * page's state (zoom, pan, which overlay was showing) each time the user saved. The document
 * is now created once and everything after that arrives as one of these messages.
 */

/** Which layer of the panel is in front. */
export type ViewMode = 'diagram' | 'diagnostic' | 'empty';

/** A newly compiled diagram, and everything the page needs in order to show it. */
export interface RenderMessage {
    type: 'render';
    /**
     * Monotone counter. `updatePreview` is async, so two saves in flight can finish out of
     * order; the page ignores anything older than what it is already showing.
     */
    revision: number;
    /** The `<svg>…</svg>` slice of the compiler's stdout. */
    svg: string;
    documentUri: string;
    /** Absolute path of the source file, so the page can strip it out of the rendered caption. */
    documentPath: string | null;
    diagramName: string | null;
    /** Element to highlight, or null for none. Already filtered so it is never the diagram itself. */
    highlight: string | null;
    /** Present when the compiler reported a problem but still produced a usable diagram. */
    error: { exitCode?: number } | null;
    unsaved: boolean;
}

export type HostToWebview =
    | RenderMessage
    | { type: 'highlight'; name: string | null }
    | { type: 'setUnsaved'; unsaved: boolean }
    | { type: 'view'; mode: ViewMode }
    | { type: 'diagnostic'; output: string }
    | { type: 'busy'; busy: boolean }
    /** Settings the page needs. Sent on `ready` and again whenever they change. */
    | { type: 'config'; zoomSensitivity: number };

export type WebviewToHost =
    /**
     * Sent once the page script is listening. The extension replays the last render in
     * response, which is what lets the panel recover from a webview content reload
     * (`Developer: Reload Webviews`, an extension-host restart) without recompiling.
     */
    | { type: 'ready' }
    | { type: 'download'; format: string }
    | { type: 'openLink'; url: string }
    | { type: 'toggleMode' };
