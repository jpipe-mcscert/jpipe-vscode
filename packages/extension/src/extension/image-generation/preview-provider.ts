import * as vscode from 'vscode';
import { ImageGenerator } from './image-generator.js';

export class PreviewProvider {
    private static webviewPanel: vscode.WebviewPanel | undefined;
    private static webviewDisposed: boolean = true;
    
    constructor(
        private readonly imageGenerator: ImageGenerator,
        _context: vscode.ExtensionContext
    ) {}
    
    /**
     * Open or focus the preview panel
     */
    public async openPreview(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        
        if (!editor || editor.document.languageId !== 'jpipe') {
            const msg = `No active jPipe file (current: ${editor?.document.languageId || 'none'})`;
            vscode.window.showErrorMessage(msg);
            return;
        }
        
        // If webview was disposed or doesn't exist, create a new one
        if (PreviewProvider.webviewDisposed || !PreviewProvider.webviewPanel) {
            PreviewProvider.webviewPanel = this.createWebviewPanel();
            PreviewProvider.webviewDisposed = false;
        } else {
            PreviewProvider.webviewPanel.reveal(vscode.ViewColumn.Beside, true);
        }
        
        await this.updatePreview(editor.document);
    }
    
    /**
     * Update the preview with new SVG content
     */
    private async updatePreview(document: vscode.TextDocument): Promise<void> {
        if (!PreviewProvider.webviewPanel) return;
        
        try {
            PreviewProvider.webviewPanel.webview.html = this.getLoadingHtml();
            
            const svg = await this.imageGenerator.generate(false, document);
            PreviewProvider.webviewPanel.webview.html = this.getHtmlForWebview(svg);
            
        } catch (error: any) {
            PreviewProvider.webviewPanel.webview.html = this.getErrorHtml(error.message);
        }
    }
    
    /**
     * Create the webview panel
     */
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
    
    /**
     * Generate HTML to display SVG
     */
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
            scale = Math.max(scale - 0.25, 0);
            updateZoom();
        });
        
        zoomResetBtn.addEventListener('click', () => {
            scale = 1;
            updateZoom();
        });
        
        // Keyboard shortcuts
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
    
    /**
     * Generate loading HTML
     */
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
            padding: 20px;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
    </style>
</head>
<body>
    <p>Loading preview...</p>
</body>
</html>`;
    }
    
    /**
     * Generate error HTML
     */
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
