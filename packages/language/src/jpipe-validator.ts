import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { JpipeAstType, JustificationElementDeclaration, Unit } 
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
        JustificationElementDeclaration:    validator.checkLabelNotEmpty
    };
    registry.register(checks, validator);
}

/**
 * Implementation of custom validations.
 */
export class JpipeValidator {

    checkLabelNotEmpty(declaration: JustificationElementDeclaration, 
                        accept: ValidationAcceptor): void {
        if (declaration.label?.length == 0) {
             accept('warning', 'Element label should not be empty', 
                    { node: declaration, property: 'label' });
        }
    }
    
    checkUnitNotEmpty(unit: Unit, accept: ValidationAcceptor): void {
        if (unit.body?.length == 0) {
            accept('warning', 'Justification File should not be empty', 
                    { node: unit, property: 'body' });
        }
    } 


}
