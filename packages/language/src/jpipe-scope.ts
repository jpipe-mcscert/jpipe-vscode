import { DefaultScopeProvider, AstUtils, type ReferenceInfo } from 'langium';
import { type JpipeServices } from './jpipe-module.js';
import {
    isJustification,
    isTemplate,
    isRelation,
    type Justification,
    type Template,
    type JustificationElement
} from './generated/ast.js';

export class JpipeScopeProvider extends DefaultScopeProvider {
    public constructor(services: JpipeServices) {
        super(services);
    }

    override getScope(context: ReferenceInfo) {
        // Relation scoping: autocomplete elements within the same justification/template
        if (isRelation(context.container)) {
            const justification = AstUtils.getContainerOfType(context.container, isJustification);
            if (justification) {
                // Get all elements from local + implements chain (bubbling up)
                const allElems = getAllElements(justification);
                const desc = allElems.map(e => this.descriptions.createDescription(e, (e as any).name));
                return this.createScope(desc);
            }
            const template = AstUtils.getContainerOfType(context.container, isTemplate);
            if (template) {
                // Templates: get elements from local + implements chain
                const allElems = getAllElements(template);
                const desc = allElems.map(e => this.descriptions.createDescription(e, (e as any).name));
                return this.createScope(desc);
            }
        }

        return super.getScope(context);
    }
}

/**
 * Get all elements from a Justification or Template, including implements chain (bubbling up)
 * Templates can only see template elements, not justification elements
 */
function getAllElements(node: Justification | Template): JustificationElement[] {
    const local = getLocalElements(node);
    
    if (isJustification(node) && node.parent?.ref) {
        // For justifications: recursively get elements from parent template and its chain
        const parentElems = getAllElements(node.parent.ref);
        return [...local, ...parentElems];
    } else if (isTemplate(node) && node.parent?.ref) {
        // For templates: recursively get elements from parent template and its chain
        const parentElems = getAllElements(node.parent.ref);
        return [...local, ...parentElems];
    }
    
    return local;
}

/**
 * Get only local elements from a Justification or Template (no inheritance)
 */
function getLocalElements(node: Justification | Template): JustificationElement[] {
    const body = isJustification(node) ? node.contents : isTemplate(node) ? node.contents : undefined;
    return (body?.body ?? []) as JustificationElement[];
}

