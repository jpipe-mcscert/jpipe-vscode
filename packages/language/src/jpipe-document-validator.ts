import { DefaultDocumentValidator } from 'langium';
import type { LangiumDocument, LangiumCoreServices, ValidationOptions } from 'langium';
import type { CancellationToken } from 'vscode-languageserver-protocol';
import type { Diagnostic } from 'vscode-languageserver-types';
import type { JpipeServerLogger } from './jpipe-logger.js';
import type { JpipeExclusionService } from './jpipe-exclusions.js';

export class JpipeDocumentValidator extends DefaultDocumentValidator {
    private readonly exclusions: JpipeExclusionService;
    private readonly logger: JpipeServerLogger;

    constructor(services: LangiumCoreServices, exclusions: JpipeExclusionService, logger: JpipeServerLogger) {
        super(services);
        this.exclusions = exclusions;
        this.logger = logger;
    }

    override async validateDocument(
        document: LangiumDocument,
        options?: ValidationOptions,
        cancelToken?: CancellationToken
    ): Promise<Diagnostic[]> {
        if (this.exclusions.isExcluded(document.uri)) {
            this.logger.debug(`Skipping validation (excluded): ${document.uri.toString()}`);
            // An empty array (rather than `undefined`) is what clears diagnostics already
            // published for this document: Langium only sends `publishDiagnostics` when
            // `document.diagnostics` is set.
            return [];
        }
        return super.validateDocument(document, options, cancelToken);
    }
}
