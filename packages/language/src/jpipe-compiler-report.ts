/**
 * What the compiler says about a file, as the language server reads it (jpipe-vscode
 * ADR-VSC-0034).
 *
 * The report is the one `jpipe diagnostic -f json` writes, schema version 1, which the preview's
 * diagnostics view reads too (`diagnostic-report-v1.schema.json` in the compiler is the contract).
 * Only what compiled contents need is read here: each model's elements under the ids the compiler
 * gives them in that file, their kinds and declarations, its aliases, and the diagnostics, which
 * say which models were built whole.
 *
 * The language server never runs the compiler. It asks its client, which knows which compiler to
 * run and whether it is recent enough (jpipe-vscode ADR-VSC-0016, ADR-VSC-0032), and the answer is
 * the report of the file **as last saved**: the compiler reads files from disk.
 */
import { URI, type LangiumDocument } from 'langium';
import type { Unit } from './generated/ast.js';
import type { JpipeServices } from './jpipe-module.js';
import type { JpipeServerLogger } from './jpipe-logger.js';
import type { JpipeImportService } from './jpipe-import.js';
import type { ElementKind } from './jpipe-utils.js';
import { messageOf } from './jpipe-errors.js';

/** A position in a source file: `line` 1-based, `column` 0-based, `source` the report's own file when absent. */
export interface ReportLocation {
    readonly source?: string;
    readonly line: number;
    readonly column: number;
}

/** An element of a built model. A synthesized one, made up by an operator, has no location. */
export interface ReportSymbol {
    readonly id: string;
    readonly kind: ElementKind;
    readonly synthesized: boolean;
    readonly location?: ReportLocation;
}

/** A model as the compiler built it. */
export interface ReportModel {
    readonly name: string;
    readonly symbols: readonly ReportSymbol[];
    /** Ids an operator merged into another: `from` now names `to`. */
    readonly aliases: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

/** A problem the compiler found, where it found it when it says. */
export interface ReportDiagnostic {
    readonly severity: string;
    readonly code?: string;
    readonly source: string;
    readonly line?: number;
}

export interface CompilerReport {
    /** The compiled file, as the compiler was given it. */
    readonly source: string;
    readonly diagnostics: readonly ReportDiagnostic[];
    readonly models: readonly ReportModel[];
}

const KINDS: ReadonlySet<string> = new Set<ElementKind>(['conclusion', 'sub-conclusion', 'strategy', 'evidence', 'abstract-support']);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';

function readLocation(value: unknown): ReportLocation | undefined {
    if (!isObject(value) || !isNumber(value.line) || !isNumber(value.column)) return undefined;
    if (value.source !== undefined && !isString(value.source)) return undefined;
    return { source: value.source, line: value.line, column: value.column };
}

function readSymbol(value: unknown): ReportSymbol | undefined {
    if (!isObject(value) || !isString(value.id) || !isString(value.kind) || !KINDS.has(value.kind)) return undefined;
    const location = value.location === undefined ? undefined : readLocation(value.location);
    if (value.location !== undefined && !location) return undefined;
    return { id: value.id, kind: value.kind as ElementKind, synthesized: value.synthesized === true, location };
}

function readModel(value: unknown): ReportModel | undefined {
    if (!isObject(value) || !isString(value.name) || !Array.isArray(value.symbols) || !Array.isArray(value.aliases)) return undefined;
    const symbols = value.symbols.map(readSymbol);
    if (symbols.some(symbol => symbol === undefined)) return undefined;
    const aliases = value.aliases.filter((alias): alias is { from: string; to: string } =>
        isObject(alias) && isString(alias.from) && isString(alias.to));
    if (aliases.length !== value.aliases.length) return undefined;
    return { name: value.name, symbols: symbols as ReportSymbol[], aliases };
}

function readDiagnostic(value: unknown): ReportDiagnostic | undefined {
    if (!isObject(value) || !isString(value.severity) || !isString(value.source)) return undefined;
    if (value.code !== undefined && !isString(value.code)) return undefined;
    if (value.line !== undefined && !isNumber(value.line)) return undefined;
    return { severity: value.severity, code: value.code, source: value.source, line: value.line };
}

/**
 * The report `value` is, or `undefined` if it is not one of version 1. Read whole or not at all:
 * a report missing part of a model would read as a model missing elements, which rules then
 * report.
 */
export function readReport(value: unknown): CompilerReport | undefined {
    if (!isObject(value) || value.schemaVersion !== 1 || !isString(value.source)) return undefined;
    if (!Array.isArray(value.models) || !Array.isArray(value.diagnostics)) return undefined;
    const models = value.models.map(readModel);
    const diagnostics = value.diagnostics.map(readDiagnostic);
    if (models.some(model => model === undefined) || diagnostics.some(diagnostic => diagnostic === undefined)) return undefined;
    return { source: value.source, models: models as ReportModel[], diagnostics: diagnostics as ReportDiagnostic[] };
}

/**
 * How the server asks its client for a file's report: the file's URI string in, the report or
 * `null` out. `null` covers every reason there is none — no compiler, one too old, a run that
 * failed or timed out — which the server does not need to tell apart.
 */
export type ReportRequest = (uri: string) => Promise<unknown>;

/**
 * The compiler's reports, one per file asked about, kept until a save can change them.
 *
 * A report is asked for only when a model builds on a composition, and only once until a file it
 * depends on is saved: nothing is sent on a keystroke. Asking for a report already on its way
 * waits for that one.
 */
export class CompilerReports {
    private request: ReportRequest | undefined;
    private readonly reports = new Map<string, Promise<CompilerReport | undefined>>();
    private readonly logger: JpipeServerLogger;
    private readonly services: JpipeServices;

    constructor(services: JpipeServices) {
        this.services = services;
        this.logger = services.logger;
    }

    private get importService(): JpipeImportService {
        return this.services.references.JpipeImportService;
    }

    /** Asks `request` from now on. Until it is set, as in tests and outside an editor, there is no report. */
    connect(request: ReportRequest | undefined): void {
        this.request = request;
        this.reports.clear();
    }

    /** The report of `document`'s file as last saved, or `undefined` if there is none to be had. */
    reportOf(document: LangiumDocument): Promise<CompilerReport | undefined> {
        const request = this.request;
        if (!request || document.uri.scheme !== 'file') return Promise.resolve(undefined);
        const key = document.uri.toString();
        let report = this.reports.get(key);
        if (!report) {
            report = request(key).then(readReport, (error: unknown) => {
                this.logger.debug(`No compiler report for ${key}: ${messageOf(error)}`);
                return undefined;
            });
            this.reports.set(key, report);
        }
        return report;
    }

    /**
     * Forgets the reports a save of `uris` may have changed: those of the saved files, and of
     * every file that loads one, directly or not. An empty set forgets all of them, for a change
     * of compiler. Returns the URIs of the documents whose reports were forgotten, so that they can
     * be checked again.
     */
    forget(uris: ReadonlySet<string>): string[] {
        const forgotten: string[] = [];
        for (const key of [...this.reports.keys()]) {
            if (uris.size > 0 && !uris.has(key) && !this.loadsAny(key, uris)) continue;
            this.reports.delete(key);
            forgotten.push(key);
        }
        return forgotten;
    }

    private loadsAny(key: string, uris: ReadonlySet<string>): boolean {
        const document = this.services.shared.workspace.LangiumDocuments.getDocument(URI.parse(key));
        // A document gone from the workspace is forgotten too: nothing keeps its report fresh.
        if (!document) return true;
        const unit = document.parseResult.value as Unit | undefined;
        return !unit || this.importService.loadsAnyOf(unit, document, uris);
    }
}
