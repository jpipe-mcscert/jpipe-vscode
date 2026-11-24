import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { LanguageClient, TransportKind, Trace, RevealOutputChannelOn } from 'vscode-languageclient/node';
import { ImageGenerator } from './compiler/image-generator.js';
import { PreviewProvider } from './preview/preview-provider.js';
import { ReleaseManager } from './compiler/release-manager.js';
import { installFromRelease } from './compiler/managed-install.js';
import { ExclusionManager, ExclusionDecorationProvider, ExclusionCodeLensProvider } from './exclusions.js';
import { registerCommands } from './commands.js';
import { ModelsView } from './models-view/models-view.js';
import { ElementsView } from './models-view/elements-view.js';
import { LibrariesView } from './runner/libraries-view.js';
import { RunnerEnvironment } from './runner/environment.js';
import { ResultsView } from './runner/results-view.js';
import { RunSession } from './runner/run-session.js';
import { RunPanel } from './runner/run-panel.js';
import { COMPILER_INPUTS_CHANGED, COMPILER_REPORT, SET_EXCLUDED_PATHS, SET_UNIFICATION_METHODS } from '../shared/lsp-protocol.js';
import { displayMessageOf, messageOf } from '../shared/errors.js';
import { JpipeLogger } from './logger.js';

let client: LanguageClient;

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
            logger.error(`Could not send excluded paths to the language server: ${messageOf(err)}`);
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
                logger.error(`Could not send unification methods to the language server: ${messageOf(err)}`);
            }
        })
    );

    // Create image generator and preview provider (client passed for cursor→node highlighting)
    const releaseManager = new ReleaseManager(context, logger);
    const imageGenerator = new ImageGenerator(logger, releaseManager);
    const previewProvider = new PreviewProvider(imageGenerator, client, context, logger);

    // A composed model's elements are read from the compiler (jpipe-vscode ADR-VSC-0034): the
    // server asks for a file's report, and is told when what the compiler reads may have changed.
    context.subscriptions.push(
        client.onRequest(COMPILER_REPORT, (params: { uri: string }) =>
            imageGenerator.reportFor(vscode.Uri.parse(params.uri).fsPath)),
        ...watchCompilerInputs(logger, releaseManager)
    );

    // Opportunistic, throttled "newer version available" check (managed mode only).
    void releaseManager.maybeNotifyUpdate(tag => installFromRelease({ releaseManager, logger }, tag));

    const modelsView = new ModelsView(client, exclusions, logger);
    const runnerEnvironment = new RunnerEnvironment(context, logger);
    const librariesView = new LibrariesView(logger, runnerEnvironment);
    runnerEnvironment.start();
    librariesView.start();
    const runSession = new RunSession(librariesView);
    const resultsView = new ResultsView(runSession);
    const runPanel = new RunPanel(context, logger, runSession, resultsView, modelsView, (method, params) => client.sendRequest(method, params));
    context.subscriptions.push(modelsView, runnerEnvironment, librariesView, resultsView, runSession, runPanel, new ElementsView(client, modelsView, librariesView, logger));
    // Hides the palette commands that need models to act on until this workspace is known to be
    // a jPipe one. The activity itself is always there: it is where a first model is created, and
    // opening it is one of the things that activates the extension.
    void vscode.commands.executeCommand('setContext', 'jpipe.activated', true);

    registerCommands({ context, logger, exclusions, imageGenerator, previewProvider, releaseManager, modelsView, librariesView, runnerEnvironment, resultsView, runSession, runPanel });
}

/** The settings that choose which compiler runs, and how long it may take: so what it reports. */
const COMPILER_SETTINGS = ['executionMode', 'cliPath', 'jarFile', 'javaExecutable', 'jvmArgs', 'extraPath', 'compilerTimeout']
    .map(setting => `jpipe.${setting}`);

/**
 * Tells the server which files the compiler reads may have changed on disk, a moment after they
 * do, so that a save or a checkout of many files is one notification: saved in the editor,
 * changed outside it, or every file at once when the compiler is changed or installed.
 */
function watchCompilerInputs(logger: JpipeLogger, releaseManager: ReleaseManager): vscode.Disposable[] {
    let changedFiles = new Set<string>();
    let everything = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const send = async (): Promise<void> => {
        const uris = everything ? [] : [...changedFiles];
        changedFiles = new Set();
        everything = false;
        timer = undefined;
        try {
            await client.start();
            await client.sendNotification(COMPILER_INPUTS_CHANGED, uris);
        } catch (err: unknown) {
            logger.error(`Could not tell the language server which files changed: ${messageOf(err)}`);
        }
    };
    const changed = (uri?: vscode.Uri): void => {
        if (uri) changedFiles.add(uri.toString());
        else everything = true;
        timer ??= setTimeout(() => void send(), 300);
    };

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.jd');
    return [
        watcher,
        watcher.onDidChange(changed),
        watcher.onDidCreate(changed),
        watcher.onDidDelete(changed),
        // A loaded file outside the workspace is seen by no watcher, but it may be saved here.
        vscode.workspace.onDidSaveTextDocument(document => {
            if (document.languageId === 'jpipe') changed(document.uri);
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (COMPILER_SETTINGS.some(setting => event.affectsConfiguration(setting))) changed();
        }),
        releaseManager.onDidInstall(() => changed()),
        { dispose: () => clearTimeout(timer) }
    ];
}

// This function is called when the extension is deactivated.
export function deactivate(): Thenable<void> | undefined {
    if (client) {
        return client.stop();
    }
    return undefined;
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
        const msg = displayMessageOf(error);
        logger.error(`Failed to start language server: ${msg}`);
        vscode.window.showErrorMessage(`Failed to start language server: ${msg}`);
    });

    // Bring back protocol tracing (shows requests/notifications in trace channel).
    // Note: We intentionally don't await this; the client will apply it once connected.
    void client.setTrace(Trace.Verbose);

    return client;
}
