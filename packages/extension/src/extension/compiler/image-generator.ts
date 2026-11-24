import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { JpipeLogger } from '../logger.js';
import { asProcessFailure, detailOf, messageOf } from '../../shared/errors.js';
import { CompilerVerdicts } from './compiler-verdicts.js';
import { ReleaseManager } from './release-manager.js';
import { runProgram } from '../process-launcher.js';
import {
    buildPathEnv,
    findDiagramName as findDiagramNameIn,
    isUnknownOptionFailure,
    parseCompilerVersion,
    resolveExecCommand as resolveExecCommandFrom,
    type CompilerSettings
} from './compiler-invocation.js';
import {
    COMPILER_INSTALL_GUIDE,
    CompilerTooOldError,
    compilerHas,
    compilerLine,
    compilerUpdate,
    compilerVerdict,
    type CompilerVerdict
} from '../requirements.js';
import { isRenderableReport } from '../../shared/diagnostic-model.js';
import type { DiagnosticReport } from '../../shared/diagnostic-report.js';
import { RunLimit } from './run-limit.js';

/**
 * The outcome of one `diagnostic` run.
 *
 * `raw` is always there — it is what the panel shows when there is no structured report, and what
 * the copy button copies when there is. `report` is null for a compiler that cannot be used, for
 * output that does not parse, and for a schema version this build does not know.
 */
export interface DiagnosticRun {
    raw: string;
    report: DiagnosticReport | null;
    /** 0 clean, 1 the model has errors, 42 the compiler crashed; undefined if it never ran. */
    exitCode: number | undefined;
}

/** What identifies a compiler build: the command it is started with. */
function execKeyOf(resolved: { file: string; args: string[] }): string {
    return [resolved.file, ...resolved.args].join(' ');
}

/** Generous stdout cap so large SVG renders are not truncated (default is only 1 MB). */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Fallback invocation timeout (seconds) when `jpipe.compilerTimeout` is unset. */
const DEFAULT_TIMEOUT_SECONDS = 30;

/** Max time (ms) to wait for a compiler invocation before giving up, so a hung
 *  compiler surfaces an error instead of freezing the preview panel indefinitely. */
function timeoutMs(config: vscode.WorkspaceConfiguration): number {
    const seconds = config.get<number>('compilerTimeout', DEFAULT_TIMEOUT_SECONDS);
    return (typeof seconds === 'number' && seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS) * 1000;
}

/**
 * PATH augmented so the compiler can find external interpreters (e.g. `python3`, `dot`).
 * Exported for the runner, which looks for the same interpreters (`runner/environment.ts`).
 */
export function envWithPath(): NodeJS.ProcessEnv {
    const extra = vscode.workspace.getConfiguration('jpipe').get<string[]>('extraPath', []) ?? [];
    return buildPathEnv(process.env, extra, process.platform);
}

export enum ImageFormat {
    JPIPE  = 'JPIPE',
    JSON   = 'JSON',
    PNG    = 'PNG',
    JPEG   = 'JPEG',
    SVG    = 'SVG',
    DOT    = 'DOT',
    PYTHON = 'PYTHON',
}

export class ImageGenerator {

    /** Destination of the most recent save-to-file generate(), so generateAndSave can open it. */
    private lastExportUri: vscode.Uri | undefined;

    /** Whether an export is running. Guards `generateAndSave`; see the note there. */
    private exportInFlight = false;

    constructor(
        private readonly logger: JpipeLogger,
        private readonly releaseManager: ReleaseManager
    ) {}

    /**
     * Resolve the executable and its leading arguments for the configured execution mode:
     * the CLI (`{ file: cli, args: [] }`), or `java [jvmArgs…] -jar <jar>` for `jar` / `managed`.
     * Returned as an argv pair so callers can invoke via `execFile` (no shell) — user/workspace
     * settings are never interpreted by a shell. Throws a user-facing message when misconfigured.
     */
    private resolveExecCommand(config: vscode.WorkspaceConfiguration): { file: string; args: string[] } {
        const settings: CompilerSettings = {
            executionMode: config.get<string>('executionMode', 'cli'),
            cliPath: config.get<string>('cliPath', 'jpipe') ?? 'jpipe',
            jarFile: config.get<string>('jarFile', '') ?? '',
            javaExecutable: config.get<string>('javaExecutable', 'java') ?? 'java',
            jvmArgs: config.get<string[]>('jvmArgs', []) ?? []
        };
        return resolveExecCommandFrom(settings, {
            fileExists: candidate => fs.existsSync(candidate),
            installedJarPath: this.releaseManager.getInstalled()?.jarPath,
            home: os.homedir()
        });
    }
    
    /**
     * Generate an image from the active jpipe file or provided document
     * @param saveToFile If true, prompts user for save location
     * @param format Output format (defaults to SVG)
     * @param document Optional document to use instead of active editor
     * @param outputFile Where the compiler writes its output, chosen by the caller: no prompt
     * @returns The generated content as a string (when not saving to file)
     */
    public async generate(
        saveToFile: boolean = false,
        format: ImageFormat = ImageFormat.SVG,
        document?: vscode.TextDocument,
        forcedDiagramName?: string,
        outputFile?: vscode.Uri
    ): Promise<string> {
        let editor = vscode.window.activeTextEditor;

        // Use provided document or get from active editor
        if (!document) {
            if (editor?.document.languageId !== 'jpipe') {
                throw new Error('No active jPipe file');
            }
            document = editor.document;
        }

        // If we don't have an editor, try to get one from visible text editors
        editor ??= vscode.window.visibleTextEditors.find(e => e.document === document);

        const inputFile = document.uri.fsPath;
        const diagramName = forcedDiagramName ?? this.findDiagramName(document, editor);
        
        const config = vscode.workspace.getConfiguration('jpipe');

        let resolved: { file: string; args: string[] };
        try {
            resolved = await this.usableCommand(config);
        } catch (e: unknown) {
            // A compiler too old has said so already, with its update button.
            if (!(e instanceof CompilerTooOldError)) void vscode.window.showErrorMessage(messageOf(e));
            throw e;
        }

        const argv = [
            ...resolved.args,
            'process',
            '-i', path.normalize(inputFile),
            '-m', diagramName,
            '-f', format.toString().toUpperCase(),
        ];

        if (outputFile) {
            argv.push('-o', outputFile.fsPath);
        } else if (saveToFile) {
            const outputPath = await this.promptForSaveLocation(document, diagramName, format);
            if (!outputPath) {
                const e = new Error('Save cancelled') as Error & { cancelled?: boolean };
                e.cancelled = true;
                throw e;
            }
            argv.push('-o', outputPath.fsPath);
            // Recorded only on the save path so a concurrent preview render can't clear it.
            this.lastExportUri = outputPath;
        }

        this.logger.info(`Executing: ${resolved.file} ${argv.join(' ')}`);

        try {
            const { stdout } = await runProgram(resolved.file, argv, { env: envWithPath(), timeout: timeoutMs(config), maxBuffer: MAX_OUTPUT_BYTES });
            this.logger.info(`Generated ${format} for '${diagramName}' (${path.basename(document.uri.fsPath)})`);
            return stdout;
        } catch (error: unknown) {
            this.logGenerationError(diagramName, error);
            // Preserve stdout/stderr so the preview can still render a best-effort SVG (if any)
            // and show diagnostics inline instead of blanking the whole viewer.
            const failure = asProcessFailure(error);
            const e = new Error(`Failed to generate ${format}: ${messageOf(error)}`) as Error & { stdout?: string; stderr?: string; exitCode?: number };
            e.stdout = failure.stdout;
            e.stderr = failure.stderr;
            e.exitCode = failure.exitCode;
            throw e;
        }
    }
    
    /**
     * What Check jPipe Installation says about the compiler: whether it answers, its `doctor`
     * report, and whether its version is one this extension can use.
     *
     * The version is asked afresh rather than read from the cache, since the reason to check is
     * often that the compiler was just updated.
     */
    public async check(): Promise<{ status: 'ready' | 'unreachable' | 'too-old'; message: string; version?: string }> {
        const config = vscode.workspace.getConfiguration('jpipe');

        let resolved: { file: string; args: string[] };
        try {
            resolved = this.resolveExecCommand(config);
        } catch (e: unknown) {
            return { status: 'unreachable', message: messageOf(e) };
        }

        const execKey = execKeyOf(resolved);
        // A compiler that rejected `-f json` stays refused while it answers `--version` the same.
        this.verdicts.forget(execKey);
        // Two starts of the compiler, neither waiting on the other's answer.
        const [verdict, doctor] = await Promise.all([
            this.verdictFor(resolved, config),
            runProgram(resolved.file, [...resolved.args, '--headless', 'doctor'], { env: envWithPath(), timeout: timeoutMs(config), maxBuffer: MAX_OUTPUT_BYTES })
                .then(({ stdout, stderr }) => ({ output: (stdout + stderr).trim() || 'jPipe is accessible.' }), (error: unknown) => ({ error }))
        ]);
        const version = compilerLine(verdict);
        if ('error' in doctor) {
            // A compiler older than `doctor` fails here, and its version is the reason worth
            // giving: it has an update to offer, where "cannot access" has none.
            const message = `Cannot access jPipe: ${detailOf(doctor.error)}`;
            return verdict.kind === 'too-old' ? { status: 'too-old', message, version } : { status: 'unreachable', message };
        }
        return { status: verdict.kind === 'too-old' ? 'too-old' : 'ready', message: doctor.output, version };
    }

    /**
     * Get the user a compiler recent enough: the managed mode installs one, the others are sent
     * to the install guide, since their compiler is theirs to update.
     */
    public async updateCompiler(): Promise<void> {
        const mode = vscode.workspace.getConfiguration('jpipe').get<string>('executionMode', 'cli');
        if (compilerUpdate(mode).kind === 'install') {
            await vscode.commands.executeCommand('jpipe.installFromRelease');
        } else {
            await vscode.env.openExternal(vscode.Uri.parse(COMPILER_INSTALL_GUIDE));
        }
    }

    /**
     * Run `diagnostic` and parse its structured report.
     *
     * A compiler too old to produce one is not run: the panel says why instead, in the raw pane,
     * and the user is offered an update (jpipe-vscode ADR-VSC-0032).
     */
    public async generateDiagnostic(document: vscode.TextDocument): Promise<DiagnosticRun> {
        const inputFile = path.normalize(document.uri.fsPath);
        const config = vscode.workspace.getConfiguration('jpipe');

        let resolved: { file: string; args: string[] };
        try {
            resolved = await this.usableCommand(config);
        } catch (e: unknown) {
            // A misconfigured executable, or one too old, has nothing to render at all, so it
            // stays a message in the raw pane rather than a silent empty panel.
            return { raw: messageOf(e), report: null, exitCode: undefined };
        }
        const run = await this.runDiagnostic(resolved, inputFile, config, true);

        if (run.unknownOption) {
            // A build whose version could not be read, or that claimed more than it has: it
            // does not know `-f json`, so it predates what this extension needs. Said as such
            // rather than shown as picocli's usage dump.
            const tooOld = new CompilerTooOldError(undefined);
            this.verdicts.rejectJson(execKeyOf(resolved));
            this.tellTooOld(execKeyOf(resolved), tooOld);
            return { raw: tooOld.message, report: null, exitCode: undefined };
        }
        return { raw: run.raw, report: this.parseReport(run.stdout), exitCode: run.exitCode };
    }

    /** Reports asked by the language server run two at a time: each starts a JVM. */
    private readonly reportRuns = new RunLimit(2);

    /**
     * The compiler's report on the file `fsPath`, as saved, which the language server reads a
     * composed model's elements from (jpipe-vscode ADR-VSC-0034), or `null` when there is none.
     *
     * Quiet, unlike `generateDiagnostic`: nobody asked for it, so a compiler missing, misconfigured
     * or too old is not reported here, and its models are left alone as before. Only a compiler
     * that names composed elements as the editor reads them is run (`COMPILER_FEATURES`).
     */
    public async reportFor(fsPath: string): Promise<DiagnosticReport | null> {
        const config = vscode.workspace.getConfiguration('jpipe');
        let resolved: { file: string; args: string[] };
        try {
            resolved = this.resolveExecCommand(config);
        } catch {
            return null;
        }
        // The version is asked under the limit too: on a cold start, every file would ask it at once.
        return this.reportRuns.run(async () => {
            const verdict = await this.verdictFor(resolved, config);
            if (verdict.kind !== 'supported') return null;
            if (!compilerHas(verdict.version, 'composed')) {
                this.askAgainLater(execKeyOf(resolved));
                return null;
            }
            const run = await this.runDiagnostic(resolved, path.normalize(fsPath), config, true, 'debug');
            return run.unknownOption ? null : this.parseReport(run.stdout);
        });
    }

    /** When each compiler too old for composed models was last set to be asked its version again. */
    private readonly askedAgain = new Map<string, number>();

    /**
     * Have the compiler at `execKey` asked its version again, at most once a minute: one usable
     * but too old for composed models is what its user updates next, often in place under the same
     * command, and the version it gave is otherwise kept for the session.
     */
    private askAgainLater(execKey: string): void {
        const now = Date.now();
        if (now - (this.askedAgain.get(execKey) ?? Number.NEGATIVE_INFINITY) < 60_000) return;
        this.askedAgain.set(execKey, now);
        this.verdicts.forget(execKey);
    }

    /**
     * The compiler's human-readable report, for a reader who wants the classical output.
     *
     * A separate invocation: asking for `-f json` means the run's own output is the JSON, so on a
     * compiler new enough to have the flag there is no text report lying around to show.
     */
    public async generateTextDiagnostic(document: vscode.TextDocument): Promise<string> {
        const inputFile = path.normalize(document.uri.fsPath);
        const config = vscode.workspace.getConfiguration('jpipe');
        let resolved: { file: string; args: string[] };
        try {
            resolved = await this.usableCommand(config);
        } catch (e: unknown) {
            return messageOf(e);
        }
        const run = await this.runDiagnostic(resolved, inputFile, config, false);
        return run.raw;
    }

    /** What each compiler's version means, by resolved command: see `CompilerVerdicts`. */
    private readonly verdicts = new CompilerVerdicts();

    /** The too-old compilers the user has been told about, by command and version: once each. */
    private readonly toldTooOld = new Set<string>();

    private async verdictFor(
        resolved: { file: string; args: string[] },
        config: vscode.WorkspaceConfiguration
    ): Promise<CompilerVerdict> {
        const execKey = execKeyOf(resolved);
        const cached = this.verdicts.cached(execKey);
        if (cached) return cached;
        const output = await this.askVersion(resolved, config, execKey);
        const verdict = this.verdicts.answer(execKey, output, printed => compilerVerdict(parseCompilerVersion(printed)));
        this.logger.debug(`Compiler at '${execKey}': ${compilerLine(verdict)}`);
        return verdict;
    }

    /** What `--version` prints, or `undefined` when it cannot be asked. */
    private async askVersion(
        resolved: { file: string; args: string[] },
        config: vscode.WorkspaceConfiguration,
        execKey: string
    ): Promise<string | undefined> {
        try {
            const { stdout, stderr } = await runProgram(
                resolved.file,
                [...resolved.args, '--headless', '--version'],
                { env: envWithPath(), timeout: timeoutMs(config), maxBuffer: MAX_OUTPUT_BYTES }
            );
            return `${stdout}\n${stderr}`;
        } catch (e: unknown) {
            this.logger.debug(`Could not read the compiler version from '${execKey}': ${messageOf(e)}`);
            return undefined;
        }
    }

    /**
     * Refuse to run a compiler older than this extension needs (jpipe-vscode ADR-VSC-0032).
     *
     * @throws CompilerTooOldError, after offering the update.
     */
    /**
     * The compiler to run, as configured, once it is known to be recent enough: throws what
     * `resolveExecCommand` throws for one misconfigured, and a `CompilerTooOldError` for one too
     * old, which has then told the user so.
     */
    private async usableCommand(config: vscode.WorkspaceConfiguration): Promise<{ file: string; args: string[] }> {
        const resolved = this.resolveExecCommand(config);
        await this.requireSupported(resolved, config);
        return resolved;
    }

    private async requireSupported(
        resolved: { file: string; args: string[] },
        config: vscode.WorkspaceConfiguration
    ): Promise<void> {
        const verdict = await this.verdictFor(resolved, config);
        if (verdict.kind !== 'too-old') return;
        const error = new CompilerTooOldError(verdict.version);
        this.tellTooOld(execKeyOf(resolved), error);
        throw error;
    }

    /**
     * Say once, with the way out, that this compiler is too old. Once per compiler and version:
     * a preview refreshes on every save, and a notification each time would bury the editor.
     */
    private tellTooOld(execKey: string, error: CompilerTooOldError): void {
        const key = `${execKey}@${error.version ?? '?'}`;
        if (this.toldTooOld.has(key)) return;
        this.toldTooOld.add(key);
        this.logger.warn(`${error.message} (${execKey})`);
        const mode = vscode.workspace.getConfiguration('jpipe').get<string>('executionMode', 'cli');
        const { label } = compilerUpdate(mode);
        void vscode.window.showErrorMessage(error.message, label).then(answer => {
            if (answer === label) void this.updateCompiler();
        });
    }

    /** One invocation, with the pieces the caller has to tell apart kept separate. */
    private async runDiagnostic(
        resolved: { file: string; args: string[] },
        inputFile: string,
        config: vscode.WorkspaceConfiguration,
        asJson: boolean,
        /** `debug` for a run nobody asked for, the language server's: one per file, at every save. */
        log: 'info' | 'debug' = 'info'
    ): Promise<{ raw: string; stdout: string; exitCode: number | undefined; unknownOption: boolean }> {
        // `--headless` suppresses the compiler's logo banner, which this command used to print
        // above every report.
        const argv = [
            ...resolved.args,
            '--headless',
            'diagnostic',
            ...(asJson ? ['-f', 'json'] : []),
            '-i',
            inputFile
        ];
        this.logger[log](`Executing: ${resolved.file} ${argv.join(' ')}`);

        const combine = (stdout: string, stderr: string): string =>
            [stdout, stderr].map(s => s.trim()).filter(Boolean).join('\n') || '(no output)';

        try {
            const { stdout, stderr } = await runProgram(resolved.file, argv, {
                env: envWithPath(),
                timeout: timeoutMs(config),
                maxBuffer: MAX_OUTPUT_BYTES
            });
            return { raw: combine(stdout, stderr), stdout, exitCode: 0, unknownOption: false };
        } catch (e: unknown) {
            // A model with errors exits non-zero and still produces a full report, so a failed
            // invocation is not the same as no output — the report is read either way.
            const failure = asProcessFailure(e);
            const stdout: string = failure.stdout ?? '';
            const stderr: string = failure.stderr ?? '';
            const exitCode: number | undefined = failure.exitCode;
            return {
                raw: combine(stdout, stderr) === '(no output)' && exitCode !== undefined
                    ? `Exit code ${exitCode}`
                    : combine(stdout, stderr),
                stdout,
                exitCode,
                unknownOption: isUnknownOptionFailure(exitCode, stderr)
            };
        }
    }

    /**
     * The structured report, or null if there isn't a usable one.
     *
     * Tolerant on purpose. `isRenderableReport` asks only whether this is the shape this version
     * knows how to draw; it does not validate against the schema, because a compiler adding a
     * field must keep rendering rather than blank the panel. Full validation lives in the tests.
     */
    private parseReport(stdout: string): DiagnosticReport | null {
        const trimmed = stdout.trim();
        if (!trimmed.startsWith('{')) return null;
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            this.logger.debug('Diagnostic output announced itself as JSON but did not parse');
            return null;
        }
        if (!isRenderableReport(parsed)) {
            this.logger.debug('Diagnostic report is not a shape this version can render');
            return null;
        }
        return parsed;
    }

    public async generateAndSave(format: ImageFormat = ImageFormat.SVG, document?: vscode.TextDocument, forcedDiagramName?: string): Promise<void> {
        // One export at a time, across every entry point — the palette, the menus and the
        // preview's download button all arrive here. Without this, two quick clicks start two
        // compiler runs and stack two save dialogs on top of each other, and the second dialog
        // defaults to the same filename as the first. Declined rather than queued: a queue would
        // still show the second dialog, just later, which is the confusing part.
        // `debug`, not `warn`: declining the second of a double-click is the guard working, not
        // a fault, and the default log level would have put it in the channel every time. It is
        // still worth recording — it is the only explanation for an export that did nothing.
        if (this.exportInFlight) {
            this.logger.debug(`Export already in progress; ignoring the request for ${format}`);
            return;
        }
        this.exportInFlight = true;
        try {
            await this.generate(true, format, document, forcedDiagramName);
            vscode.window.showInformationMessage(`${format} saved successfully`);
            const openAfter = vscode.workspace.getConfiguration('jpipe').get<boolean>('openAfterExport', false);
            if (openAfter && this.lastExportUri) {
                void vscode.commands.executeCommand('vscode.open', this.lastExportUri);
            }
        } catch (error: unknown) {
            if (asProcessFailure(error).cancelled || messageOf(error) === 'Save cancelled') {
                return;
            }
            this.logger.error(messageOf(error));
            this.logger.revealIfLogged('error');
        } finally {
            // `finally`, not a line at the end of `try`: the cancelled branch above returns
            // early, and a flag left set would refuse every later export for the session.
            this.exportInFlight = false;
        }
    }

    private logGenerationError(diagramName: string, error: unknown): void {
        const failure = asProcessFailure(error);
        const exitCode = failure.exitCode;
        const stderr = failure.stderr?.trim() ?? '';
        if (exitCode === 1) {
            this.logger.warn(`Compiler exit 1 (model errors) for '${diagramName}'`);
            this.logger.revealIfLogged('warn');
        } else if (exitCode === 42) {
            this.logger.error(`Compiler exit 42 (crash) for '${diagramName}'`);
            this.logger.revealIfLogged('error');
        } else {
            // `exitCode ?? error` in the fallback: a non-Error rejection is usually the exit
            // status itself, which is more use in a log line than "[object Object]".
            this.logger.error(`Generation failed for '${diagramName}': ${error instanceof Error ? messageOf(error) : String(exitCode ?? error)}`);
            this.logger.revealIfLogged('error');
        }
        if (stderr) {
            this.logger.warn(`Compiler stderr: ${stderr}`);
        }
    }

    findDiagramName(document: vscode.TextDocument, editor: vscode.TextEditor | undefined): string {
        return findDiagramNameIn(document.getText(), editor?.selection.active.line ?? 0);
    }
    
    /**
     * Prompt user for save location
     */
    private async promptForSaveLocation(
        document: vscode.TextDocument,
        diagramName: string,
        format: ImageFormat
    ): Promise<vscode.Uri | undefined> {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        const extensionMap: Record<string, string> = { PYTHON: 'py', JPEG: 'jpeg', JPIPE: 'jd' };
        const extension = extensionMap[format] ?? format.toString().toLowerCase();
        const defaultUri = workspaceFolder 
            ? vscode.Uri.joinPath(workspaceFolder.uri, `${diagramName}.${extension}`)
            : vscode.Uri.file(`${diagramName}.${extension}`);
        
        return await vscode.window.showSaveDialog({
            defaultUri: defaultUri,
            saveLabel: 'Save model'
        });
    }
}
