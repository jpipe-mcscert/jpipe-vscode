import * as vscode from 'vscode';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { JpipeLogger } from '../logger.js';
import { ReleaseManager } from './release-manager.js';

const execAsync = promisify(exec);

/** Fallback invocation timeout (seconds) when `jpipe.compilerTimeout` is unset. */
const DEFAULT_TIMEOUT_SECONDS = 30;

/** Max time (ms) to wait for a compiler invocation before giving up, so a hung
 *  compiler surfaces an error instead of freezing the preview panel indefinitely. */
function timeoutMs(config: vscode.WorkspaceConfiguration): number {
    const seconds = config.get<number>('compilerTimeout', DEFAULT_TIMEOUT_SECONDS);
    return (typeof seconds === 'number' && seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS) * 1000;
}

/** Expand leading ~ to the user's home directory (Node does not do this by default). */
function expandTilde(filePath: string): string {
    const home = os.homedir();
    if (filePath === '~') return home;
    if (filePath.startsWith('~/') || filePath.startsWith('~\\')) return path.join(home, filePath.slice(2));
    return filePath;
}

/**
 * PATH augmented so the compiler can find external interpreters (e.g. `python3`, `dot`):
 * user-configured `jpipe.extraPath` entries first, then the built-in Homebrew defaults,
 * then the inherited PATH.
 */
function envWithPath(): NodeJS.ProcessEnv {
    const extra = vscode.workspace.getConfiguration('jpipe').get<string[]>('extraPath', []) ?? [];
    const defaults = ['/opt/homebrew/bin', '/usr/local/bin'];
    const existing = process.env.PATH ?? '';
    const prefix = [...extra.filter(Boolean), ...defaults].join(path.delimiter);
    return { ...process.env, PATH: `${prefix}${path.delimiter}${existing}` };
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
     * Resolve the command prefix (everything before the subcommand) for the configured
     * execution mode: the resolved CLI, or `"java" -jar "<jar>"` for `jar` / `managed`.
     * Throws with a user-facing message when the selected mode is misconfigured.
     */
    private async resolveExecPrefix(config: vscode.WorkspaceConfiguration): Promise<string> {
        const mode = config.get<string>('executionMode', 'cli');

        if (mode === 'jar') {
            const jarFile = expandTilde((config.get<string>('jarFile', '') ?? '').trim());
            if (!jarFile) throw new Error('jpipe.jarFile is not configured.');
            if (!fs.existsSync(jarFile)) throw new Error(`JAR file not found: ${jarFile}`);
            return this.buildJarPrefix(config, jarFile);
        }

        if (mode === 'managed') {
            const installed = this.releaseManager.getInstalled();
            if (!installed) {
                throw new Error("No managed jPipe compiler installed. Run 'jPipe: Install Compiler from GitHub Release'.");
            }
            if (!fs.existsSync(installed.jarPath)) {
                throw new Error(`Managed JAR file not found: ${installed.jarPath}`);
            }
            return this.buildJarPrefix(config, installed.jarPath);
        }

        // cli mode: resolve a bare name via `which`, otherwise use the given path as-is.
        const cliPath = (config.get<string>('cliPath', 'jpipe') ?? 'jpipe').trim();
        if (path.isAbsolute(cliPath) || cliPath.includes(path.sep)) {
            return `"${path.normalize(cliPath)}"`;
        }
        try {
            const { stdout } = await execAsync(`which ${cliPath}`, { env: envWithPath() });
            const cliCmd = stdout.trim();
            this.logger.debug(`Resolved CLI '${cliPath}' → ${cliCmd}`);
            return `"${cliCmd}"`;
        } catch {
            this.logger.debug(`'which ${cliPath}' failed, using bare name`);
            return `"${cliPath}"`;
        }
    }

    /** Build the `"java" [jvmArgs…] -jar "<jar>"` prefix shared by the `jar` and `managed` modes. */
    private buildJarPrefix(config: vscode.WorkspaceConfiguration, jarFile: string): string {
        const javaExecutable = (config.get<string>('javaExecutable', 'java') ?? 'java').trim();
        const jvmArgs = (config.get<string[]>('jvmArgs', []) ?? []).filter(Boolean);
        const argsPart = jvmArgs.length ? ` ${jvmArgs.join(' ')}` : '';
        return `"${javaExecutable}"${argsPart} -jar "${path.normalize(jarFile)}"`;
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
        const inputArg = `-i "${path.normalize(inputFile)}"`;
        const modelArg = `-m ${diagramName}`;
        const formatArg = `-f ${format.toString().toUpperCase()}`;

        let command: string;
        try {
            const prefix = await this.resolveExecPrefix(config);
            command = `${prefix} process ${inputArg} ${modelArg} ${formatArg}`;
        } catch (e: any) {
            vscode.window.showErrorMessage(e.message);
            throw e;
        }

        this.lastExportUri = undefined;
        if (saveToFile) {
            const outputPath = await this.promptForSaveLocation(document, diagramName, format);
            if (!outputPath) {
                const e = new Error('Save cancelled') as Error & { cancelled?: boolean };
                e.cancelled = true;
                throw e;
            }
            command += ` -o "${outputPath.fsPath}"`;
            this.lastExportUri = outputPath;
        }

        this.logger.info(`Executing: ${command}`);

        try {
            const { stdout } = await execAsync(command, { env: envWithPath(), timeout: timeoutMs(config) });
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

        let command: string;
        try {
            const prefix = await this.resolveExecPrefix(config);
            command = `${prefix} --headless doctor`;
        } catch (e: any) {
            return { ok: false, message: e.message };
        }

        try {
            const { stdout, stderr } = await execAsync(command, { env: envWithPath(), timeout: timeoutMs(config) });
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
        const inputArg = `-i "${inputFile}"`;

        let command: string;
        try {
            const prefix = await this.resolveExecPrefix(config);
            command = `${prefix} diagnostic ${inputArg}`;
        } catch (e: any) {
            return e.message;
        }

        this.logger.info(`Executing: ${command}`);
        try {
            const { stdout, stderr } = await execAsync(command, { env: envWithPath(), timeout: timeoutMs(config) });
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
        const lines = document.getText().split('\n');
        const cursorLine = editor?.selection.active.line ?? 0;
        
        let diagramName: string | undefined;
        
        for (let i = 0; i <= cursorLine && i < lines.length; i++) {
            const match = /^\s*(justification|template)\s+(\w+)/i.exec(lines[i]);
            if (match) {
                diagramName = match[2];
            }
        }
        
        if (!diagramName) {
            throw new Error('No diagram name found (justification or template declaration)');
        }
        
        return diagramName;
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
