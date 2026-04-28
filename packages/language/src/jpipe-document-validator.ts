import { DefaultDocumentValidator, URI, UriUtils } from 'langium';
import type { LangiumDocument, LangiumCoreServices, ValidationOptions } from 'langium';
import type { CancellationToken } from 'vscode-languageserver-protocol';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver-types';
import type { JpipeServerLogger } from './jpipe-logger.js';

export class JpipeDocumentValidator extends DefaultDocumentValidator {
    private readonly excludedUris: URI[];
    private readonly logger: JpipeServerLogger;

    constructor(services: LangiumCoreServices, excludedPaths: string[], logger: JpipeServerLogger) {
        super(services);
        this.excludedUris = excludedPaths.flatMap(p => {
            try { return [URI.parse(p)]; } catch { logger.warn(`Ignoring invalid excluded-directory URI: ${p}`); return []; }
        });
        this.logger = logger;
    }

    override async validateDocument(
        document: LangiumDocument,
        options?: ValidationOptions,
        cancelToken?: CancellationToken
    ): Promise<Diagnostic[]> {
        if (this.excludedUris.some(dir => UriUtils.contains(dir, document.uri))) {
            this.logger.debug(`Skipping validation (excluded): ${document.uri.toString()}`);
            return [{
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                severity: DiagnosticSeverity.Warning,
                message: 'This file is in an excluded directory and is not validated by jPipe.',
                source: 'jpipe'
            }];
        }
        return super.validateDocument(document, options, cancelToken);
    }
}
