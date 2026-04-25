import {
    type Justification,
    type Template,
    type JustificationElement,
    type QualifiedId
} from './generated/ast.js';

/** Returns the colon-joined string form of a QualifiedId, e.g. ['t','abs'] → 't:abs'. */
export function qualifiedIdText(id: QualifiedId): string {
    return id.parts.join(':');
}

/** Returns the last segment of a QualifiedId — the local name ('t:abs' → 'abs', 'e1' → 'e1'). */
export function localName(id: QualifiedId): string {
    return id.parts.at(-1) ?? '';
}

/**
 * Recursively collects all elements from a justification or template, including those
 * inherited from parent templates. Elements are returned in order: local first, then
 * inherited (most specific to least specific).
 */
export function getAllElements(node: Justification | Template): JustificationElement[] {
    const local = getLocalElements(node);
    const parentRef = node.parent?.ref;
    if (parentRef) {
        return [...local, ...getAllElements(parentRef)];
    }
    return local;
}

/**
 * Returns only the elements directly defined in the given justification or template,
 * without any inherited elements from parent templates.
 */
export function getLocalElements(node: Justification | Template): JustificationElement[] {
    return (node.contents?.body ?? []) as JustificationElement[];
}
