/**
 * Validation system for the jPipe language.
 * 
 * This module implements validation rules for templates and justifications, with special focus on
 * the @support annotation system. The @support feature works like abstract methods in OOP:
 * - Elements marked with @support in templates MUST be overridden in justifications (required)
 * - Elements without @support can be overridden but are optional (like concrete methods)
 * - Type safety: when overriding @support elements, the override type must match the @support type
 * 
 * Key validations:
 * - Templates: warns if no @support elements exist (informational)
 * - Justifications: ensures all @support elements are overridden and types match
 * - Duplicate name checking for templates and justifications
 * - Label validation for all element types
 */

import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { JpipeAstType, Unit, Evidence, Strategy, Conclusion, SubConclusion, AbstractSupport, Template, Justification } 
    from './generated/ast.js';
import { isTemplate, isJustification, isAbstractSupport, isEvidence, isStrategy, isConclusion, isSubConclusion } from './generated/ast.js';
import type { JpipeServices } from './jpipe-module.js';
import { getAllElements, getLocalElements } from './jpipe-utils.js';

export function registerValidationChecks(services: JpipeServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.JpipeValidator;
    const checks: ValidationChecks<JpipeAstType> = {
        Unit:                               validator.checkUnitNotEmpty,
        Template:                           [validator.checkDuplicateTemplateName, validator.checkTemplateHasSupport],
        Justification:                      [validator.checkDuplicateJustificationName, validator.checkJustificationOverride],
        Evidence:                           validator.checkLabelNotEmpty,
        Strategy:                           validator.checkLabelNotEmpty,
        Conclusion:                         validator.checkLabelNotEmpty,
        SubConclusion:                      validator.checkLabelNotEmpty,
        AbstractSupport:                    validator.checkLabelNotEmpty
    };
    registry.register(checks, validator);
}

export class JpipeValidator {

    checkLabelNotEmpty(element: Evidence | Strategy | Conclusion | SubConclusion | AbstractSupport, 
                        accept: ValidationAcceptor): void {
        if (element.label?.length == 0) {
             accept('warning', 'Element label should not be empty', 
                    { node: element, property: 'label' });
        }
    }
    
    checkUnitNotEmpty(unit: Unit, accept: ValidationAcceptor): void {
        if (unit.body?.length == 0) {
            accept('warning', 'Justification File should not be empty', 
                    { node: unit, property: 'body' });
        }
    }

    checkDuplicateTemplateName(template: Template, accept: ValidationAcceptor): void {
        const unit = template.$container as Unit;
        if (!unit) return;

        const templatesWithSameName = unit.body.filter(
            (item): item is Template => isTemplate(item) && item.name === template.name
        );

        if (templatesWithSameName.length > 1) {
            accept('error', `Duplicate template name '${template.name}'`, 
                    { node: template, property: 'name' });
        }
    }

    checkTemplateHasSupport(template: Template, accept: ValidationAcceptor): void {
        const allElements = getAllElements(template);
        const hasSupport = allElements.some(elem => isAbstractSupport(elem));
        
        if (!hasSupport) {
            accept('warning', `Template '${template.name}' has no @support elements. Justifications implementing this template are not required to override any elements.`, 
                    { node: template, property: 'name' });
        }
    }

    checkDuplicateJustificationName(justification: Justification, accept: ValidationAcceptor): void {
        const unit = justification.$container as Unit;
        if (!unit) return;

        const justificationsWithSameName = unit.body.filter(
            (item): item is Justification => isJustification(item) && item.name === justification.name
        );

        if (justificationsWithSameName.length > 1) {
            accept('error', `Duplicate justification name '${justification.name}'`, 
                    { node: justification, property: 'name' });
        }
    }

    checkJustificationOverride(justification: Justification, accept: ValidationAcceptor): void {
        if (!justification.parent?.ref) {
            return;
        }

        const template = justification.parent.ref;
        const allTemplateElements = getAllElements(template);
        const requiredSupportElements = allTemplateElements.filter(elem => isAbstractSupport(elem)) as AbstractSupport[];
        const localJustificationElements = getLocalElements(justification);
        const localElementNames = new Set(localJustificationElements.map(e => e.name));
        
        // Validate all @support elements are overridden (required)
        for (const supportElement of requiredSupportElements) {
            if (!localElementNames.has(supportElement.name)) {
                accept('error', 
                    `Justification '${justification.name}' must override '@support ${supportElement.type} ${supportElement.name}' from template '${template.name}'.`, 
                    { node: justification, property: 'name' });
            }
        }
        
        // Validate type matching for @support overrides
        for (const elem of localJustificationElements) {
            const templateElement = allTemplateElements.find(te => te.name === elem.name);
            
            if (templateElement && isAbstractSupport(templateElement)) {
                const supportElement = templateElement as AbstractSupport;
                const elemType = this.getElementType(elem);
                
                if (elemType && elemType !== supportElement.type) {
                    accept('error', 
                        `Cannot override '${elem.name}' with type '${elemType}' in justification '${justification.name}'. Template '${template.name}' declares it as '@support ${supportElement.type}'.`, 
                        { node: elem, property: 'name' });
                }
            }
        }
    }

    // TODO: Make this better by using a proper type guard or mapping instead of type checking
    private getElementType(elem: any): string | null {
        if (isEvidence(elem)) {
            return 'evidence';
        } else if (isStrategy(elem)) {
            return 'strategy';
        } else if (isConclusion(elem)) {
            return 'conclusion';
        } else if (isSubConclusion(elem)) {
            return 'sub-conclusion';
        }
        return null;
    }


}
