import type * as vscode from 'vscode';
import { pageSecurity } from '../preview/preview-shell.js';

/**
 * The run panel's HTML document, built once per panel: everything after it is a `state` message.
 *
 * It wears the preview's stylesheet, so its toolbar, banners, canvas and minimap are the
 * preview's, and adds its own for the verdict and the view switch. The canvas is the preview's
 * too (`webview/canvas.ts`).
 *
 * `body[data-mode]` picks the layer, as in the preview: `diagram`, or `empty` with a message.
 * `body[data-phase]` says where the run is, which decides which of ▶, ✓ and ■ can be pressed.
 *
 * It draws one thing, the run's dataflow: the argument alone is what the preview shows.
 */
export function getRunShellHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const { nonce, csp, asset } = pageSecurity(webview, extensionUri);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>jPipe Run</title>
    <link rel="stylesheet" href="${asset('out', 'webview', 'preview.css')}">
    <link rel="stylesheet" href="${asset('out', 'webview', 'run.css')}">
</head>
<body data-mode="empty" data-phase="blocked">
    <div id="toolbar">
        <div class="toolbar-group" id="run-actions">
            <button class="toolbar-btn" id="run-button" aria-label="Execute: run every step" data-tooltip="Execute"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.5v11l9-5.5z"/></svg></button>
            <button class="toolbar-btn" id="check-button" aria-label="Check, without calling any step" data-tooltip="Check"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8.5l3.5 3.5 7.5-8"/></svg></button>
            <button class="toolbar-btn" id="stop-button" aria-label="Stop" data-tooltip="Stop"><svg viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg></button>
        </div>
        <div id="toolbar-right">
            <div class="toolbar-group diagram-only">
                <button class="toolbar-btn" id="zoom-fit" aria-label="Fit to window" data-tooltip="Fit to window"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6V2.5h3.5M14 6V2.5h-3.5M2 10v3.5h3.5M14 10v3.5h-3.5"/></svg></button>
                <button class="toolbar-btn zoom" id="zoom-out" aria-label="Zoom out" title="Zoom out">−</button>
                <button id="zoom-value" aria-label="Current zoom. Activate for actual size" title="Actual size (100%)">100%</button>
                <button class="toolbar-btn zoom" id="zoom-in" aria-label="Zoom in" title="Zoom in">+</button>
            </div>
            <div class="toolbar-group diagram-only">
                <button class="toolbar-btn" id="download-button" aria-label="Save the dataflow as SVG" data-tooltip="Save as SVG"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 10.5l3-3H9V2H7v5.5H5l3 3zM2 12v2h12v-2H2z"/></svg></button>
            </div>
            <div class="toolbar-group">
                <button class="toolbar-btn" id="results-button" aria-label="Show the Results view" data-tooltip="Results"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.75" cy="4" r="0.9" fill="currentColor"/><circle cx="2.75" cy="8" r="0.9" fill="currentColor"/><circle cx="2.75" cy="12" r="0.9" fill="currentColor"/></svg></button>
                <button class="toolbar-btn" id="output-button" aria-label="Show what the run printed" data-tooltip="Output"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6.5l2 1.5-2 1.5M8 10h3.5"/></svg></button>
            </div>
        </div>
    </div>
    <div id="banners">
        <div class="banner" id="verdict-bar" role="status" aria-live="polite">
            <span class="banner-glyph" id="verdict-glyph" aria-hidden="true"></span>
            <span id="verdict-kind"></span>
            <span id="verdict-label"></span>
            <span id="verdict-counts"></span>
            <span id="verdict-when"></span>
        </div>
        <div class="banner" id="notice-banner" role="status" aria-live="polite">
            <span class="banner-glyph" aria-hidden="true">✖</span>
            <span id="notice-text"></span>
            <button class="banner-action" id="notice-action" type="button"></button>
        </div>
        <div class="banner" id="out-of-date-banner" role="status" aria-live="polite">
            <span class="banner-glyph" aria-hidden="true">⚠</span>
            <span id="out-of-date-text"></span>
            <button class="banner-action" id="out-of-date-action" type="button">Run again</button>
        </div>
    </div>
    <div class="layer" id="container" tabindex="0" role="application" aria-label="Dataflow of the run. Click a node to select it in Results, double-click to open it. Arrow keys pan, plus and minus zoom, 0 fits to window, 1 shows actual size">
        <div id="svg-wrapper"></div>
    </div>
    <div class="layer" id="empty-overlay">
        <div class="message" id="empty-message"></div>
    </div>
    <div id="minimap" hidden aria-hidden="true">
        <img id="minimap-img" alt="">
        <div id="minimap-rect"></div>
    </div>
    <div id="busy-overlay"><div class="spinner"></div></div>
    <script nonce="${nonce}" src="${asset('out', 'webview', 'run.js')}"></script>
</body>
</html>`;
}
