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

    private debugLog(message: string, ...args: any[]) {
        const fullMessage = `[SCOPE-DEBUG] ${message}`;
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

    override getScope(context: ReferenceInfo) {
        this.debugLog('getScope called, property:', context.property);
        this.debugLog('container type:', (context.container as any).$type);
        
        // 2. Relation scoping: autocomplete elements within the same justification/template + imports
        if (isRelation(context.container)) {
            this.debugLog('Path: Relation scoping');
            const justification = AstUtils.getContainerOfType(context.container, isJustification);
            if (justification) {
                this.debugLog('Found justification:', justification.name);
                const localElems = getAllElements(justification);
                this.debugLog('Local elements count:', localElems.length);
                // For justifications, we need both imported justifications AND imported templates
                // because a justification can implement a template from an import
                return this.createScopeForElements(localElems, context.container, (unit, doc) => {
                    this.debugLog('Getting imported elements for justification');
                    const importedJustifications = this.importService.getImportedElements(unit, doc);
                    const importedTemplates = this.importService.getImportedTemplateElements(unit, doc);
                    this.debugLog('Imported justifications:', importedJustifications.length, 'templates:', importedTemplates.length);
                    return [...importedJustifications, ...importedTemplates];
                });
            }
            const template = AstUtils.getContainerOfType(context.container, isTemplate);
            if (template) {
                this.debugLog('Found template:', template.name);
                const localElems = getAllElements(template);
                this.debugLog('Local elements count:', localElems.length);
                return this.createScopeForElements(localElems, context.container, (unit, doc) => {
                    this.debugLog('Getting imported template elements');
                    return this.importService.getImportedTemplateElements(unit, doc);
                });
            }
        }

        // 1. Template/Justification references (for implements) - include from imports
        if (context.property === 'parent' && (isJustification(context.container) || isTemplate(context.container))) {
            this.debugLog('Path: Template/Justification parent reference');
            this.debugLog('container name:', (context.container as any).name);
            this.debugLog('container type:', (context.container as any).$type);
            const { document, unit } = this.getDocumentAndUnit(context.container);
            this.debugLog('getDocumentAndUnit result - document:', !!document, 'unit:', !!unit);
            if (document) {
                this.debugLog('document.uri:', document.uri.toString());
            }
            if (unit) {
                this.debugLog('unit.body.length:', unit.body.length);
                this.debugLog('unit.imports.length:', unit.imports.length);
                if (unit.body.length > 0) {
                    this.debugLog('unit.body types:', unit.body.map(b => (b as any).$type).join(', '));
                    this.debugLog('unit.body names:', unit.body.map((b: any) => b.name || 'no-name').join(', '));
                }
            }
            if (document && unit) {
                this.debugLog('Document and unit found, getting templates');
                const localTemplates = this.getLocalTemplates(unit);
                this.debugLog('Local templates count:', localTemplates.length);
                if (localTemplates.length > 0) {
                    this.debugLog('Local template names:', localTemplates.map(t => t.name).join(', '));
                }
                // Only get templates from explicitly loaded files (unit.imports)
                const importedTemplates = this.importService.getImportedTemplates(unit, document);
                this.debugLog('Imported templates count:', importedTemplates.length);
                if (importedTemplates.length > 0) {
                    this.debugLog('Imported template names:', importedTemplates.map(t => t.name).join(', '));
                }
                const allTemplates = [...localTemplates, ...importedTemplates];
                this.debugLog('Total templates:', allTemplates.length);
                if (allTemplates.length > 0) {
                    this.debugLog('All template names:', allTemplates.map(t => t.name).join(', '));
                }
                return this.createScopeFromTemplates(allTemplates);
            }
            this.debugLog('No document/unit found, returning EMPTY_SCOPE');
            // Fall back to default scope provider for local references if document/unit lookup fails
            // This handles the case where the node structure doesn't have $document properly set
            this.debugLog('Falling back to default scope provider');
            return super.getScope(context);
        }

        this.debugLog('Default path: returning EMPTY_SCOPE');
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
        this.debugLog('getDocumentAndUnit - document found:', !!document, 'unit found:', !!unit);
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
        this.debugLog('getLocalTemplates - unit.body.length:', unit.body.length);
        const templates = unit.body.filter((b): b is Template => isTemplate(b));
        this.debugLog('getLocalTemplates - found templates:', templates.length);
        if (templates.length > 0) {
            this.debugLog('getLocalTemplates - template names:', templates.map(t => t.name).join(', '));
        }
        return templates;
    }
}

