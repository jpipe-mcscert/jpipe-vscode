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
import { SET_EXCLUDED_PATHS, SET_UNIFICATION_METHODS } from '../shared/lsp-protocol.js';
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

    // Opportunistic, throttled "newer version available" check (managed mode only).
    void releaseManager.maybeNotifyUpdate(tag => installFromRelease({ releaseManager, logger }, tag));

    registerCommands({ context, logger, exclusions, imageGenerator, previewProvider, releaseManager });
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
