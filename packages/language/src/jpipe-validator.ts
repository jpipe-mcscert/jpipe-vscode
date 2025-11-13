import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { JpipeAstType, Unit, Evidence, Strategy, Conclusion, SubConclusion, AbstractSupport, Template, Justification } 
    from './generated/ast.js';
import { isTemplate, isJustification } from './generated/ast.js';
import type { JpipeServices } from './jpipe-module.js';

/**
 * Register custom validation checks.
 */
export function registerValidationChecks(services: JpipeServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.JpipeValidator;
    const checks: ValidationChecks<JpipeAstType> = {
        Unit:                               validator.checkUnitNotEmpty,
        Template:                           validator.checkDuplicateTemplateName,
        Justification:                     validator.checkDuplicateJustificationName,
        Evidence:                           validator.checkLabelNotEmpty,
        Strategy:                           validator.checkLabelNotEmpty,
        Conclusion:                         validator.checkLabelNotEmpty,
        SubConclusion:                      validator.checkLabelNotEmpty,
        AbstractSupport:                    validator.checkLabelNotEmpty
    };
    registry.register(checks, validator);
}

/**
 * Implementation of custom validations.
 */
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

}
