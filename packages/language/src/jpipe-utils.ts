import {
    isJustification,
    isTemplate,
    type Justification,
    type Template,
    type JustificationElement
} from './generated/ast.js';

/**
 * Get all elements from a Justification or Template, including implements chain (bubbling up).
 * Templates can only see template elements, not justification elements.
 */
export function getAllElements(node: Justification | Template): JustificationElement[] {
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
 * Get only local elements from a Justification or Template (no inheritance).
 */
export function getLocalElements(node: Justification | Template): JustificationElement[] {
    const body = isJustification(node) ? node.contents : isTemplate(node) ? node.contents : undefined;
    return (body?.body ?? []) as JustificationElement[];
}

