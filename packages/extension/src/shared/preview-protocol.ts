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

import type { DiagnosticReport } from './diagnostic-report.js';

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

/**
 * A diagnostic run, ready to display.
 *
 * `raw` is the compiler's text output and is always present: it is the whole of the panel when
 * `report` is null — an older compiler, unparseable output, or a schema version this build does
 * not know — and it stays reachable behind the raw toggle when a report did arrive.
 */
export interface DiagnosticMessage {
    type: 'diagnostic';
    /** Same purpose as `RenderMessage.revision`: two saves in flight can finish out of order. */
    revision: number;
    raw: string;
    report: DiagnosticReport | null;
    unsaved: boolean;
}

export type HostToWebview =
    | RenderMessage
    | { type: 'highlight'; name: string | null }
    | { type: 'setUnsaved'; unsaved: boolean }
    | { type: 'view'; mode: ViewMode }
    | DiagnosticMessage
    /** The compiler's text report, in reply to `requestTextReport`. */
    | { type: 'diagnosticText'; revision: number; text: string }
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
    | { type: 'toggleMode' }
    /**
     * Jump to a position in the source.
     *
     * `source` is already resolved to an absolute path by the page — a location may name a file
     * other than the one being diagnosed, which is how elements pulled in by a `load` appear, so
     * the host opens by path rather than acting on the active editor. Line is 1-based and column
     * 0-based, the compiler's convention; the host converts.
     */
    | { type: 'revealLocation'; source: string; line: number; column: number }
    /**
     * Ask for the compiler's human-readable report.
     *
     * Only meaningful once the compiler reports as JSON, where the run's own output is the JSON
     * and the text version is a second invocation. Requested when a reader asks for it rather
     * than fetched alongside every save, since most never open it.
     */
    | { type: 'requestTextReport' };
