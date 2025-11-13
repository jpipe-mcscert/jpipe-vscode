import { URI, type LangiumDocument, AstUtils, type AstNode } from 'langium';
import type { JpipeServices } from './jpipe-module.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
    isJustification,
    isTemplate,
    type Template,
    type JustificationElement,
    type Unit
} from './generated/ast.js';
import { getAllElements } from './jpipe-utils.js';

/**
 * Service for handling imports and resolving imported documents, templates, and elements.
 */
export class JpipeImportService {
    private readonly services: JpipeServices;

    public constructor(services: JpipeServices) {
        this.services = services;
    }

    private debugLog(message: string, ...args: any[]) {
        const fullMessage = `[IMPORT-DEBUG] ${message}`;
        // Try to use LSP connection console if available, otherwise fall back to console.error
        if (this.services.shared?.lsp?.Connection) {
            if (args.length > 0) {
                this.services.shared.lsp.Connection.console.log(fullMessage + ' ' + args.map(a => String(a)).join(' '));
            } else {
                this.services.shared.lsp.Connection.console.log(fullMessage);
            }
        } else {
            console.error(fullMessage, ...args);
        }
    }

    /**
     * Resolve an import file path to a Langium document.
     * ONLY resolves files that are explicitly listed in load statements.
     * This method checks that the file path exactly matches one from unit.imports.
     * 
     * IMPORTANT: This method should ONLY be called with file paths from unit.imports.
     * Do not call this with arbitrary file paths from the workspace.
     * 
     * Reads the file directly from the file system using Langium's FileSystemProvider.
     * Uses the WorkspaceManager to ensure the document is loaded.
     * 
     * @param filePath The file path from the import statement (MUST be from unit.imports)
     * @param currentDoc The current document making the import
     * @returns The resolved document, or undefined if not found or not explicitly loaded
     */
    resolveImport(filePath: string, currentDoc: LangiumDocument): LangiumDocument | undefined {
        this.debugLog('resolveImport called with filePath:', filePath);
        
        // Remove quotes from filePath string
        const cleanPath = filePath.replace(/^["']|["']$/g, '');
        this.debugLog('cleanPath:', cleanPath);
        
        // Get the current unit to verify this import is explicitly declared
        const currentUnit = currentDoc.parseResult.value as Unit | undefined;
        if (!currentUnit) {
            this.debugLog('ERROR: No currentUnit found');
            return undefined;
        }
        
        // Verify this file path is actually in the unit's imports
        const isExplicitlyLoaded = currentUnit.imports.some(
            load => load.filePath.replace(/^["']|["']$/g, '') === cleanPath
        );
        if (!isExplicitlyLoaded) {
            this.debugLog('REJECTED: File not in unit.imports');
            return undefined;
        }
        this.debugLog('PASSED: File is explicitly loaded');
        
        // Resolve relative path to absolute path
        const currentUri = URI.parse(currentDoc.uri.toString());
        const currentDir = path.dirname(currentUri.path);
        const resolvedPath = path.resolve(currentDir, cleanPath);
        this.debugLog('Resolving relative path:', cleanPath, 'from', currentDir, '->', resolvedPath);
        
        // Check if file exists and read it
        if (!fs.existsSync(resolvedPath)) {
            this.debugLog('ERROR: File does not exist:', resolvedPath);
            return undefined;
        }
        
        try {
            // Read file content synchronously from file system
            const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
            this.debugLog('File read successfully, length:', fileContent.length);
            
            // Create document and parse it
            const resolvedUri = URI.file(resolvedPath);
            const docFactory = this.services.shared.workspace.LangiumDocumentFactory;
            const doc = docFactory.fromString(fileContent, resolvedUri);
            const parser = this.services.parser.LangiumParser;
            doc.parseResult = parser.parse(fileContent);
            
            // CRITICAL: Set $document property on all AST nodes
            // This is required for scope resolution and linking to work correctly
            if (doc.parseResult.value) {
                this.setDocumentOnAllNodes(doc.parseResult.value, doc);
            }
            
            this.debugLog('SUCCESS: Document parsed from file system');
            return doc;
        } catch (error) {
            this.debugLog('ERROR reading/parsing file:', String(error));
            return undefined;
        }
    }

    /**
     * Recursively set $document property on all AST nodes.
     * This is required for nodes to be properly linked and scoped.
     */
    private setDocumentOnAllNodes(node: AstNode, document: LangiumDocument): void {
        // Set $document on this node
        (node as any).$document = document;
        
        // Recursively process all child nodes
        AstUtils.streamAst(node).forEach(child => {
            (child as any).$document = document;
        });
    }

    /**
     * Get all templates from imported files.
     * Only includes templates from files explicitly listed in load statements.
     * @param unit The unit containing import statements (only uses unit.imports)
     * @param currentDoc The current document making the imports
     * @returns Array of all templates from explicitly imported files only
     */
    getImportedTemplates(unit: Unit, currentDoc: LangiumDocument): Template[] {
        this.debugLog('getImportedTemplates called, imports count:', unit.imports.length);
        const templates: Template[] = [];
        // Only iterate through explicitly declared load statements
        for (const load of unit.imports) {
            this.debugLog('Processing import:', load.filePath);
            const importedDoc = this.resolveImport(load.filePath, currentDoc);
            if (importedDoc) {
                this.debugLog('Import resolved successfully, getting templates');
                const importedUnit = importedDoc.parseResult.value as Unit;
                if (importedUnit) {
                    // Only get templates from this explicitly loaded file
                    const localTemplates = this.getLocalTemplates(importedUnit);
                    this.debugLog('Found', localTemplates.length, 'templates in imported file');
                    templates.push(...localTemplates);
                } else {
                    this.debugLog('ERROR: No importedUnit found');
                }
            } else {
                this.debugLog('Import resolution failed for:', load.filePath);
            }
        }
        this.debugLog('getImportedTemplates returning', templates.length, 'templates');
        return templates;
    }

    /**
     * Get all justification elements from imported files.
     * @param unit The unit containing import statements
     * @param currentDoc The current document making the imports
     * @returns Array of all justification elements from imported files
     */
    getImportedElements(unit: Unit, currentDoc: LangiumDocument): JustificationElement[] {
        return this.getElementsFromImports(unit, currentDoc, isJustification);
    }

    /**
     * Get all template elements from imported files.
     * @param unit The unit containing import statements
     * @param currentDoc The current document making the imports
     * @returns Array of all template elements from imported files
     */
    getImportedTemplateElements(unit: Unit, currentDoc: LangiumDocument): JustificationElement[] {
        return this.getElementsFromImports(unit, currentDoc, isTemplate);
    }

    /**
     * Helper: Get elements from imported files, filtered by a predicate.
     * Only includes elements from files explicitly listed in load statements.
     * @param unit The unit containing import statements (only uses unit.imports)
     * @param currentDoc The current document making the imports
     * @param filterFn Function to filter body elements (e.g., isJustification or isTemplate)
     * @returns Array of filtered elements from explicitly imported files only
     */
    private getElementsFromImports(
        unit: Unit,
        currentDoc: LangiumDocument,
        filterFn: (body: any) => boolean
    ): JustificationElement[] {
        this.debugLog('getElementsFromImports called, imports count:', unit.imports.length);
        const elements: JustificationElement[] = [];
        // Only iterate through explicitly declared load statements
        for (const load of unit.imports) {
            this.debugLog('Processing import for elements:', load.filePath);
            const importedDoc = this.resolveImport(load.filePath, currentDoc);
            if (importedDoc) {
                this.debugLog('Import resolved successfully, getting elements');
                const importedUnit = importedDoc.parseResult.value as Unit;
                if (importedUnit) {
                    // Only get elements from this explicitly loaded file
                    const importedElems = this.getElementsFromImportedUnit(importedUnit, filterFn);
                    this.debugLog('Found', importedElems.length, 'elements in imported file');
                    elements.push(...importedElems);
                } else {
                    this.debugLog('ERROR: No importedUnit found');
                }
            } else {
                this.debugLog('Import resolution failed for:', load.filePath);
            }
        }
        this.debugLog('getElementsFromImports returning', elements.length, 'elements');
        return elements;
    }

    /**
     * Helper: Get all elements from an imported unit, filtered by a predicate.
     * This function uses getAllElements to include inherited elements from parent templates.
     * @param importedUnit The imported unit
     * @param filterFn Function to filter body elements (e.g., isJustification or isTemplate)
     * @returns Array of filtered elements including inherited ones
     */
    private getElementsFromImportedUnit(
        importedUnit: Unit,
        filterFn: (body: any) => boolean
    ): JustificationElement[] {
        const elements: JustificationElement[] = [];
        for (const body of importedUnit.body) {
            if (filterFn(body)) {
                // Use getAllElements to include inherited elements from parent templates
                const bodyElems = getAllElements(body);
                elements.push(...bodyElems);
            }
        }
        return elements;
    }

    /**
     * Helper: Get local templates from a unit.
     * @param unit The unit to extract templates from
     * @returns Array of local templates
     */
    private getLocalTemplates(unit: Unit): Template[] {
        return unit.body.filter((b): b is Template => isTemplate(b));
    }
}

