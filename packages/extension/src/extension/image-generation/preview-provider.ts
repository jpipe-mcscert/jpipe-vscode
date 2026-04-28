import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node.js';
import { ImageGenerator, ImageFormat } from './image-generator.js';
import type { JpipeLogger } from '../logger.js';

interface DocumentSymbol {
    name: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    children?: DocumentSymbol[];
}

export class PreviewProvider {
    private static webviewPanel: vscode.WebviewPanel | undefined;
    private static webviewDisposed: boolean = true;
    private unsaved: boolean = false;
    private viewMode: 'diagram' | 'diagnostic' = 'diagram';
    private subscriptions: vscode.Disposable[] = [];
    private lastRenderedDocumentUri: string | undefined;
    private lastRenderedDiagramName: string | undefined;
    private lastGoodHtml: string | undefined;

    public getLastRenderedDocumentUri(): string | undefined {
        return this.lastRenderedDocumentUri;
    }

    constructor(
        private readonly imageGenerator: ImageGenerator,
        private readonly languageClient: LanguageClient,
        private readonly context: vscode.ExtensionContext,
        private readonly logger: JpipeLogger
    ) {
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
            this.logger.info('Webview panel created');
            // Focus the panel group, lock it, then restore focus to the editor
            PreviewProvider.webviewPanel.reveal(vscode.ViewColumn.Beside, false);
            await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
            PreviewProvider.webviewPanel.reveal(vscode.ViewColumn.Beside, true);
        } else {
            PreviewProvider.webviewPanel.reveal(vscode.ViewColumn.Beside, true);
        }

        this.logger.info(`Opening preview: ${editor.document.fileName}`);
        await this.updatePreview(editor.document, editor);
    }
    
    private setupEventListeners(context: vscode.ExtensionContext): void {
        const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.languageId !== 'jpipe' || !PreviewProvider.webviewPanel || PreviewProvider.webviewDisposed) return;
            this.unsaved = false;
            PreviewProvider.webviewPanel.webview.postMessage({ type: 'setUnsaved', unsaved: false });
            const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
            this.updatePreview(document, editor);
        });

        const changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.languageId !== 'jpipe' || !PreviewProvider.webviewPanel || PreviewProvider.webviewDisposed) return;
            this.unsaved = true;
            PreviewProvider.webviewPanel.webview.postMessage({ type: 'setUnsaved', unsaved: true });
        });

        const cursorListener = vscode.window.onDidChangeTextEditorSelection((e) => {
            if (e.textEditor.document.languageId !== 'jpipe' || !PreviewProvider.webviewPanel || PreviewProvider.webviewDisposed) return;
            const doc = e.textEditor.document;
            const editor = e.textEditor;
            const docUri = doc.uri.toString();
            if (docUri !== this.lastRenderedDocumentUri) {
                if (!this.unsaved) this.updatePreview(doc, editor);
                return;
            }
            let currentDiagram: string | undefined;
            try { currentDiagram = this.imageGenerator.findDiagramName(doc, editor); } catch { /* no diagram at cursor */ }
            if (currentDiagram && currentDiagram !== this.lastRenderedDiagramName && !this.unsaved) {
                this.updatePreview(doc, editor);
            } else {
                this.updateHighlightOnly(doc, editor);
            }
        });

        const openListener = vscode.workspace.onDidOpenTextDocument((document) => {
            if (document.languageId === 'jpipe') {
                this.unsaved = false;
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
            if (this.viewMode === 'diagnostic') {
                const output = await this.imageGenerator.generateDiagnostic(document);
                PreviewProvider.webviewPanel.webview.html = this.getHtmlForDiagnostic(output, this.unsaved);
                return;
            }
            // Avoid blanking the whole preview on transient render errors:
            // only show a full loading screen if we have nothing rendered yet.
            if (!this.lastGoodHtml) {
                PreviewProvider.webviewPanel.webview.html = this.getLoadingHtml();
            }
            let svg = await this.imageGenerator.generate(false, ImageFormat.SVG, document);
            svg = this.extractSvgFromOutput(svg);
            const diagramName = this.imageGenerator.findDiagramName(document, editor);
            this.logger.debug(`Preview updated: '${diagramName}' in ${document.fileName}`);
            let highlightName = await this.getSymbolNameAtCursor(document, editor);
            if (highlightName === diagramName) highlightName = null;
            const html = this.getHtmlForWebview(svg, highlightName ?? undefined, document.uri.fsPath, diagramName, undefined, this.unsaved);
            PreviewProvider.webviewPanel.webview.html = html;
            this.lastGoodHtml = html;
            this.lastRenderedDocumentUri = document.uri.toString();
            this.lastRenderedDiagramName = diagramName;
        } catch (error: any) {
            const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
            const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
            const exitCode = typeof error?.exitCode === 'number'
                ? error.exitCode
                : (typeof error?.code === 'number' ? error.code : undefined);
            this.logRenderError(document.fileName, exitCode, error);
            const cleanMsg = String(error?.message ?? error)
                .replace(/.*\[31m/, '')
                .replace(/\[0m.*/, '')
                .replace(/.*Command failed.*?SVG\s+/, '');

            const svgFromError = this.extractSvgFromOutput(stdout);
            const hasSvg = svgFromError.includes('<svg');
            const diagramName = (() => {
                try { return this.imageGenerator.findDiagramName(document, editor); } catch { return undefined; }
            })();
            let highlightName = await this.getSymbolNameAtCursor(document, editor);
            if (highlightName === diagramName) highlightName = null;

            if (hasSvg) {
                const html = this.getHtmlForWebview(
                    svgFromError,
                    highlightName ?? undefined,
                    document.uri.fsPath,
                    diagramName,
                    { hasError: true, exitCode },
                    this.unsaved
                );
                PreviewProvider.webviewPanel.webview.html = html;
                this.lastGoodHtml = html;
                const msg = (stderr || cleanMsg).trim();
                if (exitCode === 1) {
                    vscode.window.showWarningMessage(msg ? `jPipe: model has errors (exit code 1): ${msg}` : 'jPipe: model has errors (exit code 1)');
                } else if (exitCode === 42) {
                    vscode.window.showErrorMessage(msg ? `jPipe: compiler crashed (exit code 42): ${msg}` : 'jPipe: compiler crashed (exit code 42)');
                } else {
                    vscode.window.showErrorMessage(msg ? `jPipe Error: ${msg}` : 'jPipe Error: render failed');
                }
                this.lastRenderedDocumentUri = document.uri.toString();
            } else {
                if (exitCode === 1) {
                    vscode.window.showWarningMessage(`jPipe: model has errors (exit code 1): ${cleanMsg}`);
                } else if (exitCode === 42) {
                    vscode.window.showErrorMessage(`jPipe: compiler crashed (exit code 42): ${cleanMsg}`);
                } else {
                    vscode.window.showErrorMessage(`jPipe Error: ${cleanMsg}`);
                }
                // Keep the last successfully rendered preview visible; don't replace it with a full-screen error view.
                if (this.lastGoodHtml) {
                    PreviewProvider.webviewPanel.webview.html = this.lastGoodHtml;
                } else {
                    PreviewProvider.webviewPanel.webview.html = this.getLoadingHtml();
                }
                this.lastRenderedDocumentUri = undefined;
            }
        }
    }
    
    private logRenderError(fileName: string, exitCode: number | undefined, error: unknown): void {
        if (exitCode === 1) {
            this.logger.warn(`Render: model errors (exit 1) in ${fileName}`);
        } else if (exitCode === 42) {
            this.logger.error(`Render: compiler crash (exit 42) in ${fileName}`);
        } else {
            let msg: string;
            if (error instanceof Error) { msg = error.message; }
            else if (typeof error === 'string') { msg = error; }
            else { msg = '[unknown error]'; }
            this.logger.error(`Render failed in ${fileName}: ${msg}`);
        }
    }

    /** Update only which node is highlighted (no SVG reload). */
    private async updateHighlightOnly(document: vscode.TextDocument, editor: vscode.TextEditor | undefined): Promise<void> {
        if (!PreviewProvider.webviewPanel) return;
        const diagramName = this.imageGenerator.findDiagramName(document, editor);
        let name = await this.getSymbolNameAtCursor(document, editor);
        if (name === diagramName) name = null;
        if (this.logger.shouldLog('trace')) this.logger.trace(`Highlight-only update: '${name ?? '(none)'}' in '${diagramName}'`);
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
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'images')]
            }
        );

        panel.iconPath = {
            light: vscode.Uri.joinPath(this.context.extensionUri, 'images', 'icon_light.svg'),
            dark:  vscode.Uri.joinPath(this.context.extensionUri, 'images', 'icon_dark.svg')
        };
        
        panel.onDidDispose(() => {
            PreviewProvider.webviewPanel = undefined;
            PreviewProvider.webviewDisposed = true;
            this.logger.info('Webview panel disposed');
        });
        
        panel.webview.onDidReceiveMessage((msg: { type?: string; format?: string; url?: string }) => {
            if (msg.type === 'download' && msg.format) {
                const fmt = (ImageFormat as Record<string, ImageFormat>)[msg.format];
                if (fmt !== undefined) {
                    const activeDoc = vscode.window.activeTextEditor?.document;
                    if (activeDoc?.languageId === 'jpipe') {
                        this.imageGenerator.generateAndSave(fmt, activeDoc);
                        return;
                    }
                    const lastUri = this.lastRenderedDocumentUri;
                    if (lastUri) {
                        vscode.workspace.openTextDocument(vscode.Uri.parse(lastUri))
                            .then(
                                doc => this.imageGenerator.generateAndSave(fmt, doc),
                                () => this.imageGenerator.generateAndSave(fmt)
                            );
                        return;
                    }
                    this.imageGenerator.generateAndSave(fmt);
                }
            }
            if (msg.type === 'openLink' && msg.url) {
                vscode.env.openExternal(vscode.Uri.parse(msg.url));
            }
            if (msg.type === 'toggleMode') {
                this.viewMode = this.viewMode === 'diagram' ? 'diagnostic' : 'diagram';
                const activeDoc = vscode.window.activeTextEditor?.document;
                const docToUse = activeDoc?.languageId === 'jpipe' ? activeDoc : undefined;
                if (docToUse) {
                    this.updatePreview(docToUse, vscode.window.activeTextEditor);
                } else if (this.lastRenderedDocumentUri) {
                    vscode.workspace.openTextDocument(vscode.Uri.parse(this.lastRenderedDocumentUri))
                        .then(doc => this.updatePreview(doc, undefined), () => {});
                }
            }
        });
        
        return panel;
    }
    
    private getHtmlForWebview(
        svg: string,
        highlightNodeName?: string,
        documentPath?: string,
        diagramName?: string,
        render?: { hasError?: boolean; exitCode?: number },
        unsaved?: boolean
    ): string {
        const highlightJson = highlightNodeName != null ? JSON.stringify(highlightNodeName) : 'null';
        const pathToStripJson = documentPath != null ? JSON.stringify(documentPath) : 'null';
        const diagramNameJson = diagramName != null ? JSON.stringify(diagramName) : 'null';
        const renderJson = render ? JSON.stringify(render) : 'null';
        const unsavedJson = unsaved ? 'true' : 'false';
        const iconUri = PreviewProvider.webviewPanel!.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'images', 'icon_light.svg')
        );
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
        body.jpipe-render-error #container {
            background: color-mix(in srgb, var(--vscode-errorForeground) 18%, var(--vscode-editor-background));
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
        .toolbar-btn.active {
            background: var(--vscode-toolbar-activeBackground, rgba(128,128,128,0.3));
            color: var(--vscode-focusBorder);
        }
        .toolbar-btn[data-tooltip] { position: relative; }
        .toolbar-btn[data-tooltip]::after {
            content: attr(data-tooltip);
            position: absolute;
            bottom: calc(100% + 6px);
            left: 50%;
            transform: translateX(-50%);
            background: var(--vscode-editorHoverWidget-background);
            border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.4));
            color: var(--vscode-editorHoverWidget-foreground);
            padding: 3px 8px;
            border-radius: 3px;
            font-size: 11px;
            white-space: nowrap;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.15s ease;
            z-index: 2000;
        }
        .toolbar-btn[data-tooltip]:hover::after { opacity: 1; }
        #highlight-toggle .eye-open  { display: none; }
        #highlight-toggle .eye-closed { display: flex; }
        #highlight-toggle.active .eye-open  { display: flex; }
        #highlight-toggle.active .eye-closed { display: none; }
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
        body.has-unsaved-banner #container { top: 72px; }
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
        #svg-wrapper g.node, #svg-wrapper g.edge { transition: opacity 0.15s ease; }
        #svg-wrapper .jpipe-dimmed { opacity: 0.2; }
        #unsaved-banner {
            position: fixed;
            top: 44px;
            left: 0;
            right: 0;
            z-index: 999;
            padding: 5px 12px;
            font-size: 12px;
            background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 15%, var(--vscode-editorWidget-background));
            border-bottom: 1px solid var(--vscode-editorWarning-foreground);
            color: var(--vscode-editorWarning-foreground);
            display: none;
        }
        #unsaved-banner.visible { display: block; }
    </style>
</head>
<body>
    <div id="toolbar">
        <div id="brand">
            <a href="#" id="jpipe-link" title="Open jpipe.org"><img src="${iconUri}" alt="jPipe" style="height:22px;width:auto;vertical-align:middle;"></a>
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
            <div class="toolbar-group">
                <button class="toolbar-btn" id="highlight-toggle" data-tooltip="Highlight on cursor">
                    <svg class="eye-open" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2"/></svg>
                    <svg class="eye-closed" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2"/><line x1="2" y1="2" x2="14" y2="14"/></svg>
                </button>
            </div>
            <div class="toolbar-group">
                <button class="toolbar-btn" id="mode-toggle" data-tooltip="Diagnostic view"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4"/><line x1="10" y1="10" x2="14" y2="14"/></svg></button>
            </div>
            <div class="toolbar-group">
                <button class="toolbar-btn zoom" id="zoom-out" title="Zoom out">−</button>
                <span id="zoom-value">100%</span>
                <button class="toolbar-btn zoom" id="zoom-in" title="Zoom in">+</button>
            </div>
        </div>
    </div>
    <div id="unsaved-banner">⚠ Unsaved changes — showing last saved version</div>
    <div id="container">
        <div id="svg-wrapper">
            ${svg}
        </div>
    </div>
    <script>
        const render = ${renderJson};
        if (render && render.hasError) {
            document.body.classList.add('jpipe-render-error');
        }
        (function() {
            var banner = document.getElementById('unsaved-banner');
            function setUnsaved(val) {
                if (!banner) return;
                if (val) {
                    banner.classList.add('visible');
                    document.body.classList.add('has-unsaved-banner');
                } else {
                    banner.classList.remove('visible');
                    document.body.classList.remove('has-unsaved-banner');
                }
            }
            setUnsaved(${unsavedJson});
            window.addEventListener('message', function(event) {
                var msg = event.data;
                if (msg && msg.type === 'setUnsaved') setUnsaved(!!msg.unsaved);
            });
        })();
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
        
        var highlightEnabled = false;
        var lastHighlightName = null;
        (function() {
            var btn = document.getElementById('highlight-toggle');
            if (!btn) return;
            btn.addEventListener('click', function() {
                highlightEnabled = !highlightEnabled;
                btn.classList.toggle('active', highlightEnabled);
                applyHighlight(lastHighlightName);
            });
        })();

        function applyHighlight(symbolName) {
            lastHighlightName = symbolName;
            if (!svgEl) return;
            var all = Array.from(svgEl.querySelectorAll('g.node, g.edge'));
            all.forEach(function(g) { g.classList.remove('jpipe-dimmed'); });
            if (!highlightEnabled) return;
            var name = (symbolName && typeof symbolName === 'string') ? symbolName.trim() : '';
            if (!name) return;
            var matched = null;
            if (captionToStrip) {
                var byId = document.getElementById(captionToStrip + ':' + name);
                if (byId && svgEl.contains(byId)) matched = byId.closest('g.node') || byId.closest('g.edge') || byId;
            }
            if (!matched) {
                var qualifiedName = captionToStrip ? captionToStrip + ':' + name : name;
                svgEl.querySelectorAll('title').forEach(function(t) {
                    if (!matched) {
                        var txt = (t.textContent || '').trim();
                        if (txt === qualifiedName || txt === name) {
                            matched = t.closest('g.node') || t.closest('g.edge') || t.closest('g');
                        }
                    }
                });
            }
            if (!matched) {
                svgEl.querySelectorAll('g.node text, g.edge text').forEach(function(t) {
                    if (!matched && (t.textContent || '').trim() === name) {
                        matched = t.closest('g.node') || t.closest('g.edge') || t.closest('g');
                    }
                });
            }
            if (matched) {
                all.forEach(function(g) { if (g !== matched) g.classList.add('jpipe-dimmed'); });
            }
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
                    var modeToggle = document.getElementById('mode-toggle');
                    if (modeToggle) {
                        modeToggle.addEventListener('click', function() {
                            vscodeApi.postMessage({ type: 'toggleMode' });
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
    
    private getHtmlForDiagnostic(output: string, unsaved: boolean = false): string {
        const escaped = output
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;');
        const unsavedJson = unsaved ? 'true' : 'false';
        const iconUri = PreviewProvider.webviewPanel!.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'images', 'icon_light.svg')
        );
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>jPipe Diagnostic</title>
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
            top: 0; left: 0; right: 0;
            height: 44px;
            z-index: 1000;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 12px 0 8px;
            background: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
        }
        #brand a {
            color: var(--vscode-foreground);
            text-decoration: none;
            font-weight: 600;
            font-size: 15px;
            letter-spacing: 0.02em;
            padding: 6px 10px;
            border-radius: 6px;
            transition: background 0.15s ease;
        }
        #brand a:hover { background: var(--vscode-toolbar-hoverBackground); }
        .toolbar-btn {
            width: 32px; height: 32px;
            border: none; border-radius: 6px;
            background: transparent;
            color: var(--vscode-foreground);
            cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            transition: background 0.15s ease;
        }
        .toolbar-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
        .toolbar-btn.active {
            background: var(--vscode-toolbar-activeBackground, rgba(128,128,128,0.3));
            color: var(--vscode-focusBorder);
        }
        .toolbar-btn[data-tooltip] { position: relative; }
        .toolbar-btn[data-tooltip]::after {
            content: attr(data-tooltip);
            position: absolute;
            bottom: calc(100% + 6px); left: 50%;
            transform: translateX(-50%);
            background: var(--vscode-editorHoverWidget-background);
            border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.4));
            color: var(--vscode-editorHoverWidget-foreground);
            padding: 3px 8px; border-radius: 3px;
            font-size: 11px; white-space: nowrap;
            pointer-events: none; opacity: 0;
            transition: opacity 0.15s ease; z-index: 2000;
        }
        .toolbar-btn[data-tooltip]:hover::after { opacity: 1; }
        #unsaved-banner {
            position: fixed;
            top: 44px; left: 0; right: 0;
            z-index: 999;
            padding: 5px 12px;
            font-size: 12px;
            background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 15%, var(--vscode-editorWidget-background));
            border-bottom: 1px solid var(--vscode-editorWarning-foreground);
            color: var(--vscode-editorWarning-foreground);
            display: none;
        }
        #unsaved-banner.visible { display: block; }
        body.has-unsaved-banner #container { top: 72px; }
        #container {
            position: fixed;
            top: 44px; left: 0; right: 0; bottom: 0;
            overflow: auto;
            padding: 12px;
        }
        #diag-output {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 13px;
            white-space: pre;
            margin: 0;
            color: var(--vscode-editor-foreground);
            line-height: 1.5;
        }
    </style>
</head>
<body>
    <div id="toolbar">
        <div id="brand">
            <a href="#" id="jpipe-link" title="Open jpipe.org"><img src="${iconUri}" alt="jPipe" style="height:22px;width:auto;vertical-align:middle;"></a>
        </div>
        <div>
            <button class="toolbar-btn active" id="mode-toggle" data-tooltip="Back to diagram view"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4"/><line x1="10" y1="10" x2="14" y2="14"/></svg></button>
        </div>
    </div>
    <div id="unsaved-banner">⚠ Unsaved changes — diagnostic reflects last saved version</div>
    <div id="container">
        <pre id="diag-output">${escaped}</pre>
    </div>
    <script>
        (function() {
            var banner = document.getElementById('unsaved-banner');
            function setUnsaved(val) {
                if (!banner) return;
                if (val) {
                    banner.classList.add('visible');
                    document.body.classList.add('has-unsaved-banner');
                } else {
                    banner.classList.remove('visible');
                    document.body.classList.remove('has-unsaved-banner');
                }
            }
            setUnsaved(${unsavedJson});
            window.addEventListener('message', function(event) {
                var msg = event.data;
                if (msg && msg.type === 'setUnsaved') setUnsaved(!!msg.unsaved);
            });
        })();
        (function() {
            try {
                var vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
                if (!vscodeApi) return;
                document.getElementById('mode-toggle').addEventListener('click', function() {
                    vscodeApi.postMessage({ type: 'toggleMode' });
                });
                document.getElementById('jpipe-link').addEventListener('click', function(e) {
                    e.preventDefault();
                    vscodeApi.postMessage({ type: 'openLink', url: 'https://jpipe.org' });
                });
            } catch (err) {}
        })();
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
}
