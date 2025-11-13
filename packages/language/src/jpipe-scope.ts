import { DefaultScopeProvider, AstUtils, type ReferenceInfo, type LangiumDocument, EMPTY_SCOPE } from 'langium';
import { type JpipeServices } from './jpipe-module.js';
import {
    isJustification,
    isTemplate,
    isRelation,
    type Template,
    type JustificationElement,
    type Unit
} from './generated/ast.js';
import { getAllElements } from './jpipe-utils.js';

export class JpipeScopeProvider extends DefaultScopeProvider {
    private readonly services: JpipeServices;

    public constructor(services: JpipeServices) {
        super(services);
        this.services = services;
    }

    private get importService() {
        return this.services.references.JpipeImportService;
    }

    override getScope(context: ReferenceInfo) {
        // 2. Relation scoping: autocomplete elements within the same justification/template + imports
        if (isRelation(context.container)) {
            const justification = AstUtils.getContainerOfType(context.container, isJustification);
            if (justification) {
                const localElems = getAllElements(justification);
                // For justifications, we need both imported justifications AND imported templates
                // because a justification can implement a template from an import
                return this.createScopeForElements(localElems, context.container, (unit, doc) => {
                    const importedJustifications = this.importService.getImportedElements(unit, doc);
                    const importedTemplates = this.importService.getImportedTemplateElements(unit, doc);
                    return [...importedJustifications, ...importedTemplates];
                });
            }
            const template = AstUtils.getContainerOfType(context.container, isTemplate);
            if (template) {
                const localElems = getAllElements(template);
                return this.createScopeForElements(localElems, context.container, (unit, doc) => {
                    return this.importService.getImportedTemplateElements(unit, doc);
                });
            }
        }

        // 1. Template/Justification references (for implements) - include from imports
        if (context.property === 'parent' && (isJustification(context.container) || isTemplate(context.container))) {
            const { document, unit } = this.getDocumentAndUnit(context.container);
            if (document && unit) {
                const localTemplates = this.getLocalTemplates(unit);
                // Only get templates from explicitly loaded files (unit.imports)
                const importedTemplates = this.importService.getImportedTemplates(unit, document);
                const allTemplates = [...localTemplates, ...importedTemplates];
                return this.createScopeFromTemplates(allTemplates);
            }
            // Fall back to default scope provider for local references if document/unit lookup fails
            // This handles the case where the node structure doesn't have $document properly set
            return super.getScope(context);
        }

        // Return empty scope instead of super.getScope to avoid accessing all workspace documents
        // We only want to include items from the current file and explicitly loaded files
        return EMPTY_SCOPE;
    }

    // Helper: Get document and unit from a node
    private getDocumentAndUnit(node: any): { document: LangiumDocument | undefined, unit: Unit | undefined } {
        // Try multiple ways to get the document
        let document = (node as any).$document as LangiumDocument | undefined;
        
        // If $document doesn't work, try traversing up the tree
        if (!document) {
            let current: any = node;
            while (current && !document) {
                document = current.$document;
                current = current.$container;
            }
        }
        
        
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

    // Helper: Get local templates from a unit
    private getLocalTemplates(unit: Unit): Template[] {
        return unit.body.filter((b): b is Template => isTemplate(b));
    }
}

