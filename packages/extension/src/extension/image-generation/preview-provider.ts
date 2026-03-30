import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node.js';
import { ImageGenerator, ImageFormat } from './image-generator.js';
import { DiagramStateMachine } from './diagram-state.js';

interface DocumentSymbol {
    name: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    children?: DocumentSymbol[];
}

export class PreviewProvider {
    private static webviewPanel: vscode.WebviewPanel | undefined;
    private static webviewDisposed: boolean = true;
    private stateMachine: DiagramStateMachine;
    private subscriptions: vscode.Disposable[] = [];
    private lastRenderedDocumentUri: string | undefined;
    
    constructor(
        private readonly imageGenerator: ImageGenerator,
        private readonly languageClient: LanguageClient,
        context: vscode.ExtensionContext
    ) {
        this.stateMachine = new DiagramStateMachine();
        this.setupEventListeners(context);
    }
    
    public async openPreview(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        
        if (!editor || editor.document.languageId !== 'jpipe') {
            vscode.window.showErrorMessage('No active jPipe file');
            return;
        }
        
        if (PreviewProvider.webviewDisposed || !PreviewProvider.webviewPanel) {
            PreviewProvider.webviewPanel = this.createWebviewPanel();
            PreviewProvider.webviewDisposed = false;
        } else {
            PreviewProvider.webviewPanel.reveal(vscode.ViewColumn.Beside, true);
        }
        
        await this.updatePreview(editor.document, editor);
    }
    
    private setupEventListeners(context: vscode.ExtensionContext): void {
        const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.languageId === 'jpipe') {
                this.stateMachine.onFileSaved(document.uri.toString());
                if (PreviewProvider.webviewPanel && !PreviewProvider.webviewDisposed) {
                    const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
                    this.updatePreview(document, editor);
                }
            }
        });
        
        const changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.languageId === 'jpipe') {
                this.stateMachine.onFileChanged(e.document.uri.toString());
            }
        });
        
        const cursorListener = vscode.window.onDidChangeTextEditorSelection((e) => {
            if (e.textEditor.document.languageId !== 'jpipe' || !PreviewProvider.webviewPanel || PreviewProvider.webviewDisposed) return;
            if (!this.stateMachine.canRender()) {
                const msg = this.stateMachine.getMessage();
                if (msg) vscode.window.showInformationMessage(msg);
                return;
            }
            const docUri = e.textEditor.document.uri.toString();
            if (docUri === this.lastRenderedDocumentUri) {
                this.updateHighlightOnly(e.textEditor.document, e.textEditor);
            } else {
                this.updatePreview(e.textEditor.document, e.textEditor);
            }
        });
        
        const openListener = vscode.workspace.onDidOpenTextDocument((document) => {
            if (document.languageId === 'jpipe') {
                this.stateMachine.onFileOpened(document.uri.toString());
            }
        });
        
        this.subscriptions.push(saveListener, changeListener, cursorListener, openListener);
        context.subscriptions.push(...this.subscriptions);
    }
    
    /** Extract the SVG document from CLI output (drops any path or log text before/after the <svg>). */
    private extractSvgFromOutput(stdout: string): string {
        const start = stdout.indexOf('<svg');
        if (start < 0) return stdout;
        const end = stdout.indexOf('</svg>', start);
        if (end < 0) return stdout;
        return stdout.slice(start, end + 6);
    }
    
    private async updatePreview(document: vscode.TextDocument, editor: vscode.TextEditor | undefined): Promise<void> {
        if (!PreviewProvider.webviewPanel) return;
        
        try {
            PreviewProvider.webviewPanel.webview.html = this.getLoadingHtml();
            let svg = await this.imageGenerator.generate(false, ImageFormat.SVG, document);
            svg = this.extractSvgFromOutput(svg);
            const diagramName = this.imageGenerator.findDiagramName(document, editor);
            let highlightName = await this.getSymbolNameAtCursor(document, editor);
            if (highlightName === diagramName) highlightName = null;
            PreviewProvider.webviewPanel.webview.html = this.getHtmlForWebview(svg, highlightName ?? undefined, document.uri.fsPath, diagramName);
            this.lastRenderedDocumentUri = document.uri.toString();
        } catch (error: any) {
            const cleanError = error.message.replace(/.*\[31m/, '').replace(/\[0m.*/, '').replace(/.*Command failed.*?SVG\s+/, '');
            vscode.window.showErrorMessage(`jPipe Error: ${cleanError}`);
            PreviewProvider.webviewPanel.webview.html = this.getErrorHtml(error.message);
            this.lastRenderedDocumentUri = undefined;
        }
    }
    
    /** Update only which node is highlighted (no SVG reload). */
    private async updateHighlightOnly(document: vscode.TextDocument, editor: vscode.TextEditor | undefined): Promise<void> {
        if (!PreviewProvider.webviewPanel) return;
        const diagramName = this.imageGenerator.findDiagramName(document, editor);
        let name = await this.getSymbolNameAtCursor(document, editor);
        if (name === diagramName) name = null;
        PreviewProvider.webviewPanel.webview.postMessage({ type: 'highlight', name: name ?? null });
    }
    
    /**
     * Resolve the LSP document symbol at the current cursor and return its name
     * (so we can highlight the corresponding node in the SVG).
     */
    private async getSymbolNameAtCursor(document: vscode.TextDocument, editor: vscode.TextEditor | undefined): Promise<string | null> {
        if (!editor) return null;
        const position = editor.selection.active;
        try {
            const symbols = await this.languageClient.sendRequest<DocumentSymbol[] | null>(
                'textDocument/documentSymbol',
                { textDocument: { uri: document.uri.toString() } }
            );
            if (!symbols || !Array.isArray(symbols)) return null;
            const found = this.findSymbolAtPosition(symbols, position.line, position.character);
            return found?.name ?? null;
        } catch {
            return null;
        }
    }
    
    private findSymbolAtPosition(symbols: DocumentSymbol[], line: number, character: number): DocumentSymbol | null {
        let best: DocumentSymbol | null = null;
        for (const sym of symbols) {
            if (!this.rangeContains(sym.range, line, character)) continue;
            const child = sym.children?.length
                ? this.findSymbolAtPosition(sym.children, line, character)
                : null;
            const chosen = child ?? sym;
            if (!best || this.rangeSmaller(chosen.range, best.range)) best = chosen;
        }
        return best;
    }
    
    private rangeContains(range: DocumentSymbol['range'], line: number, character: number): boolean {
        const { start, end } = range;
        if (line < start.line || line > end.line) return false;
        if (line === start.line && character < start.character) return false;
        if (line === end.line && character > end.character) return false;
        return true;
    }
    
    private rangeSmaller(a: DocumentSymbol['range'], b: DocumentSymbol['range']): boolean {
        const spanA = (a.end.line - a.start.line) * 10000 + (a.end.character - a.start.character);
        const spanB = (b.end.line - b.start.line) * 10000 + (b.end.character - b.start.character);
        return spanA < spanB;
    }
    
    private createWebviewPanel(): vscode.WebviewPanel {
        const panel = vscode.window.createWebviewPanel(
            'jpipe.preview',
            'jPipe Preview',
            {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: true
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        
        panel.onDidDispose(() => {
            PreviewProvider.webviewPanel = undefined;
            PreviewProvider.webviewDisposed = true;
        });
        
        panel.webview.onDidReceiveMessage((msg: { type?: string; format?: string; url?: string }) => {
            if (msg.type === 'download' && msg.format) {
                const fmt = (ImageFormat as Record<string, ImageFormat>)[msg.format];
                if (fmt !== undefined) this.imageGenerator.generateAndSave(fmt);
            }
            if (msg.type === 'openLink' && msg.url) {
                vscode.env.openExternal(vscode.Uri.parse(msg.url));
            }
        });
        
        return panel;
    }
    
    private getHtmlForWebview(svg: string, highlightNodeName?: string, documentPath?: string, diagramName?: string): string {
        const highlightJson = highlightNodeName != null ? JSON.stringify(highlightNodeName) : 'null';
        const pathToStripJson = documentPath != null ? JSON.stringify(documentPath) : 'null';
        const diagramNameJson = diagramName != null ? JSON.stringify(diagramName) : 'null';
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>jPipe Preview</title>
    <style>
        * { box-sizing: border-box; }
        body {
            margin: 0;
            padding: 0;
            overflow: hidden;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family), system-ui, sans-serif;
        }
        #toolbar {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            height: 44px;
            z-index: 1000;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 12px 0 8px;
            background: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
        }
        #brand {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        #brand a {
            color: var(--vscode-foreground);
            text-decoration: none;
            font-weight: 600;
            font-size: 15px;
            letter-spacing: 0.02em;
            padding: 6px 10px;
            border-radius: 6px;
            transition: background 0.15s ease, color 0.15s ease;
        }
        #brand a:hover {
            background: var(--vscode-toolbar-hoverBackground);
            color: var(--vscode-foreground);
        }
        #brand a { cursor: pointer; }
        #toolbar-right {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .toolbar-group {
            display: flex;
            align-items: center;
            gap: 2px;
            padding: 0 6px;
            border-right: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
        }
        .toolbar-group:last-of-type { border-right: none; padding-right: 0; }
        .toolbar-btn {
            width: 32px;
            height: 32px;
            border: none;
            border-radius: 6px;
            background: transparent;
            color: var(--vscode-foreground);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.15s ease;
        }
        .toolbar-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
        }
        .toolbar-btn svg { width: 18px; height: 18px; }
        .toolbar-btn.zoom { width: 28px; }
        .download-wrap {
            position: relative;
        }
        #download-drawer {
            position: absolute;
            top: 100%;
            right: 0;
            margin-top: 4px;
            min-width: 100%;
            background: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            padding: 4px 0;
            display: none;
            z-index: 1001;
        }
        #download-drawer.open { display: block; }
        #download-drawer button {
            width: 100%;
            padding: 8px 14px;
            font-size: 12px;
            text-align: left;
            border: none;
            background: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            white-space: nowrap;
        }
        #download-drawer button:hover {
            background: var(--vscode-list-hoverBackground);
        }
        #zoom-value {
            min-width: 44px;
            text-align: center;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        #container {
            position: fixed;
            top: 44px;
            left: 0;
            right: 0;
            bottom: 0;
            overflow: auto;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        #svg-wrapper {
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            transform-origin: center center;
            transition: transform 0.15s ease-out;
        }
        #svg-wrapper > svg {
            max-width: 100%;
            max-height: 100%;
            width: auto;
            height: auto;
            object-fit: contain;
        }
        #svg-wrapper .jpipe-highlight ellipse,
        #svg-wrapper .jpipe-highlight path,
        #svg-wrapper .jpipe-highlight polygon {
            stroke: #e6b422 !important;
            stroke-width: 4 !important;
        }
        #svg-wrapper .jpipe-highlight text { font-weight: bold; }
        #svg-wrapper .jpipe-highlight {
            filter: drop-shadow(0 0 8px #e6b422);
        }
    </style>
</head>
<body>
    <div id="toolbar">
        <div id="brand">
            <a href="#" id="jpipe-link" title="Open jpipe.org">JPIPE</a>
        </div>
        <div id="toolbar-right">
            <div class="toolbar-group download-wrap">
                <button class="toolbar-btn" id="download-toggle" title="Download"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 10.5l3-3H9V2H7v5.5H5l3 3zM2 12v2h12v-2H2z"/></svg></button>
                <div id="download-drawer">
                    <button data-format="SVG">SVG</button>
                    <button data-format="PNG">PNG</button>
                    <button data-format="JSON">JSON</button>
                </div>
            </div>
            <div class="toolbar-group">
                <button class="toolbar-btn zoom" id="zoom-out" title="Zoom out">−</button>
                <span id="zoom-value">100%</span>
                <button class="toolbar-btn zoom" id="zoom-in" title="Zoom in">+</button>
            </div>
        </div>
    </div>
    <div id="container">
        <div id="svg-wrapper">
            ${svg}
        </div>
    </div>
    <script>
        const wrapper = document.getElementById('svg-wrapper');
        const svgEl = wrapper && wrapper.querySelector('svg');
        var pathToStrip = ${pathToStripJson};
        var captionToStrip = ${diagramNameJson};
        if (svgEl) {
            function shouldRemove(el) {
                var t = (el.textContent || '').trim();
                if (pathToStrip && typeof pathToStrip === 'string' && (el.textContent || '').indexOf(pathToStrip) >= 0) return true;
                if (captionToStrip && typeof captionToStrip === 'string' && t === captionToStrip) return true;
                return false;
            }
            svgEl.querySelectorAll('text, title').forEach(function(el) {
                if (shouldRemove(el)) el.remove();
            });
            svgEl.querySelectorAll('g').forEach(function(g) {
                var directText = g.querySelectorAll(':scope > text');
                if (directText.length === 1 && shouldRemove(directText[0])) g.remove();
            });
        }
        
        function applyHighlight(symbolName) {
            if (!svgEl) return;
            svgEl.querySelectorAll('.jpipe-highlight').forEach(function(el) { el.classList.remove('jpipe-highlight'); });
            const name = (symbolName && typeof symbolName === 'string') ? symbolName.trim() : '';
            if (!name) return;
            function addHighlight(g) {
                if (g && !g.classList.contains('jpipe-highlight')) g.classList.add('jpipe-highlight');
            }
            svgEl.querySelectorAll('title').forEach(function(t) {
                if ((t.textContent || '').trim() === name) {
                    var g = t.closest('g.node') || t.closest('g');
                    if (g) addHighlight(g);
                }
            });
            svgEl.querySelectorAll('g.node text, g text').forEach(function(t) {
                if ((t.textContent || '').trim() === name) {
                    var g = t.closest('g.node') || t.closest('g');
                    if (g) addHighlight(g);
                }
            });
            var byId = document.getElementById(name);
            if (byId && svgEl.contains(byId)) addHighlight(byId.closest('g') || byId);
        }
        
        applyHighlight(${highlightJson});
        window.addEventListener('message', function(event) {
            var msg = event.data;
            if (msg && msg.type === 'highlight') applyHighlight(msg.name);
        });
        
        (function() {
            try {
                var vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
                var drawer = document.getElementById('download-drawer');
                var downloadToggle = document.getElementById('download-toggle');
                if (downloadToggle && drawer) {
                    downloadToggle.addEventListener('click', function(e) {
                        e.stopPropagation();
                        drawer.classList.toggle('open');
                    });
                    document.getElementById('download-drawer').querySelectorAll('button[data-format]').forEach(function(btn) {
                        btn.addEventListener('click', function() {
                            var format = this.getAttribute('data-format');
                            if (format && vscodeApi) {
                                vscodeApi.postMessage({ type: 'download', format: format });
                                drawer.classList.remove('open');
                            }
                        });
                    });
                    document.addEventListener('click', function() {
                        drawer.classList.remove('open');
                    });
                    drawer.addEventListener('click', function(e) { e.stopPropagation(); });
                }
                if (vscodeApi) {
                    var jpipeLink = document.getElementById('jpipe-link');
                    if (jpipeLink) {
                        jpipeLink.addEventListener('click', function(e) {
                            e.preventDefault();
                            vscodeApi.postMessage({ type: 'openLink', url: 'https://jpipe.org' });
                        });
                    }
                }
            } catch (err) {}
        })();
        
        let scale = 1;
        const zoomInBtn = document.getElementById('zoom-in');
        const zoomOutBtn = document.getElementById('zoom-out');
        const zoomValueEl = document.getElementById('zoom-value');
        
        function updateZoom() {
            wrapper.style.transform = 'scale(' + scale + ')';
            if (zoomValueEl) zoomValueEl.textContent = Math.round(scale * 100) + '%';
        }
        
        zoomInBtn.addEventListener('click', function() {
            scale = Math.min(scale + 0.25, 3);
            updateZoom();
        });
        
        zoomOutBtn.addEventListener('click', function() {
            scale = Math.max(scale - 0.25, 0.25);
            updateZoom();
        });
        
        if (zoomValueEl) zoomValueEl.addEventListener('click', function() {
            scale = 1;
            updateZoom();
        });
        
        document.addEventListener('keydown', function(e) {
            if (e.key === '=' || e.key === '+') {
                e.preventDefault();
                scale = Math.min(scale + 0.25, 3);
                updateZoom();
            } else if (e.key === '-') {
                e.preventDefault();
                scale = Math.max(scale - 0.25, 0.25);
                updateZoom();
            } else if (e.key === '0') {
                e.preventDefault();
                scale = 1;
                updateZoom();
            }
        });
    </script>
</body>
</html>`;
    }
    
    private getLoadingHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>jPipe Preview</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        .spinner {
            width: 40px;
            height: 40px;
            border: 3px solid var(--vscode-editor-foreground);
            border-top: 3px solid var(--vscode-button-background);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="spinner"></div>
</body>
</html>`;
    }
    
    private getErrorHtml(message: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>jPipe Preview</title>
    <style>
        body {
            margin: 0;
            padding: 20px;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-errorForeground);
        }
    </style>
</head>
<body>
    <p>Error: ${message}</p>
</body>
</html>`;
    }
}
