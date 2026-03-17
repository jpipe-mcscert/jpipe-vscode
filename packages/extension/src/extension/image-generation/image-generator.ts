import * as vscode from 'vscode';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';

const execAsync = promisify(exec);

export class ImageGenerator {
    
    constructor() {}
    
    /**
     * Generate SVG from the active jpipe file or provided document
     * @param saveToFile If true, prompts user for save location
     * @param document Optional document to use instead of active editor
     * @returns The SVG content as a string
     */
    public async generate(saveToFile: boolean = false, document?: vscode.TextDocument): Promise<string> {
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
        const cliPath = config.get<string>('cliPath', 'jpipe');
        const jarFile = config.get<string>('jarFile', '');
        const javaVersion = config.get<string>('setJavaVersion', 'java');
        
        const hasJar = jarFile && jarFile.trim() !== '';
        
        if (!cliPath && !hasJar) {
            vscode.window.showErrorMessage('Please configure a location for CLI or JAR file for jPipe!');
            throw new Error('No jPipe executable configured. Please set jpipe.cliPath or jpipe.jarFile in settings.');
        }
        
        let command: string;
        
        if (cliPath && cliPath.trim() !== '') {
            command = `sh "${cliPath}" -i "${path.normalize(inputFile)}" -d ${diagramName} -f SVG`;
        } else if (hasJar) {
            if (fs.existsSync(jarFile)) {
                command = `${javaVersion} -jar "${path.normalize(jarFile)}" -i "${path.normalize(inputFile)}" -d ${diagramName} -f SVG`;
            } else {
                vscode.window.showErrorMessage(`JAR file not found: ${jarFile}`);
                throw new Error(`JAR file not found: ${jarFile}`);
            }
        } else {
            vscode.window.showErrorMessage('Please configure a location for CLI or JAR file for jPipe!');
            throw new Error('No jPipe executable configured. Please set jpipe.cliPath or jpipe.jarFile in settings.');
        }
        
        if (saveToFile) {
            const outputPath = await this.promptForSaveLocation(diagramName);
            if (outputPath) {
                command += ` -o "${outputPath.fsPath}"`;
            }
        }
        
        console.log('[jPipe] Executing command:', command);
        
        try {
            const { stdout } = await execAsync(command);
            console.log('[jPipe] Generated SVG successfully');
            return stdout;
        } catch (error: any) {
            console.error('[jPipe] Error generating SVG:', error);
            throw new Error(`Failed to generate SVG: ${error.message}`);
        }
    }
    
    /**
     * Generate and save SVG file
     */
    public async generateAndSave(): Promise<void> {
        try {
            await this.generate(true);
            vscode.window.showInformationMessage('SVG saved successfully');
        } catch (error: any) {
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
    private async promptForSaveLocation(diagramName: string): Promise<vscode.Uri | undefined> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return undefined;
        
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        const defaultUri = workspaceFolder 
            ? vscode.Uri.joinPath(workspaceFolder.uri, `${diagramName}.svg`)
            : vscode.Uri.file(`${diagramName}.svg`);
        
        return await vscode.window.showSaveDialog({
            defaultUri: defaultUri,
            saveLabel: 'Save SVG',
            filters: {
                'SVG': ['svg']
            }
        });
    }
}
