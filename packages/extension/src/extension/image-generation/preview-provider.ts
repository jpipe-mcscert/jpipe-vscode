import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { ImageGenerator, ImageFormat, type DiagnosticRun } from './image-generator.js';
import { getShellHtml } from './preview-shell.js';
import type {
    DiagnosticMessage,
    HostToWebview,
    RenderMessage,
    WebviewToHost
} from '../../shared/preview-protocol.js';
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
    /**
     * The last render that succeeded, replayed when the webview announces itself.
     *
     * This used to be the last good HTML document, kept so that a failed compile would not
     * blank the panel. The page is no longer rebuilt per render, so it holds its own contents
     * and that job disappears; what remains is recovery — a webview whose content was reloaded
     * gets its diagram back without waiting on the compiler.
     */
    private lastRender: RenderMessage | undefined;
    /**
     * The diagnostic counterpart of `lastRender`, and for the same reason: without it, reloading
     * the webview while the diagnostic view was showing dropped the user back to the diagram.
     */
    private lastDiagnostic: DiagnosticMessage | undefined;
    /**
     * Renders are numbered because `updatePreview` is async: two saves in quick succession can
     * finish out of order, and the page ignores anything older than what it already shows.
     *
     * Diagnostic runs share the counter. They are just as async, and sharing it means the two
     * paths cannot disagree about which is newer when the user toggles mid-run.
     */
    private revision = 0;

    public getLastRenderedDocumentUri(): string | undefined {
        return this.lastRenderedDocumentUri;
    }

    public getLastRenderedDiagramName(): string | undefined {
        return this.lastRenderedDiagramName;
    }

    /**
     * Resolve a jPipe document to (re)render, along with the editor that carries the
     * relevant cursor context. Tries, in order: the active editor, any visible jPipe
     * editor, and finally the last-rendered document (reopened without an editor).
     * Returns undefined only when no jPipe document can be found at all.
     *
     * This exists so the toolbar toggle keeps working after the user clicks it: clicking
     * a webview button focuses the webview, which makes `activeTextEditor` undefined.
     */
    private async resolveActiveJpipeDocument(): Promise<{ document: vscode.TextDocument; editor: vscode.TextEditor | undefined } | undefined> {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor?.document.languageId === 'jpipe') {
            return { document: activeEditor.document, editor: activeEditor };
        }
        const visibleEditor = vscode.window.visibleTextEditors.find(e => e.document.languageId === 'jpipe');
        if (visibleEditor) {
            return { document: visibleEditor.document, editor: visibleEditor };
        }
        if (this.lastRenderedDocumentUri) {
            try {
                const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(this.lastRenderedDocumentUri));
                const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
                return { document, editor };
            } catch { /* fall through */ }
        }
        return undefined;
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
            const previousColumn = editor.viewColumn ?? vscode.ViewColumn.One;
            PreviewProvider.webviewPanel = this.createWebviewPanel();
            PreviewProvider.webviewDisposed = false;
            this.logger.info('Webview panel created');
            await this.lockPreviewGroup(previousColumn);
        } else {
            PreviewProvider.webviewPanel.reveal(vscode.ViewColumn.Beside, true);
        }

        this.logger.info(`Opening preview: ${editor.document.fileName}`);
        await this.updatePreview(editor.document, editor);
    }
    
    private async lockPreviewGroup(restoreColumn: vscode.ViewColumn): Promise<void> {
        const columnNames = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth'];
        // Wait for VS Code to resolve ViewColumn.Beside to an actual column number on panel.viewColumn
        await new Promise<void>(resolve => setTimeout(resolve, 100));
        const panelColumn = PreviewProvider.webviewPanel?.viewColumn;
        if (panelColumn === undefined || (panelColumn as number) <= 0) return;
        const colIndex = (panelColumn as number) - 1;
        if (colIndex >= columnNames.length) return;
        // Use executeCommand for focus so we can await it (panel.reveal() is fire-and-forget)
        await vscode.commands.executeCommand(`workbench.action.focus${columnNames[colIndex]}EditorGroup`);
        await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
        const restoreIndex = (restoreColumn as number) - 1;
        if (restoreIndex >= 0 && restoreIndex < columnNames.length) {
            await vscode.commands.executeCommand(`workbench.action.focus${columnNames[restoreIndex]}EditorGroup`);
        }
    }

    private setupEventListeners(context: vscode.ExtensionContext): void {
        const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.languageId !== 'jpipe' || !PreviewProvider.webviewPanel || PreviewProvider.webviewDisposed) return;
            this.unsaved = false;
            this.post({ type: 'setUnsaved', unsaved: false });
            const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
            this.updatePreview(document, editor);
        });

        const changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.languageId !== 'jpipe' || !PreviewProvider.webviewPanel || PreviewProvider.webviewDisposed) return;
            this.unsaved = true;
            this.post({ type: 'setUnsaved', unsaved: true });
        });

        const cursorListener = vscode.window.onDidChangeTextEditorSelection((e) => {
            if (e.textEditor.document.languageId !== 'jpipe' || !PreviewProvider.webviewPanel || PreviewProvider.webviewDisposed) return;
            const doc = e.textEditor.document;
            const editor = e.textEditor;
            const docUri = doc.uri.toString();
            if (this.viewMode === 'diagnostic') {
                // The symbol table follows the cursor. Highlight-only, always: the branches below
                // exist to re-render when the cursor moves to a different *diagram*, which the
                // diagnostic view does not have — and taking them here would run the compiler on
                // every keystroke to produce a report that cannot have changed.
                this.updateHighlightOnly(doc, editor);
                return;
            }
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

        // The page is built once, so it cannot read settings itself — it has to be told when
        // they change.
        const configListener = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('jpipe.previewZoomSensitivity')) this.postConfig();
        });

        this.subscriptions.push(saveListener, changeListener, cursorListener, openListener, configListener);
        context.subscriptions.push(...this.subscriptions);
    }
    
    /**
     * Run the compiler again for its text report, and hand it to the page.
     *
     * Tagged with the revision of the diagnostic the page is showing, so a reply that arrives
     * after the user has saved again is recognisably about the previous run and dropped.
     */
    private async sendTextReport(): Promise<void> {
        const showing = this.lastDiagnostic;
        if (!showing) return;
        const resolved = await this.resolveActiveJpipeDocument();
        if (!resolved) return;
        try {
            const text = await this.imageGenerator.generateTextDiagnostic(resolved.document);
            this.post({ type: 'diagnosticText', revision: showing.revision, text });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Could not produce the text diagnostic report: ${msg}`);
            this.post({
                type: 'diagnosticText',
                revision: showing.revision,
                text: `Could not produce the text report:\n\n${msg}`
            });
        }
    }

    /**
     * Open a source position from the diagnostic view.
     *
     * Opens by path rather than acting on the active editor: a location in the report may name a
     * file other than the one being diagnosed, which is how elements pulled in by a `load` show
     * up, and the row the user clicked said so.
     *
     * This is also the single place the compiler's coordinates become VS Code's. The compiler
     * counts lines from 1 and columns from 0; `vscode.Position` counts both from 0.
     */
    private async revealLocation(source: string, line: number, column: number): Promise<void> {
        try {
            const uri = vscode.Uri.file(source);
            const document = await vscode.workspace.openTextDocument(uri);
            const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column));
            const editor = await vscode.window.showTextDocument(document, {
                // Beside the panel, not on top of it: the preview is locked to its own group, so
                // reusing the group the user came from keeps both visible.
                viewColumn: vscode.ViewColumn.One,
                preserveFocus: false
            });
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(
                new vscode.Range(position, position),
                vscode.TextEditorRevealType.InCenterIfOutsideViewport
            );
        } catch (error) {
            // A stale report can name a file that has since moved. Worth a log line, not a modal.
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Could not reveal ${source}:${line}:${column} — ${msg}`);
        }
    }

    /** Extract the SVG document from CLI output (drops any path or log text before/after the <svg>). */
    private extractSvgFromOutput(stdout: string): string {
        const start = stdout.indexOf('<svg');
        if (start < 0) return stdout;
        const end = stdout.indexOf('</svg>', start);
        if (end < 0) return stdout;
        return stdout.slice(start, end + 6);
    }
    
    /** Send a message to the panel, if there still is one. */
    private post(message: HostToWebview): void {
        PreviewProvider.webviewPanel?.webview.postMessage(message);
    }

    /** Hand the page the settings it needs. Sent on `ready` and whenever they change. */
    private postConfig(): void {
        const sensitivity = vscode.workspace.getConfiguration('jpipe').get<number>('previewZoomSensitivity', 1);
        // Guard the range here as well as in the schema: a hand-edited settings.json can hold
        // anything, and a zero or negative multiplier would break zooming outright.
        const clamped = Number.isFinite(sensitivity) ? Math.min(4, Math.max(0.25, sensitivity)) : 1;
        this.post({ type: 'config', zoomSensitivity: clamped });
    }

    private async updatePreview(document: vscode.TextDocument, editor: vscode.TextEditor | undefined): Promise<void> {
        if (!PreviewProvider.webviewPanel) return;

        // Diagnostic mode bypasses diagram-name resolution
        if (this.viewMode === 'diagnostic') {
            const revision = ++this.revision;
            this.post({ type: 'busy', busy: true });
            let run: DiagnosticRun;
            try {
                run = await this.imageGenerator.generateDiagnostic(document);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.logger.error(`Diagnostic failed in ${document.fileName}: ${msg}`);
                run = { raw: `Failed to run diagnostic:\n\n${msg}`, report: null, exitCode: undefined };
            }
            if (this.viewMode !== 'diagnostic') return;
            // Same guard the render path uses: a slow run landing after a faster one would
            // otherwise replace newer content with older.
            if (this.lastDiagnostic && revision < this.lastDiagnostic.revision) {
                this.logger.debug(`Dropping stale diagnostic ${revision} (panel is showing ${this.lastDiagnostic.revision})`);
                return;
            }
            const message: DiagnosticMessage = {
                type: 'diagnostic',
                revision,
                raw: run.raw,
                report: run.report,
                unsaved: this.unsaved
            };
            this.lastDiagnostic = message;
            this.post(message);
            return;
        }

        // Resolve diagram name using the caller's editor (correct cursor context).
        // If the cursor is outside any diagram block, bail out silently so the
        // current preview stays visible and no error notification is shown.
        let diagramName: string;
        try {
            diagramName = this.imageGenerator.findDiagramName(document, editor);
        } catch {
            // No diagram under the cursor. The panel keeps whatever it was showing, but the
            // mode still has to be sent: this path is how the diagnostic toggle comes back, and
            // without it the panel would stay on the diagnostic text.
            this.post({ type: 'busy', busy: false });
            this.post({ type: 'view', mode: this.lastRender ? 'diagram' : 'empty' });
            return;
        }

        const revision = ++this.revision;
        try {
            this.post({ type: 'busy', busy: true });
            // Pass the pre-resolved diagramName so generate() does not re-derive
            // it from activeTextEditor (which may have a different cursor position).
            const stdout = await this.imageGenerator.generate(false, ImageFormat.SVG, document, diagramName);
            this.logger.debug(`Preview updated: '${diagramName}' in ${document.fileName}`);
            // The user may have switched to the diagnostic view while the compiler ran; a render
            // sent now would yank them back to the diagram. Mirrors the same check the
            // diagnostic branch makes above.
            if (this.viewMode !== 'diagram') return;
            this.sendRender(revision, this.extractSvgFromOutput(stdout), document, editor, diagramName, null);
        } catch (error: any) {
            const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
            const exitCode = typeof error?.exitCode === 'number'
                ? error.exitCode
                : (typeof error?.code === 'number' ? error.code : undefined);
            this.logRenderError(document.fileName, exitCode, error);
            this.logger.revealIfLogged(exitCode === 1 ? 'warn' : 'error');

            if (this.viewMode !== 'diagram') return;
            const svgFromError = this.extractSvgFromOutput(stdout);
            if (svgFromError.includes('<svg')) {
                this.sendRender(revision, svgFromError, document, editor, diagramName, { exitCode });
            } else {
                // Leave the last good diagram up rather than replacing it with an error screen.
                // With a persistent document that costs nothing: not sending is already the
                // right behaviour. lastRender is intentionally retained too, since it describes
                // what the panel is still showing, so the diagnostic toggle keeps a document to
                // work from.
                this.post({ type: 'busy', busy: false });
                if (!this.lastRender) this.post({ type: 'view', mode: 'empty' });
            }
        }
    }

    /** Build and send a render message, and remember it for the `ready` replay. */
    private async sendRender(
        revision: number,
        svg: string,
        document: vscode.TextDocument,
        editor: vscode.TextEditor | undefined,
        diagramName: string,
        error: { exitCode?: number } | null
    ): Promise<void> {
        let highlight = await this.getSymbolNameAtCursor(document, editor);
        if (highlight === diagramName) highlight = null;

        // The page drops out-of-order renders by revision, but the host has to as well.
        // Otherwise a slow first compile landing after a fast second one would leave the panel
        // showing the newer diagram while `lastRender` and the export target regressed to the
        // older one — so a reload, or a download, would quietly act on the wrong diagram.
        if (this.lastRender && revision < this.lastRender.revision) {
            this.logger.debug(`Dropping stale render ${revision} (panel is showing ${this.lastRender.revision})`);
            return;
        }

        const message: RenderMessage = {
            type: 'render',
            revision,
            svg,
            documentUri: document.uri.toString(),
            documentPath: document.uri.fsPath,
            diagramName,
            highlight,
            error,
            unsaved: this.unsaved
        };
        this.lastRender = message;
        this.lastRenderedDocumentUri = message.documentUri;
        this.lastRenderedDiagramName = diagramName;
        this.post(message);
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
        // findDiagramName throws when the cursor sits outside every diagram block, which is an
        // ordinary thing for a cursor to do; without this the highlight update rejects on each
        // such keystroke.
        let diagramName: string | undefined;
        try { diagramName = this.imageGenerator.findDiagramName(document, editor); } catch { /* no diagram at cursor */ }
        let name = await this.getSymbolNameAtCursor(document, editor);
        if (name === diagramName) name = null;
        if (this.logger.shouldLog('trace')) this.logger.trace(`Highlight-only update: '${name ?? '(none)'}' in '${diagramName ?? '(none)'}'`);
        this.post({ type: 'highlight', name: name ?? null });
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
                // Matters more now than it used to: losing the context loses the user's zoom
                // and pan along with the rendered diagram.
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, 'images'),
                    vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview')
                ]
            }
        );

        // Built once. Everything after this point is a message.
        panel.webview.html = getShellHtml(panel.webview, this.context.extensionUri);

        panel.iconPath = {
            light: vscode.Uri.joinPath(this.context.extensionUri, 'images', 'icon_light.svg'),
            dark:  vscode.Uri.joinPath(this.context.extensionUri, 'images', 'icon_dark.svg')
        };
        
        panel.onDidDispose(() => {
            PreviewProvider.webviewPanel = undefined;
            PreviewProvider.webviewDisposed = true;
            this.logger.info('Webview panel disposed');
        });
        
        panel.webview.onDidReceiveMessage((msg: WebviewToHost) => {
            if (msg.type === 'ready') {
                // The page is listening. Give it back whatever it was showing, so a webview
                // content reload does not cost a recompile — or a blank panel.
                this.postConfig();
                // Replay whichever view was in front. Sending the diagram unconditionally, as
                // this used to, meant a reload while reading the diagnostics silently switched
                // the panel back to the diagram.
                if (this.viewMode === 'diagnostic' && this.lastDiagnostic) {
                    panel.webview.postMessage(this.lastDiagnostic);
                } else if (this.lastRender) {
                    panel.webview.postMessage(this.lastRender);
                } else {
                    panel.webview.postMessage({ type: 'view', mode: 'empty' } satisfies HostToWebview);
                }
            }
            if (msg.type === 'download' && msg.format) {
                const fmt = (ImageFormat as Record<string, ImageFormat>)[msg.format];
                if (fmt !== undefined) {
                    const activeDoc = vscode.window.activeTextEditor?.document;
                    if (activeDoc?.languageId === 'jpipe'
                            && activeDoc.uri.toString() === this.lastRenderedDocumentUri) {
                        this.imageGenerator.generateAndSave(fmt, activeDoc);
                        return;
                    }
                    const lastUri = this.lastRenderedDocumentUri;
                    const lastDiagramName = this.lastRenderedDiagramName;
                    if (lastUri) {
                        vscode.workspace.openTextDocument(vscode.Uri.parse(lastUri))
                            .then(
                                doc => this.imageGenerator.generateAndSave(fmt, doc, lastDiagramName),
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
            if (msg.type === 'revealLocation') {
                void this.revealLocation(msg.source, msg.line, msg.column);
            }
            if (msg.type === 'requestTextReport') {
                void this.sendTextReport();
            }
            if (msg.type === 'toggleMode') {
                // Resolve a document BEFORE flipping viewMode so we never end up in a
                // mode we can't render (which leaves the toggle looking frozen).
                this.resolveActiveJpipeDocument().then(resolved => {
                    if (!resolved) {
                        this.logger.warn('Diagnostic toggle ignored: no jPipe document available to render');
                        return;
                    }
                    this.viewMode = this.viewMode === 'diagram' ? 'diagnostic' : 'diagram';
                    this.updatePreview(resolved.document, resolved.editor);
                });
            }
        });
        
        return panel;
    }
    
}
