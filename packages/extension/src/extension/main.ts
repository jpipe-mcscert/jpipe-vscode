import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node.js';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { LanguageClient, TransportKind, Trace, RevealOutputChannelOn } from 'vscode-languageclient/node.js';
import { ImageGenerator, ImageFormat } from './image-generation/image-generator.js';
import { PreviewProvider } from './image-generation/preview-provider.js';
import { JpipeLogger } from './logger.js';

let client: LanguageClient;

// This function is called when the extension is activated.
export function activate(context: vscode.ExtensionContext): void {
    const logger = new JpipeLogger(context);
    logger.info('jPipe extension activated');

    client = startLanguageClient(context, logger);

    // Create image generator and preview provider (client passed for cursor→node highlighting)
    const imageGenerator = new ImageGenerator(logger);
    const previewProvider = new PreviewProvider(imageGenerator, client, context, logger);

    context.subscriptions.push(
        vscode.commands.registerCommand('jpipe.downloadPNG',    () => imageGenerator.generateAndSave(ImageFormat.PNG)),
        vscode.commands.registerCommand('jpipe.downloadSVG',    () => imageGenerator.generateAndSave(ImageFormat.SVG)),
        vscode.commands.registerCommand('jpipe.downloadJSON',   () => imageGenerator.generateAndSave(ImageFormat.JSON)),
        vscode.commands.registerCommand('jpipe.downloadJPEG',   () => imageGenerator.generateAndSave(ImageFormat.JPEG)),
        vscode.commands.registerCommand('jpipe.downloadDOT',    () => imageGenerator.generateAndSave(ImageFormat.DOT)),
        vscode.commands.registerCommand('jpipe.downloadPython', () => imageGenerator.generateAndSave(ImageFormat.PYTHON)),
        vscode.commands.registerCommand('jpipe.downloadJPIPE',  () => imageGenerator.generateAndSave(ImageFormat.JPIPE)),
        vscode.commands.registerCommand('jpipe.vis.preview', () => previewProvider.openPreview()),
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

function startLanguageClient(context: vscode.ExtensionContext, logger: JpipeLogger): LanguageClient {
    const serverModule = context.asAbsolutePath(path.join('out', 'language', 'main.cjs'));
    const debugOptions = {
        execArgv: ['--nolazy', `--inspect${process.env.DEBUG_BREAK ? '-brk' : ''}=${process.env.DEBUG_SOCKET || '6009'}`]
    };

    const logLevel = vscode.workspace.getConfiguration('jpipe').get<string>('logLevel', 'info');
    const serverEnv = { ...process.env, JPIPE_LOG_LEVEL: logLevel };

    const serverOptions: ServerOptions = {
        run:   { module: serverModule, transport: TransportKind.ipc, options: { env: serverEnv } },
        debug: { module: serverModule, transport: TransportKind.ipc, options: { ...debugOptions, env: serverEnv } }
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

    client.start().then(() => {
        logger.info(`Language server started (log level: ${logLevel})`);
    }).catch((error: unknown) => {
        let msg: string;
        if (error instanceof Error) { msg = error.message; }
        else if (typeof error === 'string') { msg = error; }
        else { msg = '[unknown error]'; }
        logger.error(`Failed to start language server: ${msg}`);
        vscode.window.showErrorMessage(`Failed to start language server: ${msg}`);
    });

    // Bring back protocol tracing (shows requests/notifications in trace channel).
    // Note: We intentionally don't await this; the client will apply it once connected.
    void client.setTrace(Trace.Verbose);

    return client;
}
