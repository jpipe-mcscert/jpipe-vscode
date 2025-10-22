import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { JpipeAstType, Unit, Evidence, Strategy, Conclusion, SubConclusion, AbstractSupport } 
    from './generated/ast.js';
import type { JpipeServices } from './jpipe-module.js';

/**
 * Register custom validation checks.
 */
export function registerValidationChecks(services: JpipeServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.JpipeValidator;
    const checks: ValidationChecks<JpipeAstType> = {
        Unit:                               validator.checkUnitNotEmpty,
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


}
