import { DefaultScopeProvider, type ReferenceInfo, type LangiumDocument } from 'langium';
import { type JpipeServices } from './jpipe-module.js';
import {
    isJustification,
    isTemplate,
    type Template,
    type Unit
} from './generated/ast.js';


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
        if (context.property === 'parent' && (isJustification(context.container) || isTemplate(context.container))) {
            const { document, unit } = this.getDocumentAndUnit(context.container);
            if (document && unit) {
                const localTemplates = this.getLocalTemplates(unit);
                const importedTemplates = this.importService.getImportedTemplates(unit, document);
                return this.createScopeFromTemplates([...localTemplates, ...importedTemplates]);
            }
            return super.getScope(context);
        }

        return super.getScope(context);
    }

    private getDocumentAndUnit(node: any): { document: LangiumDocument | undefined, unit: Unit | undefined } {
        let document = node.$document as LangiumDocument | undefined;

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

    private createScopeFromTemplates(templates: Template[]) {
        const desc = templates.map(t => this.descriptions.createDescription(t, t.id));
        return this.createScope(desc);
    }

    private getLocalTemplates(unit: Unit): Template[] {
        return unit.body.filter((b): b is Template => isTemplate(b));
    }
}
