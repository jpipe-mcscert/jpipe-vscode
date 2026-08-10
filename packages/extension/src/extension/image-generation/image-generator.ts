import * as vscode from 'vscode';
import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { JpipeLogger } from '../logger.js';
import { ReleaseManager } from './release-manager.js';
import { planLaunchHere } from '../process-launcher.js';
import {
    buildPathEnv,
    findDiagramName as findDiagramNameIn,
    isUnknownOptionFailure,
    MIN_JSON_DIAGNOSTIC_VERSION,
    parseCompilerVersion,
    resolveExecCommand as resolveExecCommandFrom,
    supportsJsonDiagnostic,
    type CompilerSettings
} from './compiler-invocation.js';
import { isRenderableReport } from '../../shared/diagnostic-model.js';
import type { DiagnosticReport } from '../../shared/diagnostic-report.js';

/**
 * The outcome of one `diagnostic` run.
 *
 * `raw` is always there — it is what the panel shows when there is no structured report, and what
 * the copy button copies when there is. `report` is null for a compiler with no `-f json`, for
 * output that does not parse, and for a schema version this build does not know.
 */
export interface DiagnosticRun {
    raw: string;
    report: DiagnosticReport | null;
    /** 0 clean, 1 the model has errors, 42 the compiler crashed; undefined if it never ran. */
    exitCode: number | undefined;
}

const execFileAsync = promisify(execFile);

/**
 * Runs the compiler, still without a shell.
 *
 * `planLaunchHere` only alters anything on Windows, where a command may be a batch shim that
 * `CreateProcessW` cannot start (see `process-launcher.ts`).
 */
function runCompiler(
    file: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }
): Promise<{ stdout: string; stderr: string }> {
    const plan = planLaunchHere(file, args, options.env);
    // Annotated so the promisified overload resolving to string (not Buffer) is the one chosen.
    // `ExecFileOptions` alone no longer picks it: its `encoding` is typed loosely enough that
    // the overload returning `string | Buffer` wins, so name the string-encoding variant.
    const execOptions: ExecFileOptionsWithStringEncoding = {
        ...options,
        encoding: 'utf8',
        windowsVerbatimArguments: plan.windowsVerbatimArguments
    };
    return execFileAsync(plan.file, plan.args, execOptions);
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

/** PATH augmented so the compiler can find external interpreters (e.g. `python3`, `dot`). */
function envWithPath(): NodeJS.ProcessEnv {
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
     * @returns The generated content as a string (when not saving to file)
     */
    public async generate(
        saveToFile: boolean = false,
        format: ImageFormat = ImageFormat.SVG,
        document?: vscode.TextDocument,
        forcedDiagramName?: string
    ): Promise<string> {
        let editor = vscode.window.activeTextEditor;

        // Use provided document or get from active editor
        if (!document) {
            if (!editor || editor.document.languageId !== 'jpipe') {
                throw new Error('No active jPipe file');
            }
            document = editor.document;
        }

        // If we don't have an editor, try to get one from visible text editors
        if (!editor) {
            editor = vscode.window.visibleTextEditors.find(e => e.document === document);
        }

        const inputFile = document.uri.fsPath;
        const diagramName = forcedDiagramName ?? this.findDiagramName(document, editor);
        
        const config = vscode.workspace.getConfiguration('jpipe');

        let resolved: { file: string; args: string[] };
        try {
            resolved = this.resolveExecCommand(config);
        } catch (e: any) {
            vscode.window.showErrorMessage(e.message);
            throw e;
        }

        const argv = [
            ...resolved.args,
            'process',
            '-i', path.normalize(inputFile),
            '-m', diagramName,
            '-f', format.toString().toUpperCase(),
        ];

        if (saveToFile) {
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
            const { stdout } = await runCompiler(resolved.file, argv, { env: envWithPath(), timeout: timeoutMs(config), maxBuffer: MAX_OUTPUT_BYTES });
            this.logger.info(`Generated ${format} for '${diagramName}' (${path.basename(document.uri.fsPath)})`);
            return stdout;
        } catch (error: any) {
            this.logGenerationError(diagramName, error);
            // Preserve stdout/stderr so the preview can still render a best-effort SVG (if any)
            // and show diagnostics inline instead of blanking the whole viewer.
            const e = new Error(`Failed to generate ${format}: ${error.message}`) as Error & { stdout?: string; stderr?: string; exitCode?: number };
            e.stdout = typeof error?.stdout === 'string' ? error.stdout : undefined;
            e.stderr = typeof error?.stderr === 'string' ? error.stderr : undefined;
            e.exitCode = typeof error?.code === 'number' ? error.code : undefined;
            throw e;
        }
    }
    
    /**
     * Generate and save a file in the given format
     */
    public async check(): Promise<{ ok: boolean; message: string }> {
        const config = vscode.workspace.getConfiguration('jpipe');

        let resolved: { file: string; args: string[] };
        try {
            resolved = this.resolveExecCommand(config);
        } catch (e: any) {
            return { ok: false, message: e.message };
        }

        try {
            const { stdout, stderr } = await runCompiler(resolved.file, [...resolved.args, '--headless', 'doctor'], { env: envWithPath(), timeout: timeoutMs(config), maxBuffer: MAX_OUTPUT_BYTES });
            const output = (stdout + stderr).trim();
            return { ok: true, message: output || 'jPipe is accessible.' };
        } catch (error: any) {
            const detail = (error?.stderr ?? error?.stdout ?? error?.message ?? String(error)).trim();
            return { ok: false, message: `Cannot access jPipe: ${detail}` };
        }
    }

    /**
     * Run `diagnostic` and, when the compiler can produce one, parse its structured report.
     *
     * `report` being null is a supported outcome, not a failure: it is what an older compiler
     * gets, and it renders the raw text exactly as this panel always has. Nothing about that is
     * surfaced to the user, because from their point of view nothing went wrong.
     */
    public async generateDiagnostic(document: vscode.TextDocument): Promise<DiagnosticRun> {
        const inputFile = path.normalize(document.uri.fsPath);
        const config = vscode.workspace.getConfiguration('jpipe');

        let resolved: { file: string; args: string[] };
        try {
            resolved = this.resolveExecCommand(config);
        } catch (e: any) {
            // A misconfigured executable is the one case with nothing to render at all, so it
            // stays a message in the raw pane rather than a silent empty panel.
            return { raw: e.message, report: null, exitCode: undefined };
        }

        const wantsJson = await this.compilerSupportsJsonDiagnostic(resolved, config);
        const run = await this.runDiagnostic(resolved, inputFile, config, wantsJson);

        if (wantsJson && run.unknownOption) {
            // The version said the flag exists and it did not — a pre-feature snapshot, or a
            // patched build. Rather than show picocli's usage dump as though it were a report,
            // fetch the text one. Not detection: when the version is right this never runs.
            this.logger.warn(
                `Compiler reports a version with 'diagnostic -f json' but rejected the option; using the text report`);
            const textRun = await this.runDiagnostic(resolved, inputFile, config, false);
            return { raw: textRun.raw, report: null, exitCode: textRun.exitCode };
        }

        if (!wantsJson) return { raw: run.raw, report: null, exitCode: run.exitCode };
        return { raw: run.raw, report: this.parseReport(run.stdout), exitCode: run.exitCode };
    }

    /**
     * Whether this compiler is new enough to report diagnostics as JSON.
     *
     * Asked once per executable and cached: the answer is a property of the build, and running
     * `--version` before every save would be a second process for a fact that cannot change.
     * Keyed by the resolved command, so pointing `cliPath` or `jarFile` at a different build asks
     * again rather than inheriting the previous one's answer.
     */
    private readonly jsonDiagnosticSupport = new Map<string, boolean>();

    private async compilerSupportsJsonDiagnostic(
        resolved: { file: string; args: string[] },
        config: vscode.WorkspaceConfiguration
    ): Promise<boolean> {
        const execKey = [resolved.file, ...resolved.args].join(' ');
        const cached = this.jsonDiagnosticSupport.get(execKey);
        if (cached !== undefined) return cached;

        let supported = false;
        try {
            const { stdout, stderr } = await runCompiler(
                resolved.file,
                [...resolved.args, '--headless', '--version'],
                { env: envWithPath(), timeout: timeoutMs(config), maxBuffer: MAX_OUTPUT_BYTES }
            );
            const version = parseCompilerVersion(`${stdout}\n${stderr}`);
            supported = supportsJsonDiagnostic(version);
            this.logger.debug(
                `Compiler at '${execKey}' reports ${version ? version.nums.join('.') + (version.pre ? `-${version.pre}` : '') : 'no readable version'}; `
                + `structured diagnostics ${supported ? 'available' : `need ${MIN_JSON_DIAGNOSTIC_VERSION.join('.')}`}`);
        } catch (e: any) {
            // A build that cannot even be asked its version gets the text report, which every
            // release can produce. Not fatal: the diagnostic run itself will report the real
            // problem if there is one.
            this.logger.debug(`Could not read the compiler version from '${execKey}': ${e?.message ?? e}`);
        }

        this.jsonDiagnosticSupport.set(execKey, supported);
        return supported;
    }

    /** One invocation, with the pieces the caller has to tell apart kept separate. */
    private async runDiagnostic(
        resolved: { file: string; args: string[] },
        inputFile: string,
        config: vscode.WorkspaceConfiguration,
        asJson: boolean
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
        this.logger.info(`Executing: ${resolved.file} ${argv.join(' ')}`);

        const combine = (stdout: string, stderr: string): string =>
            [stdout, stderr].map(s => s.trim()).filter(Boolean).join('\n') || '(no output)';

        try {
            const { stdout, stderr } = await runCompiler(resolved.file, argv, {
                env: envWithPath(),
                timeout: timeoutMs(config),
                maxBuffer: MAX_OUTPUT_BYTES
            });
            return { raw: combine(stdout, stderr), stdout, exitCode: 0, unknownOption: false };
        } catch (e: any) {
            // A model with errors exits non-zero and still produces a full report, so a failed
            // invocation is not the same as no output — the report is read either way.
            const stdout: string = e.stdout ?? '';
            const stderr: string = e.stderr ?? '';
            const exitCode: number | undefined = typeof e.code === 'number' ? e.code : undefined;
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
        try {
            await this.generate(true, format, document, forcedDiagramName);
            vscode.window.showInformationMessage(`${format} saved successfully`);
            const openAfter = vscode.workspace.getConfiguration('jpipe').get<boolean>('openAfterExport', false);
            if (openAfter && this.lastExportUri) {
                void vscode.commands.executeCommand('vscode.open', this.lastExportUri);
            }
        } catch (error: any) {
            if (error?.cancelled === true || String(error?.message ?? '') === 'Save cancelled') {
                return;
            }
            this.logger.error(error.message);
            this.logger.revealIfLogged('error');
        }
    }
    
    private logGenerationError(diagramName: string, error: any): void {
        const exitCode: number | undefined = typeof error?.code === 'number' ? error.code : undefined;
        const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
        if (exitCode === 1) {
            this.logger.warn(`Compiler exit 1 (model errors) for '${diagramName}'`);
            this.logger.revealIfLogged('warn');
        } else if (exitCode === 42) {
            this.logger.error(`Compiler exit 42 (crash) for '${diagramName}'`);
            this.logger.revealIfLogged('error');
        } else {
            this.logger.error(`Generation failed for '${diagramName}': ${error instanceof Error ? error.message : String(exitCode ?? error)}`);
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
