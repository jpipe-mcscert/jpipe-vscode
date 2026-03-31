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
    PNG = 'PNG',
    SVG = 'SVG',
    JSON = 'JSON',
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
        const cliPath = (config.get<string>('cliPath', 'jpipe') ?? '').trim();
        const jarFile = expandTilde((config.get<string>('jarFile', '') ?? '').trim());
        const javaVersion = config.get<string>('setJavaVersion', 'java');
        
        const hasJar = (config.get<string>('jarFile', '') ?? '').trim().length > 0;
        const hasCliPath = cliPath.length > 0;
        const cliPathIsAbsolute = hasCliPath && (path.isAbsolute(cliPath) || cliPath.includes(path.sep));

        const useCli = hasCliPath || !hasJar;
        const useJar = hasJar;

        if (!useCli && !useJar) {
            vscode.window.showErrorMessage('Please configure a location for CLI or JAR file for jPipe!');
            throw new Error('No jPipe executable configured. Please set jpipe.cliPath or jpipe.jarFile in settings.');
        }

        let command: string;
        const formatFlag = format.toString().toUpperCase();
        const inputArg = `-i "${path.normalize(inputFile)}"`;
        const diagramArg = `-d ${diagramName}`;
        const formatArg = `-f ${formatFlag}`;

        if (useCli && (!useJar || hasCliPath)) {
            let cliCmd: string;
            if (cliPathIsAbsolute) {
                cliCmd = path.normalize(cliPath);
            } else {
                const bareName = (hasCliPath ? cliPath : 'jpipe').trim();
                try {
                    const { stdout } = await execAsync(`which ${bareName}`, { env: envWithPath() });
                    cliCmd = stdout.trim();
                } catch {
                    cliCmd = bareName;
                }
            }
            command = `"${cliCmd}" ${inputArg} ${diagramArg} ${formatArg}`;
        } else if (useJar) {
            if (!fs.existsSync(jarFile)) {
                vscode.window.showErrorMessage(`JAR file not found: ${jarFile}`);
                throw new Error(`JAR file not found: ${jarFile}`);
            }
            command = `${javaVersion} -jar "${path.normalize(jarFile)}" ${inputArg} ${diagramArg} ${formatArg}`;
        } else {
            vscode.window.showErrorMessage('Please configure a location for CLI or JAR file for jPipe!');
            throw new Error('No jPipe executable configured. Please set jpipe.cliPath or jpipe.jarFile in settings.');
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
        const extension = format.toString().toLowerCase();
        const defaultUri = workspaceFolder 
            ? vscode.Uri.joinPath(workspaceFolder.uri, `${diagramName}.${extension}`)
            : vscode.Uri.file(`${diagramName}.${extension}`);
        
        return await vscode.window.showSaveDialog({
            defaultUri: defaultUri,
            saveLabel: 'Save model'
        });
    }
}
