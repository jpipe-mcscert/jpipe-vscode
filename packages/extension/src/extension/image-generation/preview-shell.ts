import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/**
 * The preview panel's HTML document.
 *
 * Built exactly once per panel. Everything that changes afterwards — the diagram, the
 * diagnostic text, which layer is in front, the unsaved banner — arrives as a message and is
 * applied to this document in place. Rebuilding it, as the panel used to on every render,
 * discards the page's state along with its contents.
 *
 * The four layers are all present from the start and selected by `body[data-mode]`; the busy
 * indicator sits over whichever is showing.
 *
 * The diagnostic layer carries both of its faces: the structured view (`#diag-panel` and the
 * chrome above it) and the raw `<pre>`. The raw one is not a leftover — it is the whole of the
 * layer when the compiler produced no structured report, which is what every build without
 * `diagnostic -f json` does, and it stays reachable behind the Raw toggle otherwise.
 */
export function getShellHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const asset = (...parts: string[]) =>
        webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts));
    const script = asset('out', 'webview', 'preview.js');
    const style = asset('out', 'webview', 'preview.css');

    // `blob:` is for the minimap, which renders the diagram into an isolated <img> so its copy
    // of the SVG cannot collide with the live one's element ids.
    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} blob: data:`,
        `style-src ${webview.cspSource}`,
        `font-src ${webview.cspSource}`,
        `script-src 'nonce-${nonce}'`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>jPipe Preview</title>
    <link rel="stylesheet" href="${style}">
</head>
<body data-mode="empty">
    <div id="toolbar">
        <div id="brand">
            <a href="#" id="jpipe-link" title="Open jpipe.org">JPIPE</a>
        </div>
        <div id="toolbar-right">
            <div class="toolbar-group download-wrap diagram-only">
                <button class="toolbar-btn" id="download-toggle" aria-label="Download" aria-haspopup="menu" aria-expanded="false" data-tooltip="Download"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 10.5l3-3H9V2H7v5.5H5l3 3zM2 12v2h12v-2H2z"/></svg></button>
                <div id="download-drawer" role="menu">
                    <button role="menuitem" data-format="SVG">SVG</button>
                    <button role="menuitem" data-format="PNG">PNG</button>
                    <button role="menuitem" data-format="JPEG">JPEG</button>
                    <button role="menuitem" data-format="JSON">JSON</button>
                    <button role="menuitem" data-format="DOT">DOT</button>
                    <button role="menuitem" data-format="PYTHON">Python</button>
                    <button role="menuitem" data-format="JPIPE">jPipe</button>
                </div>
            </div>
            <div class="toolbar-group diagram-only">
                <button class="toolbar-btn" id="highlight-toggle" aria-label="Highlight the element under the cursor" aria-pressed="false" data-tooltip="Highlight on cursor">
                    <svg class="eye-open" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2"/></svg>
                    <svg class="eye-closed" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2"/><line x1="2" y1="2" x2="14" y2="14"/></svg>
                </button>
            </div>
            <div class="toolbar-group diagram-only">
                <button class="toolbar-btn" id="zoom-fit" aria-label="Fit to window" data-tooltip="Fit to window"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6V2.5h3.5M14 6V2.5h-3.5M2 10v3.5h3.5M14 10v3.5h-3.5"/></svg></button>
                <button class="toolbar-btn zoom" id="zoom-out" aria-label="Zoom out" title="Zoom out">−</button>
                <button id="zoom-value" aria-label="Current zoom. Activate for actual size" title="Actual size (100%)">100%</button>
                <button class="toolbar-btn zoom" id="zoom-in" aria-label="Zoom in" title="Zoom in">+</button>
            </div>
            <!--
                The mode switch is last, and stays last. It is the only control that belongs to
                the panel rather than to whatever the panel is currently showing, so every
                mode-specific group appearing and disappearing to its left leaves it in the same
                place — which is what makes it findable.
            -->
            <div class="toolbar-group" id="mode-group">
                <button class="toolbar-btn" id="mode-toggle" aria-label="Diagnostic view" aria-pressed="false" data-tooltip="Diagnostic view"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="2.5" width="9" height="12" rx="1.5"/><rect x="5.75" y="1" width="4.5" height="2.6" rx="0.8"/><line x1="6" y1="8.5" x2="10" y2="8.5"/><line x1="6" y1="11.5" x2="10" y2="11.5"/></svg></button>
            </div>
        </div>
    </div>
    <div id="unsaved-banner">⚠ Unsaved changes — showing last saved version</div>
    <div class="layer" id="container" tabindex="0" role="application" aria-label="Diagram canvas. Arrow keys pan, plus and minus zoom, 0 fits to window, 1 shows actual size">
        <div id="svg-wrapper"></div>
    </div>
    <div class="layer" id="diagnostic-overlay">
        <div id="diag-summary">
            <div id="diag-stats"></div>
            <div id="diag-summary-actions">
                <button class="diag-chip-btn" id="diag-copy">Copy</button>
                <button class="diag-chip-btn" id="diag-raw-toggle" aria-pressed="false">Raw</button>
            </div>
        </div>
        <div id="diag-tabs" role="tablist" aria-label="Diagnostic report sections">
            <button role="tab" id="diag-tab-diagnostics" data-tab="diagnostics" aria-controls="diag-panel" aria-selected="true">Problems</button>
            <button role="tab" id="diag-tab-models" data-tab="models" aria-controls="diag-panel" aria-selected="false">Models</button>
            <button role="tab" id="diag-tab-symbols" data-tab="symbols" aria-controls="diag-panel" aria-selected="false">Symbols</button>
            <button role="tab" id="diag-tab-actions" data-tab="actions" aria-controls="diag-panel" aria-selected="false">Actions</button>
        </div>
        <div id="diag-controls">
            <input type="search" id="diag-filter" placeholder="Filter…" aria-label="Filter the current section">
            <div id="diag-controls-extra"></div>
        </div>
        <div id="diag-panel" role="tabpanel" tabindex="0"></div>
        <pre id="diag-output" tabindex="0"></pre>
    </div>
    <div class="layer" id="empty-overlay">
        <div class="message">Move the cursor into a diagram block to preview it.</div>
    </div>
    <div id="minimap" hidden aria-hidden="true">
        <img id="minimap-img" alt="">
        <div id="minimap-rect"></div>
    </div>
    <div id="busy-overlay"><div class="spinner"></div></div>
    <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
