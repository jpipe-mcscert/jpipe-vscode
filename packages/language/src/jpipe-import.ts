import { URI, type LangiumDocument, AstUtils, type AstNode } from 'langium';
import type { JpipeServices } from './jpipe-module.js';
import type { JpipeServerLogger } from './jpipe-logger.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
    isJustification,
    isTemplate,
    type Justification,
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
    private readonly logger: JpipeServerLogger;

    public constructor(services: JpipeServices) {
        this.services = services;
        this.logger = services.logger;
    }

    resolveImport(filePath: string, currentDoc: LangiumDocument): LangiumDocument | undefined {
        const cleanPath = filePath.replaceAll(/^["']|["']$/g, '');
        const currentUnit = currentDoc.parseResult.value as Unit | undefined;
        if (!currentUnit) {
            return undefined;
        }

        const isExplicitlyLoaded = currentUnit.imports.some(
            load => load.path.replaceAll(/^["']|["']$/g, '') === cleanPath
        );
        if (!isExplicitlyLoaded) {
            return undefined;
        }

        return this.parseDocumentFromPath(cleanPath, currentDoc);
    }

    /**
     * Resolve a file path relative to `relativeToDoc` and parse it, without enforcing
     * "explicitly loaded by the root document" (used for transitive import traversal).
     */
    private parseTransitiveImport(filePath: string, relativeToDoc: LangiumDocument): LangiumDocument | undefined {
        const cleanPath = filePath.replaceAll(/^["']|["']$/g, '');
        return this.parseDocumentFromPath(cleanPath, relativeToDoc);
    }

    parseDocumentFromPath(filePath: string, relativeToDoc?: LangiumDocument): LangiumDocument | undefined {
        let resolvedPath = filePath;

        if (relativeToDoc && !path.isAbsolute(filePath)) {
            const currentUri = URI.parse(relativeToDoc.uri.toString());
            const currentDir = path.dirname(currentUri.path);
            resolvedPath = path.resolve(currentDir, filePath);
        } else if (!path.isAbsolute(filePath)) {
            resolvedPath = filePath;
        }

        const resolvedUri = URI.file(resolvedPath);
        const existingDoc = this.services.shared.workspace.LangiumDocuments.getDocument(resolvedUri);
        if (existingDoc) {
            return existingDoc;
        }

        if (!fs.existsSync(resolvedPath)) {
            this.logger.warn(`Import not found: ${resolvedPath}`);
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

            this.logger.debug(`Parsed import: ${resolvedPath}`);
            return doc;
        } catch (error) {
            this.logger.error(`Failed to parse document: ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }

    private setDocumentOnAllNodes(node: AstNode, document: LangiumDocument): void {
        const assign = (n: AstNode) => { (n as unknown as Record<string, unknown>).$document = document; };
        assign(node);
        AstUtils.streamAst(node).forEach(assign);
    }

    getTemplatesWithNamespace(
        unit: Unit,
        currentDoc: LangiumDocument
    ): Array<{ template: Template; ns: string | undefined }> {
        const result: Array<{ template: Template; ns: string | undefined }> = [];
        for (const load of unit.imports) {
            const doc = this.parseDocumentFromPath(load.path, currentDoc);
            if (!doc) continue;
            const importedUnit = doc.parseResult.value as Unit | undefined;
            if (!importedUnit) continue;
            for (const body of importedUnit.body) {
                if (isTemplate(body)) {
                    result.push({ template: body, ns: load.namespace ?? undefined });
                }
            }
        }
        return result;
    }

    getJustificationsAndTemplatesWithNamespace(
        unit: Unit,
        currentDoc: LangiumDocument
    ): Array<{ node: Justification | Template; ns: string | undefined }> {
        const result: Array<{ node: Justification | Template; ns: string | undefined }> = [];
        for (const load of unit.imports) {
            const doc = this.parseDocumentFromPath(load.path, currentDoc);
            if (!doc) continue;
            const importedUnit = doc.parseResult.value as Unit | undefined;
            if (!importedUnit) continue;
            for (const body of importedUnit.body) {
                if (isJustification(body) || isTemplate(body)) {
                    result.push({ node: body, ns: load.namespace ?? undefined });
                }
            }
        }
        return result;
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
            const doc = this.resolveImport(load.path, currentDoc);
            const uri = doc?.uri?.toString();
            if (doc && uri && !visited.has(uri)) {
                visited.add(uri);
                enqueue.push(doc);
                out.push(doc);
            }
        }

        for (const doc of enqueue) {
            const u = doc.parseResult.value as Unit | undefined;
            if (!u) continue;
            for (const load of u.imports) {
                const nextDoc = this.parseTransitiveImport(load.path, doc);
                const uri = nextDoc?.uri?.toString();
                if (nextDoc && uri && !visited.has(uri)) {
                    visited.add(uri);
                    enqueue.push(nextDoc);
                    out.push(nextDoc);
                }
            }
        }

        this.logger.debug(`BFS import traversal: ${out.length} document(s) reachable`);
        return out;
    }

    private getElementsFromImportedUnit(
        importedUnit: Unit,
        filterFn: (body: any) => boolean
    ): JustificationElement[] {
        const elements: JustificationElement[] = [];
        for (const body of importedUnit.body) {
            if (filterFn(body)) {
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
