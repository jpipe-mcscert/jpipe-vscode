import { DefaultScopeProvider, AstUtils, type AstNodeDescription, type Scope, type ReferenceInfo } from 'langium';
import { type JpipeServices } from './jpipe-module.js';
import type { JpipeServerLogger } from './jpipe-logger.js';
import {
    isJustification,
    isTemplate,
    type Composition,
    type Justification,
    type JustificationElement,
    type Template,
    type Unit
} from './generated/ast.js';
import { getAllElements, getLocalElements, implementsLoops, isDiscardedConclusion, localName, qualifiedIdText } from './jpipe-utils.js';
import { getDocumentAndUnit } from './jpipe-ast-context.js';


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
        const { document, unit } = getDocumentAndUnit(owner);
        if (!document || !unit) return undefined;
        const localEntries = this.getLocalTemplates(unit).map(t => ({ template: t, ns: undefined as string | undefined }));
        const importedEntries = this.importService.getTemplatesWithNamespace(unit, document);
        return this.createScopeFromTemplates([...localEntries, ...importedEntries]);
    }

    private refsScope(context: ReferenceInfo): Scope | undefined {
        const composition = context.container.$container as Composition;
        const owner = composition.$container as Justification | Template;
        const { document, unit } = getDocumentAndUnit(owner);
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

        const { document, unit } = getDocumentAndUnit(owner);
        const declared = getLocalElements(owner);

        // A conclusion declared under `implements` is discarded by the compiler, and so is every
        // relation written with its id. Such a reference still resolves to it, so the relation is
        // recognised as discarded and nothing else is reported on it. Every other reference
        // resolves as if it were not declared: `e` names the inherited `T:e`, not a discarded
        // `conclusion T:e`, as the compiler's lookup does once the conclusion is gone.
        const written = context.reference.$refText.replace(/\s+/g, '');
        const discarded = declared.find(e => isDiscardedConclusion(e) && qualifiedIdText(e.id) === written);
        if (discarded) return this.createScope([this.descriptions.createDescription(discarded, written)]);
        const localElements = declared.filter(e => !isDiscardedConclusion(e));

        // Local element keys take priority; inherited entries with the same key are
        // the originals being overridden and must be excluded to avoid duplicate keys.
        const localKeys = new Set(localElements.map(e => qualifiedIdText(e.id)));

        const allInheritedEntries = document && unit
            ? this.importService.getInheritedElementsWithKeys(owner, unit, document)
            : getAllElements(owner)
                .filter(e => !localElements.includes(e))
                .map(e => ({ element: e, key: qualifiedIdText(e.id) }));

        // An ancestor's discarded conclusion is not inherited either: the compiler reports a
        // relation naming it as `unknown-element`. On a chain that loops, the compiler reports the
        // cycle and judges nothing else, so the editor reports no reference into it.
        const keepDiscarded = implementsLoops(owner);
        const inheritedEntries = allInheritedEntries.filter(({ element, key }) =>
            !localKeys.has(key) && (keepDiscarded || !isDiscardedConclusion(element)));

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

        /**
         * Naming a description `''` is not merely useless, it throws: Langium refuses to describe a
         * node with no name, and the throw surfaces per reference as "An error occurred while
         * resolving reference to 'x'". An element being typed has no id yet, so every relation in
         * the model would fail to link while the author writes one — the same fault the outline
         * had, in a different provider.
         */
        const named = (element: JustificationElement) => qualifiedIdText(element.id) !== '';

        // Primary entries: full qualified keys.
        for (const e of localElements.filter(named)) {
            desc.push(this.descriptions.createDescription(e, qualifiedIdText(e.id)));
        }
        for (const { element, key } of inheritedEntries) {
            if (key !== '') desc.push(this.descriptions.createDescription(element, key));
        }

        // Short-name aliases: only when unambiguous (two-pass resolution per jpipe-compiler ADR-0012).
        for (const e of localElements.filter(named)) {
            const s = localName(e.id);
            if ((shortNameCount.get(s) ?? 0) === 1)
                desc.push(this.descriptions.createDescription(e, s));
        }
        for (const { element } of inheritedEntries.filter(entry => named(entry.element))) {
            const s = localName(element.id);
            if ((shortNameCount.get(s) ?? 0) === 1)
                desc.push(this.descriptions.createDescription(element, s));
        }

        return this.createScope(desc);
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
