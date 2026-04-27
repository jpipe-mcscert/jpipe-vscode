import { DefaultScopeProvider, AstUtils, type Scope, type ReferenceInfo, type LangiumDocument } from 'langium';
import { type JpipeServices } from './jpipe-module.js';
import type { JpipeServerLogger } from './jpipe-logger.js';
import {
    isJustification,
    isTemplate,
    type Composition,
    type Justification,
    type Template,
    type Unit
} from './generated/ast.js';
import { getAllElements, qualifiedIdText } from './jpipe-utils.js';


export class JpipeScopeProvider extends DefaultScopeProvider {
    private readonly services: JpipeServices;
    private readonly logger: JpipeServerLogger;

    public constructor(services: JpipeServices) {
        super(services);
        this.services = services;
        this.logger = services.logger;
    }

    private get importService() {
        return this.services.references.JpipeImportService;
    }

    override getScope(context: ReferenceInfo) {
        if (this.logger.shouldLog('debug')) this.logger.debug(`Scope resolution: property='${context.property}' container=${context.container.$type}`);

        if (context.property === 'parent' && (isJustification(context.container) || isTemplate(context.container))) {
            return this.parentScope(context.container) ?? super.getScope(context);
        }

        if (context.property === 'refs') {
            return this.refsScope(context) ?? super.getScope(context);
        }

        if (context.property === 'from' || context.property === 'to') {
            return this.relationScope(context) ?? super.getScope(context);
        }

        return super.getScope(context);
    }

    private parentScope(owner: Justification | Template): Scope | undefined {
        const { document, unit } = this.getDocumentAndUnit(owner);
        if (!document || !unit) return undefined;
        const localEntries = this.getLocalTemplates(unit).map(t => ({ template: t, ns: undefined as string | undefined }));
        const importedEntries = this.importService.getTemplatesWithNamespace(unit, document);
        return this.createScopeFromTemplates([...localEntries, ...importedEntries]);
    }

    private refsScope(context: ReferenceInfo): Scope | undefined {
        const composition = context.container.$container as Composition;
        const owner = composition.$container as Justification | Template;
        const { document, unit } = this.getDocumentAndUnit(owner);
        if (!document || !unit) return undefined;
        const local = unit.body.filter((b): b is Justification | Template => isJustification(b) || isTemplate(b));
        const imported = this.importService.getJustificationsAndTemplatesWithNamespace(unit, document);
        const desc = [
            ...local.map(n => this.descriptions.createDescription(n, n.id)),
            ...imported.map(({ node, ns }) =>
                this.descriptions.createDescription(node, ns ? `${ns}:${node.id}` : node.id))
        ];
        return this.createScope(desc);
    }

    private relationScope(context: ReferenceInfo): Scope | undefined {
        const owner = AstUtils.getContainerOfType(context.container, isJustification)
                   ?? AstUtils.getContainerOfType(context.container, isTemplate);
        if (!owner) return undefined;
        // Do NOT access sibling .ref here — scope is resolved during linking, before
        // references are resolved, so reading a sibling .ref triggers a cycle.
        // Relation-type filtering (e.g. evidence→strategy only) is done in the completion
        // provider, which runs after linking is complete.
        const elements = getAllElements(owner);
        const desc = elements.map(e => this.descriptions.createDescription(e, qualifiedIdText(e.id)));
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
