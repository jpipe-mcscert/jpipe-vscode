import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type {
    JpipeAstType,
    Unit,
    Evidence,
    Strategy,
    Conclusion,
    SubConclusion,
    AbstractSupport,
    Template,
    Justification,
    JustificationElement
} from './generated/ast.js';
import {
    isTemplate,
    isJustification,
    isAbstractSupport,
    isEvidence,
    isStrategy,
    isConclusion,
    isSubConclusion
} from './generated/ast.js';
import type { JpipeServices } from './jpipe-module.js';
import type { JpipeServerLogger } from './jpipe-logger.js';
import { getAllElements, getLocalElements, qualifiedIdText } from './jpipe-utils.js';

export function registerValidationChecks(services: JpipeServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.JpipeValidator;
    const checks: ValidationChecks<JpipeAstType> = {
        Unit:           validator.checkUnitNotEmpty,
        Template:       [validator.checkDuplicateTemplateName, validator.checkTemplateHasSupport],
        Justification:  [validator.checkDuplicateJustificationName, validator.checkJustificationOverride],
        Evidence:       validator.checkLabelNotEmpty,
        Strategy:       [validator.checkLabelNotEmpty, validator.checkStrategyIncomingSupport],
        Conclusion:     [validator.checkLabelNotEmpty, validator.checkConclusionIncomingFromStrategy],
        SubConclusion:  validator.checkLabelNotEmpty,
        AbstractSupport: validator.checkLabelNotEmpty
    };
    registry.register(checks, validator);
}

export class JpipeValidator {
    private readonly logger: JpipeServerLogger;

    constructor(services: JpipeServices) {
        this.logger = services.logger;
    }

    checkLabelNotEmpty(element: Evidence | Strategy | Conclusion | SubConclusion | AbstractSupport,
                        accept: ValidationAcceptor): void {
        if (element.name?.length === 0) {
            accept('warning', 'Element label should not be empty',
                   { node: element, property: 'name' });
        }
    }

    checkUnitNotEmpty(unit: Unit, accept: ValidationAcceptor): void {
        if (unit.body?.length === 0) {
            accept('warning', 'Justification File should not be empty',
                   { node: unit, property: 'body' });
        }
    }

    checkDuplicateTemplateName(template: Template, accept: ValidationAcceptor): void {
        this.logger.debug(`Validating template '${template.id}'`);
        const unit = template.$container;
        if (!unit) return;

        const duplicates = unit.body.filter(
            (item): item is Template => isTemplate(item) && item.id === template.id
        );

        if (duplicates.length > 1) {
            accept('error', `Duplicate template name '${template.id}'`,
                   { node: template, property: 'id' });
        }
    }

    checkTemplateHasSupport(template: Template, accept: ValidationAcceptor): void {
        const allElements = getAllElements(template);
        const hasSupport = allElements.some(elem => isAbstractSupport(elem));

        if (!hasSupport) {
            accept('warning',
                `Template '${template.id}' has no @support elements. Justifications implementing this template are not required to override any elements.`,
                { node: template, property: 'id' });
        }
    }

    checkDuplicateJustificationName(justification: Justification, accept: ValidationAcceptor): void {
        this.logger.debug(`Validating justification '${justification.id}'`);
        const unit = justification.$container;
        if (!unit) return;

        const duplicates = unit.body.filter(
            (item): item is Justification => isJustification(item) && item.id === justification.id
        );

        if (duplicates.length > 1) {
            accept('error', `Duplicate justification name '${justification.id}'`,
                   { node: justification, property: 'id' });
        }
    }

    checkStrategyIncomingSupport(strategy: Strategy, accept: ValidationAcceptor): void {
        const body = strategy.$container;
        if (!body?.rels) return;

        const incoming = body.rels.filter(r => r.to.ref === strategy);
        if (incoming.length === 0) {
            accept('warning',
                `Strategy '${qualifiedIdText(strategy.id)}' is not supported by any evidence, sub-conclusion, or @support.`,
                { node: strategy, property: 'id' });
            return;
        }
        for (const rel of incoming) {
            const fromElem = rel.from.ref;
            if (!fromElem) continue;
            if (!isEvidence(fromElem) && !isSubConclusion(fromElem) && !isAbstractSupport(fromElem)) {
                accept('error',
                    `Strategy '${qualifiedIdText(strategy.id)}' may only be supported by evidence, sub-conclusion, or @support (not ${this.elementKindLabel(fromElem)}).`,
                    { node: rel, property: 'from' });
            }
        }
    }

    checkConclusionIncomingFromStrategy(conclusion: Conclusion, accept: ValidationAcceptor): void {
        const body = conclusion.$container;
        if (!body?.rels) return;

        const incoming = body.rels.filter(r => r.to.ref === conclusion);
        if (incoming.length === 0) {
            accept('warning',
                `Conclusion '${qualifiedIdText(conclusion.id)}' is not supported by any strategy.`,
                { node: conclusion, property: 'id' });
            return;
        }
        const hasStrategy = incoming.some(rel => isStrategy(rel.from.ref));
        if (!hasStrategy) {
            accept('error',
                `Conclusion '${qualifiedIdText(conclusion.id)}' must be supported by at least one strategy.`,
                { node: conclusion, property: 'id' });
        }
    }

    checkJustificationOverride(justification: Justification, accept: ValidationAcceptor): void {
        this.logger.debug(`Checking overrides for justification '${justification.id}'`);
        if (!justification.parent?.ref) return;

        const template = justification.parent.ref;
        const parentRefText = justification.parent.$refText ?? template.id;
        const localElements = getLocalElements(justification);
        const localById = new Map(localElements.map(e => [qualifiedIdText(e.id), e]));

        for (const req of this.getRequiredOverrides(template, parentRefText)) {
            const override = localById.get(req.expectedKey);
            if (!override) {
                accept('error',
                    `Justification '${justification.id}' must override '@support ${qualifiedIdText(req.support.id)}' from template '${req.sourceTemplateId}'. Expected element with id '${req.expectedKey}'.`,
                    { node: justification, property: 'id' });
                continue;
            }
            const elemType = this.getElementType(override);
            if (elemType && elemType !== 'evidence' && elemType !== 'sub-conclusion') {
                accept('error',
                    `Cannot override '@support ${qualifiedIdText(req.support.id)}' with type '${elemType}' in justification '${justification.id}'. @support elements can only be refined by 'evidence' or 'sub-conclusion'.`,
                    { node: override, property: 'id' });
            }
        }
    }

    private getRequiredOverrides(
        template: Template,
        refText: string
    ): Array<{ support: AbstractSupport; expectedKey: string; sourceTemplateId: string }> {
        const local = template.contents?.body ?? [];
        // Keys of non-abstract elements defined directly in this template (these override parent abstracts)
        const localOverrideKeys = new Set(
            local.filter(e => !isAbstractSupport(e)).map(e => qualifiedIdText(e.id))
        );
        const result: Array<{ support: AbstractSupport; expectedKey: string; sourceTemplateId: string }> = [];

        // Abstract supports declared directly in this template
        for (const elem of local) {
            if (isAbstractSupport(elem)) {
                result.push({
                    support: elem,
                    expectedKey: `${refText}:${qualifiedIdText(elem.id)}`,
                    sourceTemplateId: template.id
                });
            }
        }

        // Propagate unresolved abstract supports from the parent chain
        if (template.parent?.ref) {
            const parentRefText = template.parent.$refText ?? template.parent.ref.id;
            for (const req of this.getRequiredOverrides(template.parent.ref, parentRefText)) {
                // Skip if this template already provides a non-abstract override for it
                if (!localOverrideKeys.has(req.expectedKey)) {
                    result.push(req);
                }
            }
        }

        return result;
    }

    private elementKindLabel(elem: JustificationElement): string {
        if (isEvidence(elem)) return 'evidence';
        if (isStrategy(elem)) return 'strategy';
        if (isConclusion(elem)) return 'conclusion';
        if (isSubConclusion(elem)) return 'sub-conclusion';
        if (isAbstractSupport(elem)) return '@support';
        return 'element';
    }

    private getElementType(elem: JustificationElement): string | null {
        if (isEvidence(elem)) return 'evidence';
        if (isStrategy(elem)) return 'strategy';
        if (isConclusion(elem)) return 'conclusion';
        if (isSubConclusion(elem)) return 'sub-conclusion';
        return null;
    }
}
