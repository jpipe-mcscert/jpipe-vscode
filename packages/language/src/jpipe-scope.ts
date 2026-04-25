import { DefaultScopeProvider, AstUtils, type ReferenceInfo, type LangiumDocument } from 'langium';
import { type JpipeServices } from './jpipe-module.js';
import {
    isJustification,
    isTemplate,
    type Justification,
    type Template,
    type Unit
} from './generated/ast.js';
import { getAllElements, qualifiedIdText } from './jpipe-utils.js';


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
                const localEntries = this.getLocalTemplates(unit)
                    .map(t => ({ template: t, ns: undefined as string | undefined }));
                const importedEntries = this.importService.getTemplatesWithNamespace(unit, document);
                return this.createScopeFromTemplates([...localEntries, ...importedEntries]);
            }
            return super.getScope(context);
        }

        if (context.property === 'from' || context.property === 'to') {
            const owner = AstUtils.getContainerOfType(context.container, isJustification)
                       ?? AstUtils.getContainerOfType(context.container, isTemplate);
            if (owner) {
                return this.createElementScope(owner);
            }
        }

        return super.getScope(context);
    }

    private createElementScope(owner: Justification | Template) {
        const elements = getAllElements(owner);
        const desc = elements.map(e =>
            this.descriptions.createDescription(e, qualifiedIdText(e.id))
        );
        return this.createScope(desc);
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

    private createScopeFromTemplates(entries: Array<{ template: Template; ns: string | undefined }>) {
        const desc = entries.map(({ template, ns }) => {
            const key = ns ? `${ns}:${template.id}` : template.id;
            return this.descriptions.createDescription(template, key);
        });
        return this.createScope(desc);
    }

    private getLocalTemplates(unit: Unit): Template[] {
        return unit.body.filter((b): b is Template => isTemplate(b));
    }
}
