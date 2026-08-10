import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { LanguageClient, TransportKind, Trace, RevealOutputChannelOn } from 'vscode-languageclient/node';
import { ImageGenerator, ImageFormat } from './image-generation/image-generator.js';
import { PreviewProvider } from './image-generation/preview-provider.js';
import { ReleaseManager, JpipeRelease } from './image-generation/release-manager.js';
import { ExclusionManager, ExclusionDecorationProvider, ExclusionCodeLensProvider } from './exclusions.js';
import { JpipeLogger } from './logger.js';
import {
    CONVERT_MODEL_KIND,
    EXTRACT_TEMPLATE_KIND,
    ORGANIZE_LOADS_KIND,
    SORT_ELEMENTS_KIND
} from 'jpipe-language';

let client: LanguageClient;

/** Notification understood by the language server (see packages/extension/src/language/main.ts). */
const SET_EXCLUDED_PATHS = 'jpipe/setExcludedPaths';

/** Notification understood by the language server: extra `unifyBy` relations this build knows. */
const SET_UNIFICATION_METHODS = 'jpipe/setUnificationMethods';

/** The relation names the user has declared beyond the one jPipe ships. */
function additionalUnificationMethods(): string[] {
    return vscode.workspace.getConfiguration('jpipe')
        .get<string[]>('additionalUnificationMethods', []);
}

// This function is called when the extension is activated.
export function activate(context: vscode.ExtensionContext): void {
    const logger = new JpipeLogger(context);
    logger.info('jPipe extension activated');

    const exclusions = new ExclusionManager();
    const decorations = new ExclusionDecorationProvider(exclusions);
    const exclusionLens = new ExclusionCodeLensProvider(exclusions);
    context.subscriptions.push(
        exclusions,
        decorations,
        vscode.window.registerFileDecorationProvider(decorations),
        exclusionLens,
        vscode.languages.registerCodeLensProvider({ language: 'jpipe' }, exclusionLens)
    );
    // The Explorer has usually painted by the time this extension is activated, so the tree it is
    // showing was built without asking this provider anything. Nudge it to ask now.
    decorations.refresh();

    client = startLanguageClient(context, logger, exclusions);

    /** Keep the menu `when` clauses in step with the setting. */
    function publishExcludedPaths(): void {
        void vscode.commands.executeCommand('setContext', 'jpipe.excludedResourcePaths', exclusions.getExcludedResourcePaths());
    }
    publishExcludedPaths();

    /**
     * Send the current exclusions to the server, which re-validates and clears/restores
     * diagnostics without a restart.
     *
     * `start()` resolves immediately once the client is running and otherwise returns the
     * in-flight start promise, so a change made while the server is still coming up is applied
     * rather than dropped. The list is read *after* awaiting, so a burst of changes collapses
     * to the latest value instead of replaying stale ones.
     */
    async function pushExclusionsToServer(): Promise<void> {
        try {
            await client.start();
            const paths = exclusions.getResolvedUris();
            logger.debug(`Excluded paths: ${paths.length === 0 ? '(none)' : paths.join(', ')}`);
            await client.sendNotification(SET_EXCLUDED_PATHS, paths);
        } catch (err: unknown) {
            // A failed start is already surfaced by startLanguageClient; don't double-report.
            logger.error(`Could not send excluded paths to the language server: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    context.subscriptions.push(
        exclusions.onDidChange(() => {
            publishExcludedPaths();
            void pushExclusionsToServer();
        }),
        // Declaring a relation your build registers should silence the warning at once, without
        // a reload — the same contract the exclusion setting has.
        vscode.workspace.onDidChangeConfiguration(async event => {
            if (!event.affectsConfiguration('jpipe.additionalUnificationMethods')) return;
            try {
                await client.start();
                await client.sendNotification(SET_UNIFICATION_METHODS, additionalUnificationMethods());
            } catch (err: unknown) {
                logger.error(`Could not send unification methods to the language server: ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    // Create image generator and preview provider (client passed for cursor→node highlighting)
    const releaseManager = new ReleaseManager(context, logger);
    const imageGenerator = new ImageGenerator(logger, releaseManager);
    const previewProvider = new PreviewProvider(imageGenerator, client, context, logger);

    /**
     * Interactive flow: pick a release from GitHub, download its jar into hidden global
     * storage, record it, and switch the extension into `managed` execution mode.
     * `preselectTag` (from the update prompt) auto-selects that release when present.
     */
    async function installFromRelease(preselectTag?: string): Promise<void> {
        let releases: JpipeRelease[];
        try {
            releases = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'jPipe: fetching available releases…' },
                () => releaseManager.listReleases()
            );
        } catch (err: unknown) {
            vscode.window.showErrorMessage(`jPipe: could not list releases. ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        if (releases.length === 0) {
            vscode.window.showWarningMessage('jPipe: no compatible releases (v2.0.0+) were found.');
            return;
        }

        const installed = releaseManager.getInstalled();
        let chosen = preselectTag ? releases.find(r => r.tag === preselectTag) : undefined;
        if (!chosen) {
            const picked = await vscode.window.showQuickPick(
                releases.map((r, i) => ({
                    label: r.tag,
                    description: [
                        formatReleaseDate(r.publishedAt),
                        i === 0 ? '$(star-full) latest' : '',
                        r.tag === installed?.tag ? '$(check) installed' : '',
                    ].filter(Boolean).join('  ·  '),
                    detail: r.name,
                    release: r,
                })),
                { title: 'Select a jPipe compiler release to install', placeHolder: 'Downloaded and run internally — no manual path needed' }
            );
            if (!picked) return;
            chosen = picked.release;
        }

        try {
            const jarPath = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `jPipe: downloading ${chosen.tag}…`, cancellable: false },
                (progress) => {
                    let last = 0;
                    return releaseManager.download(chosen!, (fraction) => {
                        const pct = Math.round(fraction * 100);
                        progress.report({ increment: pct - last, message: `${pct}%` });
                        last = pct;
                    });
                }
            );
            await releaseManager.setInstalled(chosen.tag, jarPath);
            await vscode.workspace.getConfiguration('jpipe').update('executionMode', 'managed', vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`jPipe ${chosen.tag} installed and activated (managed mode).`);
            logger.info(`Managed jPipe compiler set to ${chosen.tag} at ${jarPath}`);
        } catch (err: unknown) {
            vscode.window.showErrorMessage(`jPipe: download failed. ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // Opportunistic, throttled "newer version available" check (managed mode only).
    void releaseManager.maybeNotifyUpdate(installFromRelease);

    /**
     * The resource a context-menu command acts on. The Explorer always passes it explicitly;
     * from the editor menu we fall back to the open `.jd` document.
     */
    function resolveExclusionTarget(uri?: vscode.Uri): vscode.Uri | undefined {
        if (uri) return uri;
        const active = vscode.window.activeTextEditor?.document;
        return active?.languageId === 'jpipe' ? active.uri : undefined;
    }

    /** Exclude a folder or `.jd` file from validation, reporting the two ways this can fail. */
    async function excludeResource(uri?: vscode.Uri): Promise<void> {
        const target = resolveExclusionTarget(uri);
        if (!target) return;
        const label = vscode.workspace.asRelativePath(target, false);
        if (!await exclusions.addPath(target)) {
            vscode.window.showWarningMessage('The selection must be inside the workspace.');
            return;
        }
        // A bare relative entry can only be resolved against a single root; in a multi-root
        // workspace the entry is stored as `rootName:path`, which needs that root to be present.
        if (!exclusions.isExcludedRoot(target)) {
            vscode.window.showWarningMessage(`jPipe could not resolve ${label} against a workspace folder.`);
            return;
        }
        vscode.window.showInformationMessage(`jPipe no longer validates ${label}.`);
    }

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
            await excludeResource(uris[0]);
        }),
        vscode.commands.registerCommand('jpipe.excludeResource', (uri?: vscode.Uri) => excludeResource(uri)),
        // Source Action… is where this belongs and where it now appears; the command is the
        // palette shortcut to it, the way other languages offer one for organizing imports.
        vscode.commands.registerCommand('jpipe.organizeLoads', async () => {
            await vscode.commands.executeCommand('editor.action.sourceAction', {
                kind: ORGANIZE_LOADS_KIND,
                apply: 'first'
            });
        }),
        // The refactorings are already in the lightbulb and under Refactor…, but both ask you to
        // know they are there. A named command is the one route that answers "what can jPipe do
        // here?" without a shortcut, so each gets one.
        ...[
            ['jpipe.convertModelKind', CONVERT_MODEL_KIND],
            ['jpipe.sortElements', SORT_ELEMENTS_KIND],
            ['jpipe.extractTemplate', EXTRACT_TEMPLATE_KIND]
        ].map(([command, kind]) =>
            vscode.commands.registerCommand(command, async () => {
                await vscode.commands.executeCommand('editor.action.refactor', { kind, apply: 'first' });
            })),
        vscode.commands.registerCommand('jpipe.includeResource', async (uri?: vscode.Uri) => {
            const target = resolveExclusionTarget(uri);
            if (!target) return;
            if (await exclusions.removeResolved(target)) {
                vscode.window.showInformationMessage(`jPipe now validates ${vscode.workspace.asRelativePath(target, false)}.`);
            }
        }),
        vscode.commands.registerCommand('jpipe.removeExcludedPath', async () => {
            const entries = exclusions.getEntries();
            if (entries.length === 0) {
                vscode.window.showInformationMessage('jPipe: nothing is excluded from validation.');
                return;
            }
            const picked = await vscode.window.showQuickPick(entries, {
                title: 'Remove a path from the jPipe validation exclusions',
                placeHolder: 'Its .jd files will be validated again'
            });
            if (picked) await exclusions.removeEntry(picked);
        }),
        vscode.commands.registerCommand('jpipe.checkInstallation', async () => {
            const { ok, message } = await imageGenerator.check();
            const mode = vscode.workspace.getConfiguration('jpipe').get<string>('executionMode', 'cli');
            const installed = releaseManager.getInstalled();
            let header: string;
            if (mode === 'managed') {
                header = `Access method: managed (GitHub Release${installed ? ` ${installed.tag}` : ' — none installed'})`;
            } else if (mode === 'jar') {
                header = 'Access method: jar';
            } else {
                header = 'Access method: cli';
            }
            const detail = `${header}\n\n${message}`;
            if (ok) {
                vscode.window.showInformationMessage('jPipe is accessible.', { modal: true, detail });
            } else {
                vscode.window.showErrorMessage('Cannot access jPipe.', { modal: true, detail });
            }
        }),
        vscode.commands.registerCommand('jpipe.installFromRelease', () => installFromRelease()),
        vscode.commands.registerCommand('jpipe.export', async () => {
            const configured = vscode.workspace.getConfiguration('jpipe').get<string>('defaultExportFormat', 'SVG');
            const format = (ImageFormat as Record<string, ImageFormat>)[configured] ?? ImageFormat.SVG;
            const { doc, diagramName } = await resolveExportContext();
            imageGenerator.generateAndSave(format, doc, diagramName);
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

/** Format a release's ISO `published_at` as a short local date (e.g. "Jul 16, 2026"). */
function formatReleaseDate(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function startLanguageClient(context: vscode.ExtensionContext, logger: JpipeLogger, exclusions: ExclusionManager): LanguageClient {
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

    // `{ log: true }` yields a LogOutputChannel, which is what the client requires as of v10.
    const outputChannel = vscode.window.createOutputChannel('jPipe Language Server', { log: true });
    const traceOutputChannel = vscode.window.createOutputChannel('jPipe Language Server (Trace)', { log: true });
    context.subscriptions.push(outputChannel, traceOutputChannel);

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'jpipe' }],
        outputChannel,
        traceOutputChannel,
        revealOutputChannelOn: RevealOutputChannelOn.Info,
        // Sent with `initialize` so excluded files are never validated, not even once at startup.
        // A function, not a literal: it is re-evaluated on every initialize, so a server restart
        // picks up the current exclusions instead of replaying the ones from activation time.
        initializationOptions: () => ({
            excludedPaths: exclusions.getResolvedUris(),
            additionalUnificationMethods: additionalUnificationMethods()
        })
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
