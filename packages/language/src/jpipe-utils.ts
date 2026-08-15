import { type AstNode, type CstNode, GrammarUtils, URI } from 'langium';
import { DefaultNameProvider } from 'langium';
import {
    isAbstractSupport,
    type Justification,
    type Template,
    type JustificationElement,
    type QualifiedId
} from './generated/ast.js';

/**
 * Returns the OS-native filesystem path for a document URI.
 *
 * Always use this (not `URI.path`) when a URI is going to be handed to Node's
 * `path`/`fs` APIs. `URI.path` yields the URI path component, which on Windows is
 * `/c:/Users/foo/model.jd` (leading slash before the drive letter, forward
 * slashes) — feeding that to win32 `path.*`/`fs.*` produces a broken path.
 * `URI.fsPath` yields the native `c:\Users\foo\model.jd`. For POSIX-style file
 * URIs the two are identical; they diverge for Windows drive-letter URIs
 * (`file:///c:/…`) — including when parsed on a non-Windows host — which is where
 * the distinction matters.
 */
export function fsPathOf(uri: URI | string): string {
    return (typeof uri === 'string' ? URI.parse(uri) : uri).fsPath;
}

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
            // An element being typed has an id node with no parts yet. Naming it `''` would put
            // an entry under the empty string into the index; it has no name until it has one.
            return qualifiedIdText(id as QualifiedId) || undefined;
        }
        return super.getName(node);
    }

    /**
     * Returns the CST node spanning the declaration's identifier.
     *
     * Both branches are load-bearing, because `DefaultNameProvider.getNameNode` looks up a
     * property literally called `name` — which in this grammar is the element's *label*, never
     * its identifier. Falling through to it returns the wrong node for an element and no node at
     * all for a model, and returning no node is the more damaging of the two: `getSelfReferences`
     * silently skips any declaration whose name node is undefined, so a rename would rewrite
     * every usage and leave the declaration behind.
     */
    override getNameNode(node: AstNode): CstNode | undefined {
        const id = (node as unknown as Record<string, unknown>)['id'];
        // For QualifiedId nodes (Evidence, Strategy, etc.), the id is an AST node
        // with its own $cstNode spanning the full colon-delimited identifier.
        if (id && typeof id === 'object' && !Array.isArray(id)) {
            const cst = (id as { $cstNode?: CstNode }).$cstNode;
            if (cst) return cst;
        }
        // Justification and Template carry a plain `id` token instead.
        if (typeof id === 'string') {
            return GrammarUtils.findNodeForProperty(node.$cstNode, 'id');
        }
        return super.getNameNode(node);
    }
}

/**
 * Returns the colon-joined string form of a QualifiedId, e.g. ['t','abs'] → 't:abs'.
 *
 * Tolerates a missing id and returns `''`. `evidence ` with nothing after it parses to an element
 * whose `id` is absent, and that state exists for as long as it takes to type a name — so every
 * caller here is one a user passes through on the way to a valid model, not an edge case.
 */
export function qualifiedIdText(id: QualifiedId | undefined): string {
    return id?.parts?.join(':') ?? '';
}

/** Returns the last segment of a QualifiedId — the local name ('t:abs' → 'abs', 'e1' → 'e1'). */
export function localName(id: QualifiedId | undefined): string {
    return id?.parts?.at(-1) ?? '';
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
    const seen = new Set<Justification | Template>([node]);
    let parent = node.parent?.ref;
    while (parent && !seen.has(parent)) {
        seen.add(parent);
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
 *
 * A template may `implements` its way back to itself — the compiler reports that as
 * `cyclic-implements` — and the model is still in that state while the editor is looking at it.
 * Walking such a chain without the `seen` set exhausts the stack and takes the whole validation
 * pass down with it, so every element is visited at most once.
 */
export function getAllElements(
    node: Justification | Template,
    seen: Set<Justification | Template> = new Set()
): JustificationElement[] {
    if (seen.has(node)) return [];
    seen.add(node);
    const local = getLocalElements(node);
    const parentRef = node.parent?.ref;
    if (parentRef) {
        return [...local, ...getAllElements(parentRef, seen)];
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

/**
 * The element a `refine` hook names in `base`, or `undefined` if it names none.
 *
 * A port of the compiler's `JustificationModel.findById`, and it must stay one: this decides both
 * whether a hook is reported as unknown and whether renaming an element rewrites it, so a rule
 * stricter than the compiler's invents errors and a looser one misses them.
 *
 * Two ways to match, in the compiler's order. An **exact** id, and failing that a **suffix**: an
 * id ending in `':' + hook`, which is what lets `hook: "a"` name an element declared `T:a`. The
 * fallback exists because template expansion qualifies inherited elements, so the name the author
 * wrote in the template is not the id the element ends up with — verified against `jpipe`, which
 * builds that model without complaint.
 *
 * The compiler looks at the conclusion before the other elements. That ordering decides which of
 * two matching elements is returned, never whether one matches, so it is not reproduced here —
 * `getAllElements` yields local before inherited, which is the order that matters for a hook.
 *
 * **Its answer is only as good as `base` being a plain model.** A composed one resolves hooks
 * through aliases that no `.jd` file contains and that exist only once the operator has run, so
 * callers must exclude it rather than trust a `undefined` from here.
 */
export function hookTarget(
    base: Justification | Template,
    hook: string
): JustificationElement | undefined {
    if (!hook) return undefined;
    const elements = getAllElements(base);
    const exact = elements.find(element => qualifiedIdText(element.id) === hook);
    if (exact) return exact;
    const suffix = `:${hook}`;
    return elements.find(element => qualifiedIdText(element.id).endsWith(suffix));
}
