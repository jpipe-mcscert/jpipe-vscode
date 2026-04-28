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

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('jpipe.excludedDirectories')) {
                vscode.window.showInformationMessage(
                    'jPipe: "Excluded Directories" changed. Reload the window to apply.',
                    'Reload Window'
                ).then(sel => {
                    if (sel === 'Reload Window') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
            }
        })
    );

    // Create image generator and preview provider (client passed for cursor→node highlighting)
    const imageGenerator = new ImageGenerator(logger);
    const previewProvider = new PreviewProvider(imageGenerator, client, context, logger);

    async function resolveExportContext(): Promise<{ doc: vscode.TextDocument | undefined; diagramName: string | undefined }> {
        const active = vscode.window.activeTextEditor?.document;
        if (active?.languageId === 'jpipe') return { doc: active, diagramName: undefined };
        const lastUri = previewProvider.getLastRenderedDocumentUri();
        const lastDiagramName = previewProvider.getLastRenderedDiagramName();
        if (lastUri) {
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(lastUri));
                return { doc, diagramName: lastDiagramName };
            } catch { /* fall through */ }
        }
        return { doc: undefined, diagramName: undefined };
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('jpipe.downloadPNG',    async () => { const { doc, diagramName } = await resolveExportContext(); imageGenerator.generateAndSave(ImageFormat.PNG,    doc, diagramName); }),
        vscode.commands.registerCommand('jpipe.downloadSVG',    async () => { const { doc, diagramName } = await resolveExportContext(); imageGenerator.generateAndSave(ImageFormat.SVG,    doc, diagramName); }),
        vscode.commands.registerCommand('jpipe.downloadJSON',   async () => { const { doc, diagramName } = await resolveExportContext(); imageGenerator.generateAndSave(ImageFormat.JSON,   doc, diagramName); }),
        vscode.commands.registerCommand('jpipe.downloadJPEG',   async () => { const { doc, diagramName } = await resolveExportContext(); imageGenerator.generateAndSave(ImageFormat.JPEG,   doc, diagramName); }),
        vscode.commands.registerCommand('jpipe.downloadDOT',    async () => { const { doc, diagramName } = await resolveExportContext(); imageGenerator.generateAndSave(ImageFormat.DOT,    doc, diagramName); }),
        vscode.commands.registerCommand('jpipe.downloadPython', async () => { const { doc, diagramName } = await resolveExportContext(); imageGenerator.generateAndSave(ImageFormat.PYTHON, doc, diagramName); }),
        vscode.commands.registerCommand('jpipe.downloadJPIPE',  async () => { const { doc, diagramName } = await resolveExportContext(); imageGenerator.generateAndSave(ImageFormat.JPIPE,  doc, diagramName); }),
        vscode.commands.registerCommand('jpipe.vis.preview', () => previewProvider.openPreview()),
        vscode.commands.registerCommand('jpipe.addExcludedDirectory', async () => {
            const uris = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: 'Exclude from Validation'
            });
            if (!uris || uris.length === 0) return;
            const selectedUri = uris[0];
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(selectedUri);
            if (!workspaceFolder) {
                vscode.window.showWarningMessage('The selected directory must be inside the workspace.');
                return;
            }
            const roots = vscode.workspace.workspaceFolders ?? [];
            const relPart = vscode.workspace.asRelativePath(selectedUri, false).replaceAll('\\', '/');
            const entry = roots.length > 1 ? `${workspaceFolder.name}:${relPart}` : relPart;
            const config = vscode.workspace.getConfiguration('jpipe');
            const current = config.get<string[]>('excludedDirectories', []);
            if (!current.includes(entry)) {
                await config.update('excludedDirectories', [...current, entry], vscode.ConfigurationTarget.Workspace);
            }
        }),
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

function resolveExcludedDirectories(): string[] {
    const raw = vscode.workspace.getConfiguration('jpipe').get<string[]>('excludedDirectories', []);
    const roots = vscode.workspace.workspaceFolders ?? [];
    const rootsByName = new Map(roots.map(f => [f.name, f]));
    const resolved: string[] = [];
    for (const entry of raw) {
        if (!entry) continue;
        const colon = entry.indexOf(':');
        if (colon > 0) {
            const folderName = entry.slice(0, colon);
            const rel = entry.slice(colon + 1);
            const folder = rootsByName.get(folderName);
            if (folder && rel) resolved.push(vscode.Uri.joinPath(folder.uri, rel).toString());
        } else if (roots.length === 1) {
            resolved.push(vscode.Uri.joinPath(roots[0].uri, entry).toString());
        }
    }
    return resolved;
}

function startLanguageClient(context: vscode.ExtensionContext, logger: JpipeLogger): LanguageClient {
    const serverModule = context.asAbsolutePath(path.join('out', 'language', 'main.cjs'));
    const debugOptions = {
        execArgv: ['--nolazy', `--inspect${process.env.DEBUG_BREAK ? '-brk' : ''}=${process.env.DEBUG_SOCKET || '6009'}`]
    };

    const logLevel = vscode.workspace.getConfiguration('jpipe').get<string>('logLevel', 'info');
    const excludedDirs = resolveExcludedDirectories();
    const serverEnv = { ...process.env, JPIPE_LOG_LEVEL: logLevel, JPIPE_EXCLUDED_DIRS: JSON.stringify(excludedDirs) };

    const serverOptions: ServerOptions = {
        run:   { module: serverModule, transport: TransportKind.ipc, options: { env: serverEnv } },
        debug: { module: serverModule, transport: TransportKind.ipc, options: { ...debugOptions, env: serverEnv } }
    };

    const outputChannel = vscode.window.createOutputChannel('jPipe Language Server');
    const traceOutputChannel = vscode.window.createOutputChannel('jPipe Language Server (Trace)');
    context.subscriptions.push(outputChannel, traceOutputChannel);

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
