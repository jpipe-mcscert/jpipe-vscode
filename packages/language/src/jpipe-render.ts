/**
 * Rendering jPipe source for elements and relations that a feature inserts.
 *
 * One renderer, so a declaration written by a completion item and the same declaration written by
 * a quick fix come out as the same string. They used to be built by two independent snippet
 * ladders, which is the kind of duplication that drifts silently.
 */
import {
    isAbstractSupport,
    isConclusion,
    isEvidence,
    isStrategy,
    isSubConclusion,
    type AbstractSupport,
    type Justification,
    type JustificationElement,
    type Template
} from './generated/ast.js';
import { getLocalElements, qualifiedIdText } from './jpipe-utils.js';

/** The keywords that declare a concrete element. */
export type ElementKeyword = 'evidence' | 'strategy' | 'sub-conclusion' | 'conclusion';

/** Every element-declaring keyword, including the template-only abstract one. */
export type AnyElementKeyword = ElementKeyword | '@support';

/** The keyword that declares the given element. */
export function keywordFor(element: JustificationElement): AnyElementKeyword {
    if (isEvidence(element)) return 'evidence';
    if (isStrategy(element)) return 'strategy';
    if (isConclusion(element)) return 'conclusion';
    if (isSubConclusion(element)) return 'sub-conclusion';
    if (isAbstractSupport(element)) return '@support';
    // Unreachable while JustificationElement is the union of the five above; kept so that adding
    // a sixth is a visible failure rather than a silently wrong keyword.
    throw new Error(`no keyword for element type '${(element as JustificationElement).$type}'`);
}

/** The concrete keyword an element declaration uses, or `undefined` for an `@support`. */
export function concreteKeywordFor(element: JustificationElement): ElementKeyword | undefined {
    const keyword = keywordFor(element);
    return keyword === '@support' ? undefined : keyword;
}

/**
 * The keyword a justification should use when overriding an `@support`.
 *
 * `evidence` and `sub-conclusion` are both legal; `evidence` is the default because it is the
 * one that needs nothing else added to the model to be valid.
 */
export function overrideKeywordFor(_support: AbstractSupport): ElementKeyword {
    return 'evidence';
}

/** `evidence T:abs is "A label"` */
export function renderElement(keyword: AnyElementKeyword, id: string, label: string): string {
    return `${keyword} ${id} is "${escapeLabel(label)}"`;
}

/** `e supports s` */
export function renderRelation(fromId: string, toId: string): string {
    return `${fromId} supports ${toId}`;
}

/**
 * A local id not already taken in the model, formed from `stem` and, if needed, a counter.
 *
 * Compares against the model's own declarations only. Inherited ids live under a qualifier, so
 * they cannot collide with the unqualified id generated here.
 */
export function freshLocalId(owner: Justification | Template, stem: string): string {
    const taken = new Set(getLocalElements(owner).map(element => qualifiedIdText(element.id)));
    if (!taken.has(stem)) return stem;
    for (let n = 1; ; n++) {
        const candidate = `${stem}${n}`;
        if (!taken.has(candidate)) return candidate;
    }
}

/** Escapes a label for the double-quoted STRING terminal. */
function escapeLabel(label: string): string {
    return label.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
