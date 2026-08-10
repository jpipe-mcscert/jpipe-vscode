import { DefaultDocumentValidator } from 'langium';
import type { LangiumDocument, LangiumCoreServices, ValidationOptions } from 'langium';
import type { CancellationToken } from 'vscode-languageserver-protocol';
import type { Diagnostic } from 'vscode-languageserver-types';
import type { JpipeServerLogger } from './jpipe-logger.js';
import type { JpipeExclusionService } from './jpipe-exclusions.js';
import { describedRule } from './jpipe-parser-errors.js';

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

    /**
     * Marks an unfinished declaration at the end of the last token that was right, rather than on
     * the token the parser choked on.
     *
     * The two are rarely the same. `evidence` alone on a line parses on into the *next* line
     * before failing, because the word beginning that line is a perfectly good name for it — so
     * the parser's own position blames a line the author had already finished. Reporting where
     * the missing token belongs is both truer and the convention every other language server
     * follows.
     */
    protected override processParsingErrors(
        parseResult: Parameters<DefaultDocumentValidator['processParsingErrors']>[0],
        diagnostics: Diagnostic[],
        options: Parameters<DefaultDocumentValidator['processParsingErrors']>[2]
    ): void {
        const before = diagnostics.length;
        super.processParsingErrors(parseResult, diagnostics, options);

        parseResult.parserErrors.forEach((error, index) => {
            const diagnostic = diagnostics[before + index];
            const previous = (error as { previousToken?: RecoveryToken }).previousToken;
            if (!diagnostic || !previous || !describedRule(error as { context?: { ruleStack?: string[] } })) return;
            if (previous.endLine === undefined || previous.endColumn === undefined) return;

            // Chevrotain columns are 1-based and inclusive of the last character; LSP wants a
            // 0-based position just past it, which is the same number.
            const at = { line: previous.endLine - 1, character: previous.endColumn };
            diagnostic.range = { start: at, end: at };
        });
    }
}

/** The fields of a Chevrotain token this needs; the rest are irrelevant here. */
interface RecoveryToken {
    endLine?: number;
    endColumn?: number;
}
