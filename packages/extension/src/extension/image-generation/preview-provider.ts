import * as vscode from 'vscode';
import { ImageGenerator } from './image-generator.js';
import { DiagramStateMachine } from './diagram-state.js';

export class PreviewProvider {
    private static webviewPanel: vscode.WebviewPanel | undefined;
    private static webviewDisposed: boolean = true;
    private stateMachine: DiagramStateMachine;
    private subscriptions: vscode.Disposable[] = [];
    
    constructor(
        private readonly imageGenerator: ImageGenerator,
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
            if (e.textEditor.document.languageId === 'jpipe' && PreviewProvider.webviewPanel && !PreviewProvider.webviewDisposed) {
                if (this.stateMachine.canRender()) {
                    this.updatePreview(e.textEditor.document, e.textEditor);
                } else {
                    const msg = this.stateMachine.getMessage();
                    if (msg) {
                        vscode.window.showInformationMessage(msg);
                    }
                }
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
    
    private async updatePreview(document: vscode.TextDocument, editor: vscode.TextEditor | undefined): Promise<void> {
        if (!PreviewProvider.webviewPanel) return;
        
        try {
            PreviewProvider.webviewPanel.webview.html = this.getLoadingHtml();
            const svg = await this.imageGenerator.generate(false, document);
            PreviewProvider.webviewPanel.webview.html = this.getHtmlForWebview(svg);
        } catch (error: any) {
            const cleanError = error.message.replace(/.*\[31m/, '').replace(/\[0m.*/, '').replace(/.*Command failed.*?SVG\s+/, '');
            vscode.window.showErrorMessage(`jPipe Error: ${cleanError}`);
            PreviewProvider.webviewPanel.webview.html = this.getErrorHtml(error.message);
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
                retainContextWhenHidden: true
            }
        );
        
        panel.onDidDispose(() => {
            PreviewProvider.webviewPanel = undefined;
            PreviewProvider.webviewDisposed = true;
        });
        
        return panel;
    }
    
    private getHtmlForWebview(svg: string): string {
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
            overflow: hidden;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        #controls {
            position: fixed;
            top: 10px;
            right: 10px;
            display: flex;
            gap: 5px;
            z-index: 1000;
            background-color: var(--vscode-editor-background);
            padding: 5px;
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 12px;
            cursor: pointer;
            border-radius: 3px;
            font-size: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        button:active {
            opacity: 0.8;
        }
        #container {
            width: 100vw;
            height: 100vh;
            overflow: auto;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        #svg-wrapper {
            transform-origin: center center;
            transition: transform 0.2s ease;
        }
    </style>
</head>
<body>
    <div id="controls">
        <button id="zoom-in" title="Zoom In">+</button>
        <button id="zoom-out" title="Zoom Out">−</button>
        <button id="zoom-reset" title="Reset Zoom">100%</button>
    </div>
    <div id="container">
        <div id="svg-wrapper">
            ${svg}
        </div>
    </div>
    <script>
        let scale = 1;
        const wrapper = document.getElementById('svg-wrapper');
        const zoomInBtn = document.getElementById('zoom-in');
        const zoomOutBtn = document.getElementById('zoom-out');
        const zoomResetBtn = document.getElementById('zoom-reset');
        
        function updateZoom() {
            wrapper.style.transform = \`scale(\${scale})\`;
            zoomResetBtn.textContent = Math.round(scale * 100) + '%';
        }
        
        zoomInBtn.addEventListener('click', () => {
            scale = Math.min(scale + 0.25, 3);
            updateZoom();
        });
        
        zoomOutBtn.addEventListener('click', () => {
            scale = Math.max(scale - 0.25, 0.25);
            updateZoom();
        });
        
        zoomResetBtn.addEventListener('click', () => {
            scale = 1;
            updateZoom();
        });
        
        document.addEventListener('keydown', (e) => {
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
