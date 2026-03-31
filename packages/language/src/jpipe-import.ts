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
 * Import service for handling imports and resolving imported documents, templates, and elements.
 */
export class JpipeImportService {
    private readonly services: JpipeServices;

    public constructor(services: JpipeServices) {
        this.services = services;
    }

    resolveImport(filePath: string, currentDoc: LangiumDocument): LangiumDocument | undefined {
        const cleanPath = filePath.replace(/^["']|["']$/g, '');
        const currentUnit = currentDoc.parseResult.value as Unit | undefined;
        if (!currentUnit) {
            return undefined;
        }
        
        const isExplicitlyLoaded = currentUnit.imports.some(
            load => load.filePath.replace(/^["']|["']$/g, '') === cleanPath
        );
        if (!isExplicitlyLoaded) {
            return undefined;
        }
        

        // handles path resolution and document parsing
        return this.parseDocumentFromPath(cleanPath, currentDoc);
    }

    /**
     * Resolve a file path relative to `relativeToDoc` and parse it, without enforcing
     * "explicitly loaded by the root document" (used for transitive import traversal).
     */
    private parseTransitiveImport(filePath: string, relativeToDoc: LangiumDocument): LangiumDocument | undefined {
        const cleanPath = filePath.replace(/^["']|["']$/g, '');
        return this.parseDocumentFromPath(cleanPath, relativeToDoc);
    }

    parseDocumentFromPath(filePath: string, relativeToDoc?: LangiumDocument): LangiumDocument | undefined {
        let resolvedPath = filePath;
        
        // if we have a relative path and a reference document, resolve it
        if (relativeToDoc && !path.isAbsolute(filePath)) {
            const currentUri = URI.parse(relativeToDoc.uri.toString());
            const currentDir = path.dirname(currentUri.path);
            resolvedPath = path.resolve(currentDir, filePath);
        } else if (!path.isAbsolute(filePath)) {
            // if no reference document and not absolute, assume it's already resolved
            resolvedPath = filePath;
        }
        
        const resolvedUri = URI.file(resolvedPath);
        const existingDoc = this.services.shared.workspace.LangiumDocuments.getDocument(resolvedUri);
        if (existingDoc) {
            return existingDoc;
        }
        
        if (!fs.existsSync(resolvedPath)) {
            return undefined;
        }
        
        try {
            const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
            const docFactory = this.services.shared.workspace.LangiumDocumentFactory;
            const doc = docFactory.fromString(fileContent, resolvedUri);
            const parser = this.services.parser.LangiumParser;
            doc.parseResult = parser.parse(fileContent);
            
            if (doc.parseResult.value) {
                this.setDocumentOnAllNodes(doc.parseResult.value, doc);
            }
            
            return doc;
        } catch (error) {
            return undefined;
        }
    }

    private setDocumentOnAllNodes(node: AstNode, document: LangiumDocument): void {
        (node as any).$document = document;
        AstUtils.streamAst(node).forEach(child => {
            (child as any).$document = document;
        });
    }

    getImportedTemplates(unit: Unit, currentDoc: LangiumDocument): Template[] {
        const importedDocs = this.getTransitiveImportedDocuments(unit, currentDoc);
        const templates: Template[] = [];
        for (const doc of importedDocs) {
            const importedUnit = doc.parseResult.value as Unit | undefined;
            if (importedUnit) {
                templates.push(...this.getLocalTemplates(importedUnit));
            }
        }
        return templates;
    }

    getImportedElements(unit: Unit, currentDoc: LangiumDocument): JustificationElement[] {
        return this.getElementsFromImportsTransitive(unit, currentDoc, isJustification);
    }

    getImportedTemplateElements(unit: Unit, currentDoc: LangiumDocument): JustificationElement[] {
        return this.getElementsFromImportsTransitive(unit, currentDoc, isTemplate);
    }

    private getElementsFromImportsTransitive(
        unit: Unit,
        currentDoc: LangiumDocument,
        filterFn: (body: any) => boolean
    ): JustificationElement[] {
        const importedDocs = this.getTransitiveImportedDocuments(unit, currentDoc);
        const elements: JustificationElement[] = [];
        for (const doc of importedDocs) {
            const importedUnit = doc.parseResult.value as Unit | undefined;
            if (importedUnit) {
                elements.push(...this.getElementsFromImportedUnit(importedUnit, filterFn));
            }
        }
        return elements;
    }

    /**
     * Traverse `load` edges starting from the current unit:
     * - Start from direct loads of `currentDoc` (must be explicitly loaded by the root doc)
     * - Then follow loads found inside imported docs (transitively), resolving relative to each doc
     *
     * This is a BFS over the import graph, bounded by a visited set.
     */
    private getTransitiveImportedDocuments(unit: Unit, currentDoc: LangiumDocument): LangiumDocument[] {
        const out: LangiumDocument[] = [];
        const visited = new Set<string>();

        const enqueue: LangiumDocument[] = [];
        for (const load of unit.imports) {
            const doc = this.resolveImport(load.filePath, currentDoc);
            const uri = doc?.uri?.toString();
            if (doc && uri && !visited.has(uri)) {
                visited.add(uri);
                enqueue.push(doc);
                out.push(doc);
            }
        }

        // Follow transitive loads (BFS)
        for (let i = 0; i < enqueue.length; i++) {
            const doc = enqueue[i];
            const u = doc.parseResult.value as Unit | undefined;
            if (!u) continue;
            for (const load of u.imports) {
                const nextDoc = this.parseTransitiveImport(load.filePath, doc);
                const uri = nextDoc?.uri?.toString();
                if (nextDoc && uri && !visited.has(uri)) {
                    visited.add(uri);
                    enqueue.push(nextDoc);
                    out.push(nextDoc);
                }
            }
        }

        return out;
    }

    private getElementsFromImportedUnit(
        importedUnit: Unit,
        filterFn: (body: any) => boolean
    ): JustificationElement[] {
        const elements: JustificationElement[] = [];
        for (const body of importedUnit.body) {
            if (filterFn(body)) {
                // Only process Justification or Template
                if (isJustification(body) || isTemplate(body)) {
                    elements.push(...getAllElements(body));
                }
            }
        }
        return elements;
    }

    private getLocalTemplates(unit: Unit): Template[] {
        return unit.body.filter((b): b is Template => isTemplate(b));
    }
}

