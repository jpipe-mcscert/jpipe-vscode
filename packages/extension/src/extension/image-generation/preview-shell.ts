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
            <div class="toolbar-group download-wrap">
                <button class="toolbar-btn" id="download-toggle" data-tooltip="Download"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 10.5l3-3H9V2H7v5.5H5l3 3zM2 12v2h12v-2H2z"/></svg></button>
                <div id="download-drawer">
                    <button data-format="SVG">SVG</button>
                    <button data-format="PNG">PNG</button>
                    <button data-format="JPEG">JPEG</button>
                    <button data-format="JSON">JSON</button>
                    <button data-format="DOT">DOT</button>
                    <button data-format="PYTHON">Python</button>
                    <button data-format="JPIPE">jPipe</button>
                </div>
            </div>
            <div class="toolbar-group diagram-only">
                <button class="toolbar-btn" id="highlight-toggle" data-tooltip="Highlight on cursor">
                    <svg class="eye-open" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2"/></svg>
                    <svg class="eye-closed" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2"/><line x1="2" y1="2" x2="14" y2="14"/></svg>
                </button>
            </div>
            <div class="toolbar-group">
                <button class="toolbar-btn" id="mode-toggle" data-tooltip="Diagnostic view"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="2.5" width="9" height="12" rx="1.5"/><rect x="5.75" y="1" width="4.5" height="2.6" rx="0.8"/><line x1="6" y1="8.5" x2="10" y2="8.5"/><line x1="6" y1="11.5" x2="10" y2="11.5"/></svg></button>
            </div>
            <div class="toolbar-group diagram-only">
                <button class="toolbar-btn" id="zoom-fit" data-tooltip="Fit to window"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6V2.5h3.5M14 6V2.5h-3.5M2 10v3.5h3.5M14 10v3.5h-3.5"/></svg></button>
                <button class="toolbar-btn zoom" id="zoom-out" title="Zoom out">−</button>
                <span id="zoom-value" title="Fit to window">100%</span>
                <button class="toolbar-btn zoom" id="zoom-in" title="Zoom in">+</button>
            </div>
        </div>
    </div>
    <div id="unsaved-banner">⚠ Unsaved changes — showing last saved version</div>
    <div class="layer" id="container">
        <div id="svg-wrapper"></div>
    </div>
    <div class="layer" id="diagnostic-overlay"><pre id="diag-output"></pre></div>
    <div class="layer" id="empty-overlay">
        <div class="message">Move the cursor into a diagram block to preview it.</div>
    </div>
    <div id="minimap" hidden>
        <img id="minimap-img" alt="">
        <div id="minimap-rect"></div>
    </div>
    <div id="busy-overlay"><div class="spinner"></div></div>
    <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
