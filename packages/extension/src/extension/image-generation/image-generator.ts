import * as vscode from 'vscode';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const execAsync = promisify(exec);

/** Expand leading ~ to the user's home directory (Node does not do this by default). */
function expandTilde(filePath: string): string {
    const home = os.homedir();
    if (filePath === '~') return home;
    if (filePath.startsWith('~/') || filePath.startsWith('~\\')) return path.join(home, filePath.slice(2));
    return filePath;
}

/** PATH that includes Homebrew so script shebangs (e.g. #!/usr/bin/env python3) can find interpreters. */
function envWithPath(): NodeJS.ProcessEnv {
    const prefix = '/opt/homebrew/bin:/usr/local/bin:';
    const existing = process.env.PATH ?? '';
    return { ...process.env, PATH: prefix + existing };
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
    
    constructor() {}
    
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
        document?: vscode.TextDocument
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
        const diagramName = this.findDiagramName(document, editor);
        
        const config = vscode.workspace.getConfiguration('jpipe');
        const mode = config.get<string>('executionMode', 'cli');

        let command: string;
        const inputArg = `-i "${path.normalize(inputFile)}"`;
        const modelArg = `-m ${diagramName}`;
        const formatArg = `-f ${format.toString().toUpperCase()}`;

        if (mode === 'jar') {
            const jarFile = expandTilde((config.get<string>('jarFile', '') ?? '').trim());
            const javaExecutable = (config.get<string>('javaExecutable', 'java') ?? 'java').trim();
            if (!jarFile) {
                vscode.window.showErrorMessage('Please set jpipe.jarFile in settings.');
                throw new Error('jpipe.jarFile is not configured.');
            }
            if (!fs.existsSync(jarFile)) {
                vscode.window.showErrorMessage(`JAR file not found: ${jarFile}`);
                throw new Error(`JAR file not found: ${jarFile}`);
            }
            command = `"${javaExecutable}" -jar "${path.normalize(jarFile)}" process ${inputArg} ${modelArg} ${formatArg}`;
        } else {
            const cliPath = (config.get<string>('cliPath', 'jpipe') ?? 'jpipe').trim();
            let cliCmd: string;
            if (path.isAbsolute(cliPath) || cliPath.includes(path.sep)) {
                cliCmd = path.normalize(cliPath);
            } else {
                try {
                    const { stdout } = await execAsync(`which ${cliPath}`, { env: envWithPath() });
                    cliCmd = stdout.trim();
                } catch {
                    cliCmd = cliPath;
                }
            }
            command = `"${cliCmd}" process ${inputArg} ${modelArg} ${formatArg}`;
        }
        
        if (saveToFile) {
            const outputPath = await this.promptForSaveLocation(document, diagramName, format);
            if (!outputPath) {
                const e = new Error('Save cancelled') as Error & { cancelled?: boolean };
                e.cancelled = true;
                throw e;
            }
            command += ` -o "${outputPath.fsPath}"`;
        }
        
        console.log('[jPipe] Executing command:', command);
        
        try {
            const { stdout } = await execAsync(command);
            console.log('[jPipe] Generated SVG successfully');
            return stdout;
        } catch (error: any) {
            console.error('[jPipe] Error generating SVG:', error);
            // Preserve stdout/stderr so the preview can still render a best-effort SVG (if any)
            // and show diagnostics inline instead of blanking the whole viewer.
            const e = new Error(`Failed to generate SVG: ${error.message}`) as Error & { stdout?: string; stderr?: string; exitCode?: number };
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
        const mode = config.get<string>('executionMode', 'cli');

        let command: string;
        if (mode === 'jar') {
            const jarFile = expandTilde((config.get<string>('jarFile', '') ?? '').trim());
            const javaExecutable = (config.get<string>('javaExecutable', 'java') ?? 'java').trim();
            if (!jarFile) return { ok: false, message: 'jpipe.jarFile is not configured.' };
            if (!fs.existsSync(jarFile)) return { ok: false, message: `JAR file not found: ${jarFile}` };
            command = `"${javaExecutable}" -jar "${path.normalize(jarFile)}" --headless doctor`;
        } else {
            const cliPath = (config.get<string>('cliPath', 'jpipe') ?? 'jpipe').trim();
            let cliCmd: string;
            if (path.isAbsolute(cliPath) || cliPath.includes(path.sep)) {
                cliCmd = path.normalize(cliPath);
            } else {
                try {
                    const { stdout } = await execAsync(`which ${cliPath}`, { env: envWithPath() });
                    cliCmd = stdout.trim();
                } catch {
                    cliCmd = cliPath;
                }
            }
            command = `"${cliCmd}" --headless doctor`;
        }

        try {
            const { stdout, stderr } = await execAsync(command, { env: envWithPath() });
            const output = (stdout + stderr).trim();
            return { ok: true, message: output || 'jPipe is accessible.' };
        } catch (error: any) {
            const detail = (error?.stderr ?? error?.stdout ?? error?.message ?? String(error)).trim();
            return { ok: false, message: `Cannot access jPipe: ${detail}` };
        }
    }

    public async generateAndSave(format: ImageFormat = ImageFormat.SVG, document?: vscode.TextDocument): Promise<void> {
        try {
            await this.generate(true, format, document);
            vscode.window.showInformationMessage(`${format} saved successfully`);
        } catch (error: any) {
            if (error?.cancelled === true || String(error?.message ?? '') === 'Save cancelled') {
                return;
            }
            vscode.window.showErrorMessage(error.message);
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
