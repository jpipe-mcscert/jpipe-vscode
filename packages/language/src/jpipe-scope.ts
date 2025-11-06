import { DefaultScopeProvider, AstUtils, type ReferenceInfo, URI, type LangiumDocument } from 'langium';
import { type JpipeServices } from './jpipe-module.js';
import * as path from 'node:path';
import {
    isJustification,
    isTemplate,
    isRelation,
    type Justification,
    type Template,
    type JustificationElement,
    type Unit
} from './generated/ast.js';

export class JpipeScopeProvider extends DefaultScopeProvider {
    private readonly services: JpipeServices;

    public constructor(services: JpipeServices) {
        super(services);
        this.services = services;
    }

    override getScope(context: ReferenceInfo) {
        // 2. Relation scoping: autocomplete elements within the same justification/template + imports
        if (isRelation(context.container)) {
            const justification = AstUtils.getContainerOfType(context.container, isJustification);
            if (justification) {
                const localElems = getAllElements(justification);
                return this.createScopeForElements(localElems, context.container, (unit, doc) => 
                    this.getImportedElements(unit, doc)
                );
            }
            const template = AstUtils.getContainerOfType(context.container, isTemplate);
            if (template) {
                const localElems = getAllElements(template);
                return this.createScopeForElements(localElems, context.container, (unit, doc) => 
                    this.getImportedTemplateElements(unit, doc)
                );
            }
        }

        // 1. Template/Justification references (for implements) - include from imports
        if (context.property === 'parent' && (isJustification(context.container) || isTemplate(context.container))) {
            const { document, unit } = this.getDocumentAndUnit(context.container);
            if (document && unit) {
                const localTemplates = this.getLocalTemplates(unit);
                const importedTemplates = this.getImportedTemplates(unit, document);
                const allTemplates = [...localTemplates, ...importedTemplates];
                return this.createScopeFromTemplates(allTemplates);
            }
            return super.getScope(context);
        }

        return super.getScope(context);
    }

    // Helper: Get document and unit from a node
    private getDocumentAndUnit(node: any): { document: LangiumDocument | undefined, unit: Unit | undefined } {
        const document = (node as any).$document as LangiumDocument | undefined;
        const unit = document?.parseResult?.value as Unit | undefined;
        return { document, unit };
    }

    // Helper: Create scope from elements (local + imported)
    private createScopeForElements(
        localElems: JustificationElement[],
        node: any,
        getImportedFn: (unit: Unit, doc: LangiumDocument) => JustificationElement[]
    ) {
        const { document, unit } = this.getDocumentAndUnit(node);
        if (document && unit) {
            const importedElems = getImportedFn(unit, document);
            const allElems = [...localElems, ...importedElems];
            return this.createScopeFromElements(allElems);
        }
        return this.createScopeFromElements(localElems);
    }

    // Helper: Create scope from elements array
    private createScopeFromElements(elements: JustificationElement[]) {
        const desc = elements.map(e => this.descriptions.createDescription(e, (e as any).name));
        return this.createScope(desc);
    }

    // Helper: Create scope from templates array
    private createScopeFromTemplates(templates: Template[]) {
        const desc = templates.map(t => this.descriptions.createDescription(t, t.name));
        return this.createScope(desc);
    }

    // Import/load functionality - separate from implements chain logic
    private getLocalTemplates(unit: Unit): Template[] {
        return unit.body.filter((b): b is Template => isTemplate(b));
    }

    private getImportedTemplates(unit: Unit, currentDoc: LangiumDocument): Template[] {
        const templates: Template[] = [];
        for (const load of unit.imports) {
            const importedDoc = this.resolveImport(load.filePath, currentDoc);
            if (importedDoc) {
                const importedUnit = importedDoc.parseResult.value as Unit;
                if (importedUnit) {
                    templates.push(...this.getLocalTemplates(importedUnit));
                }
            }
        }
        return templates;
    }

    private getImportedElements(unit: Unit, currentDoc: LangiumDocument): JustificationElement[] {
        return this.getElementsFromImports(unit, currentDoc, isJustification);
    }

    private getImportedTemplateElements(unit: Unit, currentDoc: LangiumDocument): JustificationElement[] {
        return this.getElementsFromImports(unit, currentDoc, isTemplate);
    }

    // Helper: Get elements from imported files, filtered by a predicate
    private getElementsFromImports(
        unit: Unit,
        currentDoc: LangiumDocument,
        filterFn: (body: any) => boolean
    ): JustificationElement[] {
        const elements: JustificationElement[] = [];
        for (const load of unit.imports) {
            const importedDoc = this.resolveImport(load.filePath, currentDoc);
            if (importedDoc) {
                const importedUnit = importedDoc.parseResult.value as Unit;
                if (importedUnit) {
                    const importedElems = this.getElementsFromImportedUnit(importedUnit, filterFn);
                    elements.push(...importedElems);
                }
            }
        }
        return elements;
    }

    // Helper: Get all elements from an imported unit, filtered by a predicate
    private getElementsFromImportedUnit(
        importedUnit: Unit,
        filterFn: (body: any) => boolean
    ): JustificationElement[] {
        const elements: JustificationElement[] = [];
        for (const body of importedUnit.body) {
            if (filterFn(body)) {
                const bodyElems = getAllElements(body);
                elements.push(...bodyElems);
            }
        }
        return elements;
    }

    private resolveImport(filePath: string, currentDoc: LangiumDocument): LangiumDocument | undefined {
        // Remove quotes from filePath string
        const cleanPath = filePath.replace(/^["']|["']$/g, '');
        
        // Resolve relative to current document
        const currentUri = URI.parse(currentDoc.uri.toString());
        const currentDir = path.dirname(currentUri.path);
        const resolvedPath = path.resolve(currentDir, cleanPath);
        const resolvedUri = URI.file(resolvedPath);
        
        // Get document from workspace manager
        const workspaceManager = this.services.shared.workspace.WorkspaceManager;
        const documents = (workspaceManager as any).documents;
        if (documents) {
            const doc = documents.get(resolvedUri.toString());
            if (doc) {
                return doc;
            }
        }
        return undefined;
    }
}

/**
 * Get all elements from a Justification or Template, including implements chain (bubbling up)
 * Templates can only see template elements, not justification elements
 */
function getAllElements(node: Justification | Template): JustificationElement[] {
    const local = getLocalElements(node);
    
    if (isJustification(node) && node.parent?.ref) {
        // For justifications: recursively get elements from parent template and its chain
        const parentElems = getAllElements(node.parent.ref);
        return [...local, ...parentElems];
    } else if (isTemplate(node) && node.parent?.ref) {
        // For templates: recursively get elements from parent template and its chain
        const parentElems = getAllElements(node.parent.ref);
        return [...local, ...parentElems];
    }
    
    return local;
}

/**
 * Get only local elements from a Justification or Template (no inheritance)
 */
function getLocalElements(node: Justification | Template): JustificationElement[] {
    const body = isJustification(node) ? node.contents : isTemplate(node) ? node.contents : undefined;
    return (body?.body ?? []) as JustificationElement[];
}
