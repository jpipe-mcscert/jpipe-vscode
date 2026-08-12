import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { ImageGenerator, ImageFormat, type DiagnosticRun } from '../compiler/image-generator.js';
import { getShellHtml } from './preview-shell.js';
import { responseToCursorMove } from './preview-refresh.js';
import { panelExportTarget } from './export-target.js';
import { symbolAtPosition, type DocumentSymbol } from './document-symbols.js';
import { dispositionOf, type ResultDisposition } from './staleness.js';
import type {
    DiagnosticMessage,
    HostToWebview,
    RenderMessage,
    WebviewToHost
} from '../../shared/preview-protocol.js';
import type { JpipeLogger } from '../logger.js';
import { asProcessFailure, displayMessageOf, messageOf } from '../../shared/errors.js';

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

    /**
     * The document an export command should act on.
     *
     * The active editor when it holds a `.jd` file; otherwise whatever the panel last rendered,
     * so exporting still works when focus is in the preview itself — which is where it usually
     * is when someone decides they want a PNG of what they are looking at.
     */
    public async resolveExportContext(): Promise<{ doc: vscode.TextDocument | undefined; diagramName: string | undefined }> {
        const active = vscode.window.activeTextEditor?.document;
        if (active?.languageId === 'jpipe') return { doc: active, diagramName: undefined };

        const lastUri = this.getLastRenderedDocumentUri();
        if (lastUri) {
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(lastUri));
                return { doc, diagramName: this.getLastRenderedDiagramName() };
            } catch { /* the document has gone; fall through */ }
        }
        return { doc: undefined, diagramName: undefined };
    }

    /**
     * Export what the panel is showing, for the download button inside it.
     *
     * Deliberately not `resolveExportContext` above, which it resembles. That serves the palette
     * and menu commands, where the user is editing a `.jd` file and means "this one". A click in
     * the panel means "what I am looking at" — and because a webview takes no text-editor focus,
     * the active editor is often some other `.jd` file entirely. `panelExportTarget` holds the
     * rule and its reasoning.
     */
    private async exportFromPanel(format: ImageFormat): Promise<void> {
        const active = vscode.window.activeTextEditor?.document;
        const target = panelExportTarget({
            activeJpipeUri: active?.languageId === 'jpipe' ? active.uri.toString() : undefined,
            renderedUri: this.lastRenderedDocumentUri,
            renderedDiagram: this.lastRenderedDiagramName
        });

        if (target.kind === 'none') {
            vscode.window.showWarningMessage('jPipe has nothing to export yet.');
            return;
        }
        if (target.kind === 'activeEditor') {
            // No document argument: with nothing rendered, the active editor is the target, and
            // that is exactly what `generate` falls back to.
            await this.imageGenerator.generateAndSave(format);
            return;
        }

        // Already open and focused — skip the reopen rather than round-trip for the same file.
        if (active?.uri.toString() === target.uri) {
            await this.imageGenerator.generateAndSave(format, active, target.diagramName);
            return;
        }

        let document: vscode.TextDocument;
        try {
            document = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
        } catch (error: unknown) {
            // Deliberately NOT falling back to the active editor, which is what this used to do.
            // That editor may hold a different `.jd` file, so the fallback handed the user a
            // correctly-named export of the wrong model, with nothing anywhere to say so.
            this.logger.error(`Could not reopen ${target.uri} to export it: ${messageOf(error)}`);
            this.logger.revealIfLogged('error');
            vscode.window.showErrorMessage(
                'jPipe could not reopen the previewed document, so nothing was exported.');
            return;
        }
        await this.imageGenerator.generateAndSave(format, document, target.diagramName);
    }

    private getLastRenderedDocumentUri(): string | undefined {
        return this.lastRenderedDocumentUri;
    }

    private getLastRenderedDiagramName(): string | undefined {
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

        if (editor?.document.languageId !== 'jpipe') {
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
        // `ViewColumn.Beside` is a request, not an answer: `panel.viewColumn` holds the column it
        // resolved to only once the editor has laid the group out, and nothing is emitted when
        // that happens. So this waits — 100ms being long enough in practice and short enough not
        // to be seen. If the panel ever opens in the wrong group, this is the first suspect.
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
            // The diagram under the cursor is only asked for in diagram mode; the diagnostic view
            // shows no diagram, and resolving one would be work for an answer nobody reads.
            let diagramAtCursor: string | undefined;
            if (this.viewMode === 'diagram') {
                try { diagramAtCursor = this.imageGenerator.findDiagramName(doc, editor); } catch { /* no diagram at cursor */ }
            }

            switch (responseToCursorMove({
                mode: this.viewMode,
                documentUri: doc.uri.toString(),
                renderedUri: this.lastRenderedDocumentUri,
                unsaved: this.unsaved,
                diagramAtCursor,
                renderedDiagram: this.lastRenderedDiagramName
            })) {
                case 'render':    this.updatePreview(doc, editor); break;
                case 'highlight': this.updateHighlightOnly(doc, editor); break;
                case 'nothing':   break;
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
            const msg = messageOf(error);
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
            const msg = messageOf(error);
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

    /**
     * Give the page back whatever it was showing, in answer to `ready`.
     *
     * A webview reloads its content whenever it is hidden and shown again, so this runs far more
     * often than the panel is opened — and replaying costs nothing, where recompiling would cost
     * a compiler run. Sending the diagram unconditionally, as this once did, meant a reload while
     * reading the diagnostics silently switched the panel back to the diagram.
     */
    private replayCurrentView(panel: vscode.WebviewPanel): void {
        this.postConfig();
        if (this.viewMode === 'diagnostic' && this.lastDiagnostic) {
            panel.webview.postMessage(this.lastDiagnostic);
        } else if (this.lastRender) {
            panel.webview.postMessage(this.lastRender);
        } else {
            panel.webview.postMessage({ type: 'view', mode: 'empty' } satisfies HostToWebview);
        }
    }

    /**
     * Switch between the diagram and the diagnostic report.
     *
     * The document is resolved *before* `viewMode` flips, so the panel can never land in a mode
     * it has nothing to render in — which leaves the toggle looking frozen.
     */
    private async toggleViewMode(): Promise<void> {
        const resolved = await this.resolveActiveJpipeDocument();
        if (!resolved) {
            this.logger.warn('Diagnostic toggle ignored: no jPipe document available to render');
            return;
        }
        this.viewMode = this.viewMode === 'diagram' ? 'diagnostic' : 'diagram';
        await this.updatePreview(resolved.document, resolved.editor);
    }

    /**
     * Refresh whichever view the panel is showing.
     *
     * The two modes share the panel, the revision counter and nothing else — note that the
     * diagnostic path has no use for `editor`, which is the clearest sign they are two jobs. So
     * this dispatches and the halves stand alone.
     */
    private async updatePreview(document: vscode.TextDocument, editor: vscode.TextEditor | undefined): Promise<void> {
        if (!PreviewProvider.webviewPanel) return;
        if (this.viewMode === 'diagnostic') {
            await this.updateDiagnostic(document);
            return;
        }
        await this.updateDiagram(document, editor);
    }

    /** Run the compiler's diagnostic and hand the report to the page. */
    private async updateDiagnostic(document: vscode.TextDocument): Promise<void> {
        const revision = ++this.revision;
        this.post({ type: 'busy', busy: true });
        let run: DiagnosticRun;
        try {
            run = await this.imageGenerator.generateDiagnostic(document);
        } catch (error) {
            // A failure to *run* the diagnostic is itself the report: the panel shows the reason
            // rather than going blank, so this is not an early return.
            const msg = messageOf(error);
            this.logger.error(`Diagnostic failed in ${document.fileName}: ${msg}`);
            run = { raw: `Failed to run diagnostic:\n\n${msg}`, report: null, exitCode: undefined };
        }

        const disposition = dispositionOf({
            startedIn: 'diagnostic',
            currentMode: this.viewMode,
            revision,
            shownRevision: this.lastDiagnostic?.revision
        });
        if (disposition === 'superseded') {
            this.logger.debug(`Dropping stale diagnostic ${revision} (panel is showing ${this.lastDiagnostic?.revision})`);
        }
        if (disposition !== 'deliver') return;

        const message: DiagnosticMessage = {
            type: 'diagnostic',
            revision,
            raw: run.raw,
            report: run.report,
            unsaved: this.unsaved
        };
        this.lastDiagnostic = message;
        // Recorded here as well as on the diagram path: the panel has to know which file it
        // is showing a report for, or moving to another one looks like a report that has not
        // changed.
        this.lastRenderedDocumentUri = document.uri.toString();
        this.post(message);
    }

    /**
     * The staleness question the diagram path asks after each of its two awaits.
     *
     * Asked twice rather than once because there are two awaits: the compile, then the symbol
     * lookup for the highlight. The user has time to toggle or save during either.
     */
    private diagramDisposition(revision: number): ResultDisposition {
        return dispositionOf({
            startedIn: 'diagram',
            currentMode: this.viewMode,
            revision,
            shownRevision: this.lastRender?.revision
        });
    }

    /** Compile the diagram under the cursor to SVG and hand it to the page. */
    private async updateDiagram(document: vscode.TextDocument, editor: vscode.TextEditor | undefined): Promise<void> {
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
            // Checked here as well as inside sendRender, which asks again after its own await.
            // This one is the cheap short-circuit: a result already known to be unwanted should
            // not cost an LSP round trip for a highlight nobody will see.
            if (this.diagramDisposition(revision) !== 'deliver') return;
            await this.sendRender(revision, this.extractSvgFromOutput(stdout), document, editor, diagramName, null);
        } catch (error: unknown) {
            const { stdout = '', exitCode } = asProcessFailure(error);
            this.logRenderError(document.fileName, exitCode, error);
            this.logger.revealIfLogged(exitCode === 1 ? 'warn' : 'error');

            if (this.diagramDisposition(revision) !== 'deliver') return;
            const svgFromError = this.extractSvgFromOutput(stdout);
            if (svgFromError.includes('<svg')) {
                await this.sendRender(revision, svgFromError, document, editor, diagramName, { exitCode });
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

        // Asked again after the symbol lookup above, which is the second place the user has time
        // to act. The page drops out-of-order renders by revision, but the host has to as well:
        // a slow first compile landing after a fast second one would leave the panel showing the
        // newer diagram while `lastRender` and the export target regressed to the older one — so
        // a reload, or a download, would quietly act on the wrong diagram.
        //
        // The mode half of this check is new. Previously only the revision was tested here, so a
        // toggle to the diagnostic view *during* the symbol lookup let the render through and
        // pulled the user back to the diagram.
        const disposition = this.diagramDisposition(revision);
        if (disposition === 'superseded') {
            this.logger.debug(`Dropping stale render ${revision} (panel is showing ${this.lastRender?.revision})`);
        }
        if (disposition !== 'deliver') return;

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
            const msg = displayMessageOf(error);
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
        // The model goes with the name. An element id only identifies an element within its own
        // model — nearly every justification has a `c` and an `s` — so the symbol table needs
        // both to mark one row rather than one row per model.
        this.post({ type: 'highlight', name: name ?? null, model: diagramName ?? null });
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
            const found = symbolAtPosition(symbols, position.line, position.character);
            return found?.name ?? null;
        } catch {
            return null;
        }
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
                this.replayCurrentView(panel);
            }
            if (msg.type === 'download' && msg.format) {
                const fmt = (ImageFormat as Record<string, ImageFormat>)[msg.format];
                if (fmt !== undefined) void this.exportFromPanel(fmt);
            }
            if (msg.type === 'openLink' && msg.url) {
                vscode.env.openExternal(vscode.Uri.parse(msg.url));
            }
            if (msg.type === 'openSettings') {
                // The `@ext:` query is how the Settings UI filters to one extension. Taken from the
                // extension rather than written out, so it cannot drift from the manifest — and
                // nobody is going to recall the identifier, which is the point of the button.
                void vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${this.context.extension.id}`);
            }
            if (msg.type === 'revealLocation') {
                void this.revealLocation(msg.source, msg.line, msg.column);
            }
            if (msg.type === 'requestTextReport') {
                void this.sendTextReport();
            }
            if (msg.type === 'toggleMode') {
                void this.toggleViewMode();
            }
        });
        
        return panel;
    }
    
}
