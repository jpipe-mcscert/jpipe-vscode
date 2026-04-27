import { DefaultScopeProvider, AstUtils, type AstNodeDescription, type Scope, type ReferenceInfo, type LangiumDocument } from 'langium';
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
import { getAllElements, getLocalElements, localName, qualifiedIdText } from './jpipe-utils.js';


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

        const { document, unit } = this.getDocumentAndUnit(owner);
        const localElements = getLocalElements(owner);

        // Local element keys take priority; inherited entries with the same key are
        // the originals being overridden and must be excluded to avoid duplicate keys.
        const localKeys = new Set(localElements.map(e => qualifiedIdText(e.id)));

        const allInheritedEntries = document && unit
            ? this.importService.getInheritedElementsWithKeys(owner, unit, document)
            : getAllElements(owner)
                .filter(e => !localElements.includes(e))
                .map(e => ({ element: e, key: qualifiedIdText(e.id) }));

        const inheritedEntries = allInheritedEntries.filter(({ key }) => !localKeys.has(key));

        // Count occurrences of each short name to detect ambiguity for the fallback aliases.
        const shortNameCount = new Map<string, number>();
        for (const e of localElements) {
            const s = localName(e.id);
            shortNameCount.set(s, (shortNameCount.get(s) ?? 0) + 1);
        }
        for (const { element } of inheritedEntries) {
            const s = localName(element.id);
            shortNameCount.set(s, (shortNameCount.get(s) ?? 0) + 1);
        }

        const desc: AstNodeDescription[] = [];

        // Primary entries: full qualified keys.
        for (const e of localElements) {
            desc.push(this.descriptions.createDescription(e, qualifiedIdText(e.id)));
        }
        for (const { element, key } of inheritedEntries) {
            desc.push(this.descriptions.createDescription(element, key));
        }

        // Short-name aliases: only when unambiguous (two-pass resolution per ADR 0012).
        for (const e of localElements) {
            const s = localName(e.id);
            if ((shortNameCount.get(s) ?? 0) === 1)
                desc.push(this.descriptions.createDescription(e, s));
        }
        for (const { element } of inheritedEntries) {
            const s = localName(element.id);
            if ((shortNameCount.get(s) ?? 0) === 1)
                desc.push(this.descriptions.createDescription(element, s));
        }

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
