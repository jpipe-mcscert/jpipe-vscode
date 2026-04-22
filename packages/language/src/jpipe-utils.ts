/**
 * Utility functions for working with jPipe AST nodes.
 * 
 * These functions handle element retrieval from justifications and templates, including
 * inheritance chains. When a justification implements a template (or a template implements
 * another template), elements are inherited recursively up the chain.
 */

import {
    isJustification,
    isTemplate,
    type Justification,
    type Template,
    type JustificationElement
} from './generated/ast.js';

/**
 * Recursively collects all elements from a justification or template, including those
 * inherited from parent templates. Elements are returned in order: local first, then
 * inherited (most specific to least specific).
 */
export function getAllElements(node: Justification | Template): JustificationElement[] {
    const local = getLocalElements(node);
    
    if (isJustification(node) && node.parent?.ref) {
        const parentElems = getAllElements(node.parent.ref);
        return [...local, ...parentElems];
    } else if (isTemplate(node) && node.parent?.ref) {
        const parentElems = getAllElements(node.parent.ref);
        return [...local, ...parentElems];
    }
    
    return local;
}

/**
 * Returns only the elements directly defined in the given justification or template,
 * without any inherited elements from parent templates.
 */
export function getLocalElements(node: Justification | Template): JustificationElement[] {
    const body = isJustification(node)
        ? node.contents 
        : isTemplate(node) 
            ? node.contents 
            : undefined;
    return (body?.body ?? []) as JustificationElement[];
}

