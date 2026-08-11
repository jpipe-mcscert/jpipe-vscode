import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { createJpipeServices } from 'jpipe-language';
import type { LogLevel } from 'jpipe-language';
import { SET_EXCLUDED_PATHS, SET_UNIFICATION_METHODS } from '../shared/lsp-protocol.js';

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
    const options = params.initializationOptions as {
        excludedPaths?: unknown;
        additionalUnificationMethods?: unknown;
    } | undefined;
    const paths = toStringArray(options?.excludedPaths);
    if (paths) {
        Jpipe.exclusions.setExcludedPaths(paths);
    }
    const methods = toStringArray(options?.additionalUnificationMethods);
    if (methods) {
        Jpipe.unification.setAdditionalMethods(methods);
    }
});

// Apply later changes without a restart, and re-validate everything so diagnostics are
// cleared for newly excluded files and restored for newly included ones.
connection.onNotification(SET_EXCLUDED_PATHS, async (paths: unknown) => {
    Jpipe.exclusions.setExcludedPaths(toStringArray(paths) ?? []);
    const documents = shared.workspace.LangiumDocuments.all.toArray();
    await shared.workspace.DocumentBuilder.build(documents, { validation: true });
});

// Declaring a relation the build registers should take effect at once, like exclusions do.
connection.onNotification(SET_UNIFICATION_METHODS, async (methods: unknown) => {
    Jpipe.unification.setAdditionalMethods(toStringArray(methods) ?? []);
    const documents = shared.workspace.LangiumDocuments.all.toArray();
    await shared.workspace.DocumentBuilder.build(documents, { validation: true });
});

// Start the language server with the shared services
startLanguageServer(shared);
