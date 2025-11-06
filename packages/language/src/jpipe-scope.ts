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
                // Get all elements from local + implements chain (bubbling up) - EXISTING LOGIC - DON'T TOUCH
                const localElems = getAllElements(justification);
                
                // Try to add imported elements if document/unit is available
                const node = context.container;
                const document = (node as any).$document as LangiumDocument | undefined;
                if (document) {
                    const unit = document.parseResult.value as Unit;
                    if (unit) {
                        const importedElems = this.getImportedElements(unit, document);
                        const allElems = [...localElems, ...importedElems];
                        const desc = allElems.map(e => this.descriptions.createDescription(e, (e as any).name));
                        return this.createScope(desc);
                    }
                }
                
                // Fallback to original behavior if no imports available
                const desc = localElems.map(e => this.descriptions.createDescription(e, (e as any).name));
                return this.createScope(desc);
            }
            const template = AstUtils.getContainerOfType(context.container, isTemplate);
            if (template) {
                // Templates: get elements from local + implements chain - EXISTING LOGIC - DON'T TOUCH
                const localElems = getAllElements(template);
                
                // Try to add imported elements if document/unit is available
                const node = context.container;
                const document = (node as any).$document as LangiumDocument | undefined;
                if (document) {
                    const unit = document.parseResult.value as Unit;
                    if (unit) {
                        const importedElems = this.getImportedTemplateElements(unit, document);
                        const allElems = [...localElems, ...importedElems];
                        const desc = allElems.map(e => this.descriptions.createDescription(e, (e as any).name));
                        return this.createScope(desc);
                    }
                }
                
                // Fallback to original behavior if no imports available
                const desc = localElems.map(e => this.descriptions.createDescription(e, (e as any).name));
                return this.createScope(desc);
            }
        }

        // 1. Template/Justification references (for implements) - include from imports
        const node = context.container;
        const document = (node as any).$document as LangiumDocument | undefined;
        if (context.property === 'parent' && (isJustification(context.container) || isTemplate(context.container))) {
            if (document) {
                const unit = document.parseResult.value as Unit;
                if (unit) {
                    const localTemplates = this.getLocalTemplates(unit);
                    const importedTemplates = this.getImportedTemplates(unit, document);
                    const allTemplates = [...localTemplates, ...importedTemplates];
                    const desc = allTemplates.map(t => this.descriptions.createDescription(t, t.name));
                    return this.createScope(desc);
                }
            }
            // Fallback to default if no document/unit
            return super.getScope(context);
        }

        return super.getScope(context);
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
        const elements: JustificationElement[] = [];
        for (const load of unit.imports) {
            const importedDoc = this.resolveImport(load.filePath, currentDoc);
            if (importedDoc) {
                const importedUnit = importedDoc.parseResult.value as Unit;
                if (importedUnit) {
                    // Get all elements from all justifications in imported file
                    for (const body of importedUnit.body) {
                        if (isJustification(body)) {
                            const justElems = getAllElements(body);
                            elements.push(...justElems);
                        }
                    }
                }
            }
        }
        return elements;
    }

    private getImportedTemplateElements(unit: Unit, currentDoc: LangiumDocument): JustificationElement[] {
        const elements: JustificationElement[] = [];
        for (const load of unit.imports) {
            const importedDoc = this.resolveImport(load.filePath, currentDoc);
            if (importedDoc) {
                const importedUnit = importedDoc.parseResult.value as Unit;
                if (importedUnit) {
                    // Get all elements from all templates in imported file
                    for (const body of importedUnit.body) {
                        if (isTemplate(body)) {
                            const templateElems = getAllElements(body);
                            elements.push(...templateElems);
                        }
                    }
                }
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
