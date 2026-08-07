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
    resolveExecCommand as resolveExecCommandFrom,
    type CompilerSettings
} from './compiler-invocation.js';

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

    public async generateDiagnostic(document: vscode.TextDocument): Promise<string> {
        const inputFile = path.normalize(document.uri.fsPath);
        const config = vscode.workspace.getConfiguration('jpipe');

        let resolved: { file: string; args: string[] };
        try {
            resolved = this.resolveExecCommand(config);
        } catch (e: any) {
            return e.message;
        }

        const argv = [...resolved.args, 'diagnostic', '-i', inputFile];
        this.logger.info(`Executing: ${resolved.file} ${argv.join(' ')}`);
        try {
            const { stdout, stderr } = await runCompiler(resolved.file, argv, { env: envWithPath(), timeout: timeoutMs(config), maxBuffer: MAX_OUTPUT_BYTES });
            return [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)';
        } catch (e: any) {
            const out = (e.stdout ?? '').trim();
            const err = (e.stderr ?? '').trim();
            return [out, err].filter(Boolean).join('\n') || `Exit code ${e.code}`;
        }
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
