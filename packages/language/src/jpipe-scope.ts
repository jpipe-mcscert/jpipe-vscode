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
        if (isRelation(context.container)) {
            const justification = AstUtils.getContainerOfType(context.container, isJustification);
            if (justification) {
                const localElems = getAllElements(justification);
                // Justifications need both imported justifications and templates since they can implement imported templates
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

        if (context.property === 'parent' && (isJustification(context.container) || isTemplate(context.container))) {
            const { document, unit } = this.getDocumentAndUnit(context.container);
            if (document && unit) {
                const localTemplates = this.getLocalTemplates(unit);
                const importedTemplates = this.importService.getImportedTemplates(unit, document);
                return this.createScopeFromTemplates([...localTemplates, ...importedTemplates]);
            }
            // Fall back to default scope provider if document/unit lookup fails
            return super.getScope(context);
        }

        return EMPTY_SCOPE;
    }

    private getDocumentAndUnit(node: any): { document: LangiumDocument | undefined, unit: Unit | undefined } {
        let document = (node as any).$document as LangiumDocument | undefined;
        
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

    private createScopeForElements(
        localElems: JustificationElement[],
        node: any,
        getImportedFn: (unit: Unit, doc: LangiumDocument) => JustificationElement[]
    ) {
        const { document, unit } = this.getDocumentAndUnit(node);
        if (document && unit) {
            const importedElems = getImportedFn(unit, document);
            return this.createScopeFromElements([...localElems, ...importedElems]);
        }
        return this.createScopeFromElements(localElems);
    }

    private createScopeFromElements(elements: JustificationElement[]) {
        const desc = elements.map(e => this.descriptions.createDescription(e, (e as any).name));
        return this.createScope(desc);
    }

    private createScopeFromTemplates(templates: Template[]) {
        const desc = templates.map(t => this.descriptions.createDescription(t, t.name));
        return this.createScope(desc);
    }

    private getLocalTemplates(unit: Unit): Template[] {
        return unit.body.filter((b): b is Template => isTemplate(b));
    }
}

