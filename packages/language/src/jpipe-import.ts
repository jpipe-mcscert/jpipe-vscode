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

    /**
     * Resolve an import file path to a Langium document.
     * Only resolves files that are explicitly listed in load statements (unit.imports).
     * 
     * @param filePath The file path from the import statement (must be from unit.imports)
     * @param currentDoc The current document making the import
     * @returns The resolved document, or undefined if not found or not explicitly loaded
     */
    resolveImport(filePath: string, currentDoc: LangiumDocument): LangiumDocument | undefined {
        const cleanPath = filePath.replace(/^["']|["']$/g, '');
        const currentUnit = currentDoc.parseResult.value as Unit | undefined;
        if (!currentUnit) {
            return undefined;
        }
        
        // Verify this file path is explicitly declared in unit.imports
        const isExplicitlyLoaded = currentUnit.imports.some(
            load => load.filePath.replace(/^["']|["']$/g, '') === cleanPath
        );
        if (!isExplicitlyLoaded) {
            return undefined;
        }
        
        // Resolve relative path to absolute path
        const currentUri = URI.parse(currentDoc.uri.toString());
        const currentDir = path.dirname(currentUri.path);
        const resolvedPath = path.resolve(currentDir, cleanPath);
        
        if (!fs.existsSync(resolvedPath)) {
            return undefined;
        }
        
        try {
            const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
            const resolvedUri = URI.file(resolvedPath);
            const docFactory = this.services.shared.workspace.LangiumDocumentFactory;
            const doc = docFactory.fromString(fileContent, resolvedUri);
            const parser = this.services.parser.LangiumParser;
            doc.parseResult = parser.parse(fileContent);
            
            // Set $document property on all AST nodes for proper scope resolution and linking
            if (doc.parseResult.value) {
                this.setDocumentOnAllNodes(doc.parseResult.value, doc);
            }
            
            return doc;
        } catch (error) {
            return undefined;
        }
    }

    /**
     * Recursively set $document property on all AST nodes.
     * Required for proper scope resolution and linking.
     */
    private setDocumentOnAllNodes(node: AstNode, document: LangiumDocument): void {
        (node as any).$document = document;
        AstUtils.streamAst(node).forEach(child => {
            (child as any).$document = document;
        });
    }

    /**
     * Get all templates from imported files.
     * Only includes templates from files explicitly listed in load statements.
     */
    getImportedTemplates(unit: Unit, currentDoc: LangiumDocument): Template[] {
        const templates: Template[] = [];
        for (const load of unit.imports) {
            const importedDoc = this.resolveImport(load.filePath, currentDoc);
            if (importedDoc?.parseResult.value) {
                const importedUnit = importedDoc.parseResult.value as Unit;
                templates.push(...this.getLocalTemplates(importedUnit));
            }
        }
        return templates;
    }

    getImportedElements(unit: Unit, currentDoc: LangiumDocument): JustificationElement[] {
        return this.getElementsFromImports(unit, currentDoc, isJustification);
    }

    getImportedTemplateElements(unit: Unit, currentDoc: LangiumDocument): JustificationElement[] {
        return this.getElementsFromImports(unit, currentDoc, isTemplate);
    }

    /**
     * Get elements from imported files, filtered by a predicate.
     * Only includes elements from files explicitly listed in load statements.
     */
    private getElementsFromImports(
        unit: Unit,
        currentDoc: LangiumDocument,
        filterFn: (body: any) => boolean
    ): JustificationElement[] {
        const elements: JustificationElement[] = [];
        for (const load of unit.imports) {
            const importedDoc = this.resolveImport(load.filePath, currentDoc);
            if (importedDoc?.parseResult.value) {
                const importedUnit = importedDoc.parseResult.value as Unit;
                elements.push(...this.getElementsFromImportedUnit(importedUnit, filterFn));
            }
        }
        return elements;
    }

    /**
     * Get all elements from an imported unit, filtered by a predicate.
     * Uses getAllElements to include inherited elements from parent templates.
     */
    private getElementsFromImportedUnit(
        importedUnit: Unit,
        filterFn: (body: any) => boolean
    ): JustificationElement[] {
        const elements: JustificationElement[] = [];
        for (const body of importedUnit.body) {
            if (filterFn(body)) {
                elements.push(...getAllElements(body));
            }
        }
        return elements;
    }

    private getLocalTemplates(unit: Unit): Template[] {
        return unit.body.filter((b): b is Template => isTemplate(b));
    }
}

