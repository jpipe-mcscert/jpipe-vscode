import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node.js';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { LanguageClient, TransportKind, Trace, RevealOutputChannelOn } from 'vscode-languageclient/node.js';
import { ImageGenerator, ImageFormat } from './image-generation/image-generator.js';
import { PreviewProvider } from './image-generation/preview-provider.js';

let client: LanguageClient;

// This function is called when the extension is activated.
export function activate(context: vscode.ExtensionContext): void {
    client = startLanguageClient(context);
    
    // Create image generator and preview provider (client passed for cursor→node highlighting)
    const imageGenerator = new ImageGenerator();
    const previewProvider = new PreviewProvider(imageGenerator, client, context);
    
    // Register download commands for all supported formats
    context.subscriptions.push(
        vscode.commands.registerCommand('jpipe.downloadPNG',    () => imageGenerator.generateAndSave(ImageFormat.PNG)),
        vscode.commands.registerCommand('jpipe.downloadSVG',    () => imageGenerator.generateAndSave(ImageFormat.SVG)),
        vscode.commands.registerCommand('jpipe.downloadJSON',   () => imageGenerator.generateAndSave(ImageFormat.JSON)),
        vscode.commands.registerCommand('jpipe.downloadJPEG',   () => imageGenerator.generateAndSave(ImageFormat.JPEG)),
        vscode.commands.registerCommand('jpipe.downloadDOT',    () => imageGenerator.generateAndSave(ImageFormat.DOT)),
        vscode.commands.registerCommand('jpipe.downloadPython', () => imageGenerator.generateAndSave(ImageFormat.PYTHON)),
        vscode.commands.registerCommand('jpipe.downloadJPIPE',  () => imageGenerator.generateAndSave(ImageFormat.JPIPE))
    );
    
    // Register preview command
    context.subscriptions.push(
        vscode.commands.registerCommand('jpipe.vis.preview', () => {
            previewProvider.openPreview();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jpipe.checkInstallation', async () => {
            const { ok, message } = await imageGenerator.check();
            if (ok) {
                vscode.window.showInformationMessage('jPipe is accessible.', { modal: true, detail: message });
            } else {
                vscode.window.showErrorMessage('Cannot access jPipe.', { modal: true, detail: message });
            }
        })
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

    const outputChannel = vscode.window.createOutputChannel('jPipe Language Server');
    const traceOutputChannel = vscode.window.createOutputChannel('jPipe Language Server (Trace)');

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'jpipe' }],
        outputChannel,
        traceOutputChannel,
        revealOutputChannelOn: RevealOutputChannelOn.Info
    };

    const client = new LanguageClient(
        'jpipe',
        'jpipe',
        serverOptions,
        clientOptions
    );

    client.start().catch((error: unknown) => {
        vscode.window.showErrorMessage(`Failed to start language server: ${error}`);
    });

    // Bring back protocol tracing (shows requests/notifications in trace channel).
    // Note: We intentionally don't await this; the client will apply it once connected.
    void client.setTrace(Trace.Verbose);
    
    return client;
}
