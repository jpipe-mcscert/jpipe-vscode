import { stream, type Stream, URI } from 'langium';
import type { AstNodeDescription, ReferenceInfo, LangiumDocument } from 'langium';
import { DefaultCompletionProvider, type CompletionContext, type CompletionValueItem } from 'langium/lsp';
import { Position, type TextEdit } from 'vscode-languageserver';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { JpipeServices } from './jpipe-module.js';
import { isJustification, isTemplate, isRelation, type Unit } from './generated/ast.js';
import { getAllElements } from './jpipe-utils.js';

/**
 * A custom completion provider that includes elements from all workspace files,
 * not just imported ones. Automatically adds load statements when needed.
 */
export class JpipeCompletionProvider extends DefaultCompletionProvider {
    private readonly services: JpipeServices;

    public constructor(services: JpipeServices) {
        super(services);
        this.services = services;
    }

    private get importService() {
        return this.services.references.JpipeImportService;
    }

    protected override getReferenceCandidates(refInfo: ReferenceInfo, context: CompletionContext): Stream<AstNodeDescription> {
        const defaultCandidates = super.getReferenceCandidates(refInfo, context);
        
        try {
            const currentUnit = context.document.parseResult.value as Unit | undefined;
            if (!currentUnit) {
                return defaultCandidates;
            }

            const workspaceElements = this.getWorkspaceElements(context.document, refInfo);
            if (workspaceElements.length === 0) {
                return defaultCandidates;
            }

            const workspaceDescriptions = workspaceElements.map(el => el.description);
            return stream(defaultCandidates)
                .concat(stream(workspaceDescriptions))
                .distinct(desc => `${desc.type}_${desc.name}_${desc.documentUri}`);
        } catch (error) {
            return defaultCandidates;
        }
    }

    private getWorkspaceElements(currentDoc: LangiumDocument, refInfo: ReferenceInfo): Array<{ description: AstNodeDescription; sourceFile: string; isImported: boolean }> {
        const elements: Array<{ description: AstNodeDescription; sourceFile: string; isImported: boolean }> = [];
        const currentUnit = currentDoc.parseResult.value as Unit | undefined;
        if (!currentUnit) {
            return elements;
        }

        try {
            const currentPath = URI.parse(typeof currentDoc.uri === 'string' ? currentDoc.uri : currentDoc.uri.toString()).path;
            const currentDir = path.dirname(currentPath);

            // Scan current directory and its subdirectories (depth 2)
            const files = this.scanDirectoryRecursive(currentDir, 2);
            
            // Also scan sibling directories (same level as current directory) with depth 1
            const parentDir = path.dirname(currentDir);
            if (parentDir !== currentDir) {
                try {
                    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isDirectory() && !['node_modules', '.git', 'out', 'dist', 'build', '.vscode'].includes(entry.name)) {
                            const siblingDir = path.join(parentDir, entry.name);
                            if (siblingDir !== currentDir) {
                                files.push(...this.scanDirectoryRecursive(siblingDir, 1));
                            }
                        }
                    }
                } catch (error) {
                }
            }

            for (const filePath of files) {
                if (filePath === currentPath) continue;

                try {
                    // Use import service to parse the document
                    const doc = this.importService.parseDocumentFromPath(filePath, currentDoc);
                    if (!doc?.parseResult.value) continue;

                    const unit = doc.parseResult.value as Unit;
                    const relativePath = this.getRelativePath(currentPath, filePath);
                    const normalizedRelativePath = this.normalizePathForComparison(relativePath);
                    const isImported = currentUnit.imports.some(load => 
                        this.normalizePathForComparison(load.filePath) === normalizedRelativePath
                    );

                    for (const body of unit.body) {
                        // For 'parent' property, only include Templates
                        if (refInfo.property === 'parent' && isTemplate(body)) {
                            try {
                                const description = this.services.workspace.AstNodeDescriptionProvider.createDescription(body, body.name);
                                if (description) {
                                    elements.push({ description, sourceFile: relativePath, isImported });
                                }
                            } catch (error) {
                                continue;
                            }
                        }
                        // For Relation properties (from/to), include all nested elements from justifications and templates
                        else if ((refInfo.property === 'from' || refInfo.property === 'to') && isRelation(refInfo.container) && (isJustification(body) || isTemplate(body))) {
                            try {
                                // Get all nested elements (Strategy, Evidence, etc.) from this justification/template
                                const nestedElements = getAllElements(body);
                                for (const element of nestedElements) {
                                    try {
                                        const description = this.services.workspace.AstNodeDescriptionProvider.createDescription(element, element.name);
                                        if (description) {
                                            elements.push({ description, sourceFile: relativePath, isImported });
                                        }
                                    } catch (error) {
                                        continue;
                                    }
                                }
                            } catch (error) {
                                continue;
                            }
                        }
                        // include top-level Justifications and Templates
                        else if (refInfo.property !== 'parent' && refInfo.property !== 'from' && refInfo.property !== 'to' && (isJustification(body) || isTemplate(body))) {
                            try {
                                const description = this.services.workspace.AstNodeDescriptionProvider.createDescription(body, body.name);
                                if (description) {
                                    elements.push({ description, sourceFile: relativePath, isImported });
                                }
                            } catch (error) {
                                continue;
                            }
                        }
                    }
                } catch (error) {
                    // files that can't be parsed
                    continue;
                }
            }
        } catch (error) {
            // return empty array to fall back to default completions
            return elements;
        }

        return elements;
    }

    private scanDirectoryRecursive(dir: string, maxDepth: number): string[] {
        const files: string[] = [];
        const ignoredDirs = ['node_modules', '.git', 'out', 'dist', 'build', '.vscode'];
        const visitedDirs = new Set<string>();
        
        const scan = (currentDir: string, depth: number): void => {
            if (depth <= 0) return;
            
            //  avoid duplicate scans
            const normalizedDir = path.resolve(currentDir);
            if (visitedDirs.has(normalizedDir)) {
                return;
            }
            visitedDirs.add(normalizedDir);
            
            try {
                const entries = fs.readdirSync(currentDir, { withFileTypes: true });
                
                for (const entry of entries) {
                    try {
                        if (entry.isFile() && entry.name.endsWith('.jd')) {
                            files.push(path.join(currentDir, entry.name));
                        } else if (entry.isDirectory() && !ignoredDirs.includes(entry.name)) {
                            scan(path.join(currentDir, entry.name), depth - 1);
                        }
                    } catch (error) {
                        //skip entries that cause errors
                        continue;
                    }
                }
            } catch (error) {
               
            }
        };
        
        try {
            scan(dir, maxDepth); //max depth as a placeholder right now, infinite scans break. i need help!
        } catch (error) {
        }
        
        return files;
    }


    private getRelativePath(sourcePath: string, targetPath: string): string {
        const relative = path.relative(path.dirname(sourcePath), targetPath).replace(/\\/g, '/');
        return relative.startsWith('../') ? relative : `./${relative}`;
    }

    private normalizePathForComparison(filePath: string): string {
        return filePath
            .replace(/^["']|["']$/g, '')  // remove quotes
            .replace(/^\.\//, '')         // remove leading ./
            .replace(/\\/g, '/');         // make slashes work
    }

    protected override createReferenceCompletionItem(
        nodeDescription: AstNodeDescription,
        refInfo: ReferenceInfo,
        context: CompletionContext
    ): CompletionValueItem {
        const baseItem = super.createReferenceCompletionItem(nodeDescription, refInfo, context);
        
        const elementInfo = this.findElementInfo(context.document, nodeDescription);
        if (!elementInfo) return baseItem;

        if (!elementInfo.isImported && elementInfo.sourceFile) {
            const fileName = path.basename(elementInfo.sourceFile);
            return {
                ...baseItem,
                detail: fileName,
                additionalTextEdits: this.createLoadEdit(context.document, elementInfo.sourceFile)
            };
        } else if (elementInfo.isImported) {
            return { ...baseItem, detail: path.basename(elementInfo.sourceFile) };
        }

        return baseItem;
    }

    private findElementInfo(currentDoc: LangiumDocument, nodeDescription: AstNodeDescription): { sourceFile: string; isImported: boolean } | undefined {
        const documentUri = nodeDescription.documentUri;
        if (!documentUri) return undefined;

        const currentUnit = currentDoc.parseResult.value as Unit | undefined;
        if (!currentUnit) return undefined;

        const currentUri = typeof currentDoc.uri === 'string' ? currentDoc.uri : currentDoc.uri.toString();
        const targetUri = typeof documentUri === 'string' ? documentUri : documentUri.toString();
        
        // if the element is from the current file, don't add a load statement
        // normalize URIs for comparison
        const currentPath = URI.parse(currentUri).path;
        const targetPath = URI.parse(targetUri).path;
        
        if (currentPath === targetPath) {
            return undefined;
        }
        
        const relativePath = this.getRelativePath(currentPath, targetPath);

        const normalizedRelativePath = this.normalizePathForComparison(relativePath);
        const isImported = currentUnit.imports.some(load => 
            this.normalizePathForComparison(load.filePath) === normalizedRelativePath
        );

        return { sourceFile: relativePath, isImported };
    }

    private createLoadEdit(document: LangiumDocument, relativePath: string): TextEdit[] | undefined {
        const currentUnit = document.parseResult.value as Unit | undefined;
        if (!currentUnit) return undefined;

        // Check if this path is already imported using normalized comparison
        const normalizedRelativePath = this.normalizePathForComparison(relativePath);
        const alreadyImported = currentUnit.imports.some(load => 
            this.normalizePathForComparison(load.filePath) === normalizedRelativePath
        );
        
        if (alreadyImported) {
            return undefined;
        }

        const text = document.textDocument.getText();
        const lines = text.split('\n');
        let insertLine = 0;
        let lastLoadLine = -1;
        let hasExistingLoads = false;
        
        // Find the last load statement, or determine where to insert at the top
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed.startsWith('load ')) {
                hasExistingLoads = true;
                lastLoadLine = i;
                insertLine = i + 1;
            } else if (trimmed && !trimmed.startsWith('//') && lastLoadLine >= 0) {
                // Found non-comment, non-load line after load statements - insert after last load
                break;
            } else if (trimmed && !trimmed.startsWith('//') && lastLoadLine < 0) {
                // Found first non-comment, non-load line - insert before it
                insertLine = i;
                break;
            }
        }
        
        // If we never found a place to insert, insert at the top
        if (insertLine === 0 && lastLoadLine < 0) {
            insertLine = 0;
        }

        // Build the final path - keep relative paths as-is, add ./ prefix for same-directory files
        const finalPath = relativePath.startsWith('../') 
            ? relativePath 
            : `./${normalizedRelativePath}`;
        
        // Only add extra newline if this is the first load statement
        const newlineSuffix = hasExistingLoads ? '\n' : '\n\n';
        
        return [{
            range: { start: Position.create(insertLine, 0), end: Position.create(insertLine, 0) },
            newText: `load "${finalPath}"${newlineSuffix}`
        }];
    }
}

