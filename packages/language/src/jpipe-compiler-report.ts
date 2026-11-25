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
import * as fs from 'node:fs';
import { DocumentState, URI, type LangiumDocument } from 'langium';
import type { Unit } from './generated/ast.js';
import type { JpipeServices } from './jpipe-module.js';
import type { JpipeServerLogger } from './jpipe-logger.js';
import { fileKey, type JpipeImportService } from './jpipe-import.js';
import { fsPathOf, type ElementKind } from './jpipe-utils.js';
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
    if (symbols.includes(undefined)) return undefined;
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
    if (models.includes(undefined) || diagnostics.includes(undefined)) return undefined;
    return { source: value.source, models: models as ReportModel[], diagnostics: diagnostics as ReportDiagnostic[] };
}

/**
 * How the server asks its client for a file's report: the file's URI string in, the report or
 * `null` out. `null` covers every reason there is none — no compiler, one too old, a run that
 * failed or timed out — which the server does not need to tell apart.
 */
export type ReportRequest = (uri: string) => Promise<unknown>;

/** How long an answer without a report stands before it is asked again: a compiler may have been installed meanwhile, or a run may have failed once. */
const RETRY_AFTER_MS = 60_000;

/** What is known of one file's report: on its way, or arrived, as a report or as none. */
interface Entry {
    arrived: boolean;
    report?: CompilerReport;
    /** When it was asked, then when it arrived. */
    at: number;
}

/**
 * The compiler's reports, one per file asked about, kept until a save can change them.
 *
 * A report is asked for only when a model builds on a composition, and only once until a file it
 * depends on is saved: nothing is sent on a keystroke. Nothing waits for one either: checking a
 * file must not stand behind a JVM start, nor every file queued behind it. Until a file's report
 * has arrived, `reportOf` has none to give, and the file is checked again once it arrives. An
 * answer without a report is asked again after a minute, since the compiler may have been
 * installed outside the editor, or a run may have failed once.
 *
 * The report says where things are in the files as they were saved, and it is read against the
 * documents, whose text may have changed since: `readsAsSaved` says whether a document still
 * reads as its saved file up to a point.
 */
export class CompilerReports {
    private request: ReportRequest | undefined;
    private readonly entries = new Map<string, Entry>();
    /** The saved text of each file read, by `fileKey`; `undefined` for a file that cannot be read. */
    private readonly saved = new Map<string, string | undefined>();
    private readonly inFlight = new Set<Promise<void>>();
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
        this.entries.clear();
        this.saved.clear();
    }

    /**
     * The report of `document`'s file as last saved, if it has arrived. When it has not, it is
     * asked for, unless it is already on its way, and `document` is checked again once it comes.
     */
    reportOf(document: LangiumDocument): CompilerReport | undefined {
        const request = this.request;
        if (!request || document.uri.scheme !== 'file') return undefined;
        const key = document.uri.toString();
        const entry = this.entries.get(key);
        if (entry && (!entry.arrived || entry.report || Date.now() - entry.at < RETRY_AFTER_MS)) return entry.report;
        this.ask(request, key);
        return undefined;
    }

    private ask(request: ReportRequest, key: string): void {
        const entry: Entry = { arrived: false, at: Date.now() };
        this.entries.set(key, entry);
        const arrival = request(key)
            .then(readReport, (error: unknown) => {
                this.logger.debug(`No compiler report for ${key}: ${messageOf(error)}`);
                return undefined;
            })
            .then(async report => {
                // Forgotten on its way: the files it was made from have changed since.
                if (this.entries.get(key) !== entry) return;
                Object.assign(entry, { arrived: true, report, at: Date.now() });
                // A file checked without its report was checked with *cannot tell*, which only a
                // report changes.
                if (report) await this.recheck([key]);
            })
            .catch((error: unknown) => this.logger.error(`Could not check ${key} again: ${messageOf(error)}`));
        this.inFlight.add(arrival);
        void arrival.finally(() => this.inFlight.delete(arrival));
    }

    /** Resolves once no report is on its way, and every document one arrived for is checked again. */
    async idle(): Promise<void> {
        if (this.inFlight.size === 0) return;
        await Promise.all(this.inFlight);
        // An arrival may have asked for another report meanwhile.
        return this.idle();
    }

    /**
     * Whether `document` reads, up to `end` (an offset), as its file was saved: whether what a
     * report places before `end` is where the document has it.
     *
     * A byte-order mark is no text: VS Code drops it from an open document, and a closed one read
     * from disk keeps it, so it is left out of both sides.
     */
    readsAsSaved(document: LangiumDocument, end: number): boolean {
        const file = fsPathOf(document.uri);
        const key = fileKey(file);
        if (!this.saved.has(key)) this.saved.set(key, withoutBom(readSaved(file)));
        const text = document.textDocument.getText();
        const bom = text.startsWith(BOM) ? BOM.length : 0;
        return this.saved.get(key)?.slice(0, end - bom) === text.slice(bom, end);
    }

    /**
     * Whether `document`, and every file it loads in turn, reads as saved through its last
     * `load`: which file a model a report names comes from, and under which namespace, is decided
     * there.
     */
    loadsReadAsSaved(document: LangiumDocument): boolean {
        const unit = document.parseResult.value as Unit | undefined;
        if (!unit) return false;
        return [document, ...this.importService.getTransitiveImportedDocuments(unit, document)]
            .every(loaded => this.readsAsSaved(loaded, endOfLoads(loaded)));
    }

    /**
     * The files `uris` changed on disk, or every file when `uris` is empty, for a change of
     * compiler: forgets what they may have changed, reads again those of them the workspace holds
     * that are not open in the editor, and checks again every document whose report is forgotten.
     */
    async inputsChanged(uris: ReadonlySet<string>): Promise<void> {
        if (uris.size === 0) this.saved.clear();
        for (const uri of uris) this.saved.delete(fileKey(fsPathOf(URI.parse(uri))));
        await this.recheck(this.forget(uris), [...uris].map(uri => URI.parse(uri)));
    }

    /**
     * Forgets the reports a save of `uris` may have changed: those of the saved files, and of
     * every file that loads one, directly or not. An empty set forgets all of them. Returns the
     * URIs of the documents whose reports were forgotten.
     */
    forget(uris: ReadonlySet<string>): string[] {
        const forgotten: string[] = [];
        for (const key of this.entries.keys()) {
            if (uris.size > 0 && !uris.has(key) && !this.loadsAny(key, uris)) continue;
            this.entries.delete(key);
            forgotten.push(key);
        }
        return forgotten;
    }

    /**
     * Checks the documents of `keys` again, and reads again the files of `changed` the workspace
     * holds: the client sends the server no file events, so a file changed on disk outside the
     * editor would keep the text it was first read with. Langium reads an open one from its
     * buffer, so an unsaved edit is kept. Under the workspace lock, as every build is: a write
     * cancels the one running, and `update` then builds again whatever that one left unfinished,
     * and links again whatever refers to a file read again.
     */
    private async recheck(keys: readonly string[], changed: readonly URI[] = []): Promise<void> {
        const workspace = this.services.shared.workspace;
        const documents = keys
            .map(key => workspace.LangiumDocuments.getDocument(URI.parse(key)))
            .filter(document => document !== undefined);
        const reread = changed.filter(uri => workspace.LangiumDocuments.hasDocument(uri) && fs.existsSync(fsPathOf(uri)));
        if (documents.length === 0 && reread.length === 0) return;
        await workspace.WorkspaceLock.write(async token => {
            for (const document of documents) workspace.DocumentBuilder.resetToState(document, DocumentState.IndexedReferences);
            await workspace.DocumentBuilder.update(reread, [], token);
        });
    }

    private loadsAny(key: string, uris: ReadonlySet<string>): boolean {
        const document = this.services.shared.workspace.LangiumDocuments.getDocument(URI.parse(key));
        // A document gone from the workspace is forgotten too: nothing keeps its report fresh.
        if (!document) return true;
        const unit = document.parseResult.value as Unit | undefined;
        return !unit || this.importService.loadsAnyOf(unit, document, uris);
    }
}

/** The offset just past `document`'s last `load`, `0` when it has none. */
function endOfLoads(document: LangiumDocument): number {
    const imports = (document.parseResult.value as Unit | undefined)?.imports ?? [];
    return Math.max(0, ...imports.map(load => load.$cstNode?.end ?? 0));
}

const BOM = '\uFEFF';

function withoutBom(text: string | undefined): string | undefined {
    return text?.startsWith(BOM) ? text.slice(BOM.length) : text;
}

function readSaved(file: string): string | undefined {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return undefined;
    }
}
