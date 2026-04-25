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
    Relation,
    JustificationBody,
    TemplateBody,
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

        const incoming = body.rels.filter(r => this.relationTargetsElement(r, strategy));
        if (incoming.length === 0) {
            accept('warning',
                `Strategy '${qualifiedIdText(strategy.id)}' is not supported by any evidence, sub-conclusion, or @support.`,
                { node: strategy, property: 'id' });
            return;
        }
        for (const rel of incoming) {
            const fromElem = this.resolveRelationFrom(rel, body);
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

        const incoming = body.rels.filter(r => this.relationTargetsElement(r, conclusion));
        if (incoming.length === 0) {
            accept('warning',
                `Conclusion '${qualifiedIdText(conclusion.id)}' is not supported by any strategy.`,
                { node: conclusion, property: 'id' });
            return;
        }
        const hasStrategy = incoming.some(rel => {
            const fromElem = this.resolveRelationFrom(rel, body);
            return fromElem !== undefined && isStrategy(fromElem);
        });
        if (!hasStrategy) {
            accept('error',
                `Conclusion '${qualifiedIdText(conclusion.id)}' must be supported by at least one strategy.`,
                { node: conclusion, property: 'id' });
        }
    }

    checkJustificationOverride(justification: Justification, accept: ValidationAcceptor): void {
        if (!justification.parent?.ref) return;

        const template = justification.parent.ref;
        // $refText is the text written after 'implements', e.g. "a_template" or "base:t"
        const parentRefText = justification.parent.$refText ?? template.id;
        const allTemplateElements = getAllElements(template);
        const requiredSupportElements = allTemplateElements.filter(
            (elem): elem is AbstractSupport => isAbstractSupport(elem)
        );
        const localElements = getLocalElements(justification);
        // Override key = parentRefText + ':' + elementLocalName, e.g. "a_template:abs" or "base:t:abs"
        const localById = new Map(localElements.map(e => [qualifiedIdText(e.id), e]));

        for (const supportElement of requiredSupportElements) {
            const expectedKey = `${parentRefText}:${qualifiedIdText(supportElement.id)}`;
            const override = localById.get(expectedKey);
            if (!override) {
                accept('error',
                    `Justification '${justification.id}' must override '@support ${qualifiedIdText(supportElement.id)}' from template '${template.id}'. Expected element with id '${expectedKey}'.`,
                    { node: justification, property: 'id' });
                continue;
            }
            const elemType = this.getElementType(override);
            if (elemType && elemType !== 'evidence' && elemType !== 'sub-conclusion') {
                accept('error',
                    `Cannot override '@support ${qualifiedIdText(supportElement.id)}' with type '${elemType}' in justification '${justification.id}'. @support elements can only be refined by 'evidence' or 'sub-conclusion'.`,
                    { node: override, property: 'id' });
            }
        }
    }

    private relationTargetsElement(rel: Relation, el: JustificationElement): boolean {
        return qualifiedIdText(rel.to) === qualifiedIdText(el.id);
    }

    private resolveRelationFrom(
        rel: Relation,
        body: JustificationBody | TemplateBody
    ): JustificationElement | undefined {
        const fromId = qualifiedIdText(rel.from);
        return body.body.find(e => qualifiedIdText(e.id) === fromId);
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
