import * as vscode from 'vscode';
import { ImageGenerator } from './image-generator.js';

export class PreviewProvider implements vscode.CustomTextEditorProvider {
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
        console.log('[jPipe Preview] Opening preview, editor:', editor?.document.uri.fsPath);
        
        if (!editor || editor.document.languageId !== 'jpipe') {
            const msg = `No active jPipe file (current: ${editor?.document.languageId || 'none'})`;
            console.error('[jPipe Preview]', msg);
            vscode.window.showErrorMessage(msg);
            return;
        }
        
        // If webview was disposed or doesn't exist, create a new one
        if (PreviewProvider.webviewDisposed || !PreviewProvider.webviewPanel) {
            console.log('[jPipe Preview] Creating new panel');
            PreviewProvider.webviewPanel = this.createWebviewPanel();
            PreviewProvider.webviewDisposed = false;
        } else {
            console.log('[jPipe Preview] Revealing existing panel');
            PreviewProvider.webviewPanel.reveal(vscode.ViewColumn.Beside, true);
        }
        
        await this.updatePreview(editor.document);
    }
    
    /**
     * Called when a custom editor is opened
     */
    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        PreviewProvider.webviewPanel = webviewPanel;
        
        // Open text editor alongside webview
        await vscode.window.showTextDocument(document, vscode.ViewColumn.One, true);
        
        // Update preview
        await this.updatePreview(document);
        
        // Watch for document changes
        const changeSubscription = vscode.workspace.onDidChangeTextDocument(async (e) => {
            if (e.document.uri.toString() === document.uri.toString()) {
                await this.updatePreview(document);
            }
        });
        
        // Cleanup on close
        webviewPanel.onDidDispose(() => {
            changeSubscription.dispose();
            PreviewProvider.webviewPanel = undefined;
            PreviewProvider.webviewDisposed = true;
            console.log('[jPipe Preview] Webview panel disposed');
        });
    }
    
    /**
     * Update the preview with new SVG content
     */
    private async updatePreview(document: vscode.TextDocument): Promise<void> {
        if (!PreviewProvider.webviewPanel) return;
        
        try {
            console.log('[jPipe Preview] Updating preview for:', document.uri.fsPath);
            PreviewProvider.webviewPanel.webview.html = this.getLoadingHtml();
            
            const svg = await this.imageGenerator.generate(false, document);
            console.log('[jPipe Preview] SVG generated, updating webview');
            PreviewProvider.webviewPanel.webview.html = this.getHtmlForWebview(svg);
            
        } catch (error: any) {
            console.error('[jPipe Preview] Error updating preview:', error);
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
            padding: 20px;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background-color: var(--vscode-editor-background);
        }
        svg {
            max-width: 100%;
            height: auto;
        }
    </style>
</head>
<body>
    ${svg}
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
