import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node.js';
import { createJpipeServices } from 'jpipe-language';
import type { LogLevel } from 'jpipe-language';

/** Notification sent by the extension when `jpipe.excludedPaths` changes. */
const SET_EXCLUDED_PATHS = 'jpipe/setExcludedPaths';

// Create a connection to the client
const connection = createConnection(ProposedFeatures.all);

const logLevel = (process.env.JPIPE_LOG_LEVEL ?? 'info') as LogLevel;

// Inject the shared services and language-specific services
const { shared, Jpipe } = createJpipeServices({ connection, ...NodeFileSystem }, logLevel);

function toStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.filter((v): v is string => typeof v === 'string');
}

// Apply the initial exclusions during `initialize`, i.e. before the workspace is built in
// `initialized` — otherwise excluded files would briefly light up with errors.
shared.lsp.LanguageServer.onInitialize(params => {
    const options = params.initializationOptions as { excludedPaths?: unknown } | undefined;
    const paths = toStringArray(options?.excludedPaths);
    if (paths) {
        Jpipe.exclusions.setExcludedPaths(paths);
    }
});

// Apply later changes without a restart, and re-validate everything so diagnostics are
// cleared for newly excluded files and restored for newly included ones.
connection.onNotification(SET_EXCLUDED_PATHS, async (paths: unknown) => {
    Jpipe.exclusions.setExcludedPaths(toStringArray(paths) ?? []);
    const documents = shared.workspace.LangiumDocuments.all.toArray();
    await shared.workspace.DocumentBuilder.build(documents, { validation: true });
});

// Start the language server with the shared services
startLanguageServer(shared);
