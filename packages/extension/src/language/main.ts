import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node.js';
import { createJpipeServices } from 'jpipe-language';
import type { LogLevel } from 'jpipe-language';

// Create a connection to the client
const connection = createConnection(ProposedFeatures.all);

const logLevel = (process.env.JPIPE_LOG_LEVEL ?? 'info') as LogLevel;

// Inject the shared services and language-specific services
const { shared } = createJpipeServices({ connection, ...NodeFileSystem }, logLevel);

// Start the language server with the shared services
startLanguageServer(shared);
