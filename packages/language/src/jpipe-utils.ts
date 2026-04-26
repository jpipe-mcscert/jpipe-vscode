import { type AstNode } from 'langium';
import { DefaultNameProvider } from 'langium';
import {
    isAbstractSupport,
    type Justification,
    type Template,
    type JustificationElement,
    type QualifiedId
} from './generated/ast.js';

/**
 * Name provider that returns the element's identifier (id field) rather than its label
 * (name field), so LSP document symbols match the SVG node ids used by the preview panel.
 */
export class JpipeNameProvider extends DefaultNameProvider {
    override getName(node: AstNode): string | undefined {
        const n = node as unknown as Record<string, unknown>;
        const id = n['id'];
        if (typeof id === 'string') return id;
        if (id && typeof id === 'object' && Array.isArray((id as QualifiedId).parts)) {
            // Return only the local segment: the preview client prepends diagramName + ':'
            // to construct the SVG element id (e.g. 'abs' → 't:abs').
            return localName(id as QualifiedId);
        }
        return super.getName(node);
    }
}

/** Returns the colon-joined string form of a QualifiedId, e.g. ['t','abs'] → 't:abs'. */
export function qualifiedIdText(id: QualifiedId): string {
    return id.parts.join(':');
}

/** Returns the last segment of a QualifiedId — the local name ('t:abs' → 'abs', 'e1' → 'e1'). */
export function localName(id: QualifiedId): string {
    return id.parts.at(-1) ?? '';
}

/**
 * Returns the elements valid as `from`/`to` candidates in a Relation within the given
 * justification or template: locally declared elements plus `@support` elements from
 * the parent template chain (which can be referenced in relations by child models).
 * Does NOT include inherited non-abstract elements, which belong to the parent's own body.
 */
export function getRelationCandidates(node: Justification | Template): JustificationElement[] {
    const local = getLocalElements(node);
    const abstractSupports: JustificationElement[] = [];
    let parent = node.parent?.ref;
    while (parent) {
        for (const el of getLocalElements(parent)) {
            if (isAbstractSupport(el)) abstractSupports.push(el);
        }
        parent = parent.parent?.ref;
    }
    return [...local, ...abstractSupports];
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
