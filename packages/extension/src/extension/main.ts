import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node.js';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node.js';
import { ImageGenerator } from './image-generation/image-generator.js';
import { PreviewProvider } from './image-generation/preview-provider.js';

let client: LanguageClient;

// This function is called when the extension is activated.
export function activate(context: vscode.ExtensionContext): void {
    client = startLanguageClient(context);
    
    // Create image generator and preview provider
    const imageGenerator = new ImageGenerator();
    const previewProvider = new PreviewProvider(imageGenerator, context);
    
    // Register download SVG command
    context.subscriptions.push(
        vscode.commands.registerCommand('jpipe.downloadSVG', () => {
            imageGenerator.generateAndSave();
        })
    );
    
    // Register preview command
    context.subscriptions.push(
        vscode.commands.registerCommand('jpipe.vis.preview', () => {
            previewProvider.openPreview();
        })
    );
    
    // Register custom editor provider
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider('jpipe.vis', previewProvider)
    );
}

// This function is called when the extension is deactivated.
export function deactivate(): Thenable<void> | undefined {
    if (client) {
        return client.stop();
    }
    return undefined;
}

function startLanguageClient(context: vscode.ExtensionContext): LanguageClient {
    const serverModule = context.asAbsolutePath(path.join('out', 'language', 'main.cjs'));
    const debugOptions = { 
        execArgv: ['--nolazy', `--inspect${process.env.DEBUG_BREAK ? '-brk' : ''}=${process.env.DEBUG_SOCKET || '6009'}`] 
    };

    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'jpipe' }]
    };

    const client = new LanguageClient(
        'jpipe',
        'jpipe',
        serverOptions,
        clientOptions
    );

    client.start();
    return client;
}
