import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { createJpipeServices, answerModelContents } from 'jpipe-language';
import type { LogLevel, ModelContentsParams } from 'jpipe-language';
import { COMPILER_INPUTS_CHANGED, COMPILER_REPORT, MODEL_CONTENTS, SET_EXCLUDED_PATHS, SET_UNIFICATION_METHODS } from '../shared/lsp-protocol.js';

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

/**
 * Validates every document again, under the workspace lock as every build is: a compiler report
 * arriving meanwhile checks its file again too, and two checks of one document at once would
 * each add their diagnostics.
 */
function checkEverythingAgain(): Promise<void> {
    const { WorkspaceLock, LangiumDocuments, DocumentBuilder } = shared.workspace;
    return WorkspaceLock.write(token => DocumentBuilder.build(LangiumDocuments.all.toArray(), { validation: true }, token));
}

// Apply later changes without a restart, and re-validate everything so diagnostics are
// cleared for newly excluded files and restored for newly included ones.
connection.onNotification(SET_EXCLUDED_PATHS, async (paths: unknown) => {
    Jpipe.exclusions.setExcludedPaths(toStringArray(paths) ?? []);
    await checkEverythingAgain();
});

// Declaring a relation the build registers should take effect at once, like exclusions do.
connection.onNotification(SET_UNIFICATION_METHODS, async (methods: unknown) => {
    Jpipe.unification.setAdditionalMethods(toStringArray(methods) ?? []);
    await checkEverythingAgain();
});

// A composed model's elements are read from the compiler's report, which the client runs it for
// (jpipe-vscode ADR-VSC-0034). When files it reads change on disk, the reports they can change are
// forgotten, and the documents that read them are checked again.
Jpipe.references.CompilerReports.connect(uri => connection.sendRequest(COMPILER_REPORT, { uri }));
connection.onNotification(COMPILER_INPUTS_CHANGED, (uris: unknown) =>
    Jpipe.references.CompilerReports.inputsChanged(new Set(toStringArray(uris) ?? [])));

// A model's elements, as the activity's Outline and the Run panel show them: whatever kind of model
// it is, through the one service every rule asks (jpipe-vscode ADR-VSC-0034).
connection.onRequest(MODEL_CONTENTS, (params: ModelContentsParams, token) => answerModelContents(Jpipe, params, token));

// Start the language server with the shared services
startLanguageServer(shared);
