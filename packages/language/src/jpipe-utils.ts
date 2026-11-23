import { type AstNode, type CstNode, GrammarUtils, URI } from 'langium';
import { DefaultNameProvider } from 'langium';
import {
    type AbstractSupport,
    isAbstractSupport,
    isConclusion,
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

/** Whether `model`'s `implements` chain comes back to a model already on it (`cyclic-implements`). */
export function implementsLoops(model: Justification | Template): boolean {
    // The walk stops at a link with no parent, or at one whose parent it has already visited.
    return implementsChain(model).at(-1)?.parent?.ref !== undefined;
}

/**
 * The cycle `model`'s `implements` closes, in order from `model`, or `undefined` if it closes none.
 *
 * A port of the compiler's `ExecutionFailureDiagnostics.cycleThrough`, which decides what
 * `cyclic-implements` reports. A model waits on the template it implements, and a composed model
 * on its operator's sources, so a cycle may run through both:
 * `cyc implements built, which 'assemble' builds from cyc`. The walk is depth first from the
 * template, in the order the model names what it waits on, and visits each model once. A model
 * that implements a template on a cycle without being on it closes none, and nor does a composed
 * model, whose `implements` the compiler refuses rather than follows.
 */
export function implementsCycle(model: Justification | Template): Array<Justification | Template> | undefined {
    const template = model.composition ? undefined : model.parent?.ref;
    if (!template) return undefined;
    const path: Array<Justification | Template> = [model];
    const visited = new Set<Justification | Template>();
    const extend = (next: Justification | Template): boolean => {
        if (next === model) return true;
        if (visited.has(next)) return false;
        visited.add(next);
        path.push(next);
        if (waitsOn(next).some(extend)) return true;
        path.pop();
        return false;
    };
    return extend(template) ? path : undefined;
}

/**
 * Whether building `model` waits on a cycle anywhere below it: through the templates it implements
 * and the sources of the operators that build them, as `waitsOn` follows them. The compiler builds
 * nothing that waits on a cycle, and reports only the cycle (`cyclic-implements`), even where no
 * model of `model`'s own chain is on it: `J implements Top`, `Top implements built`, and `built`
 * assembled from a model that implements `built`.
 */
export function buildsOnCycle(model: Justification | Template): boolean {
    const done = new Set<Justification | Template>();
    const onPath = new Set<Justification | Template>();
    const visit = (current: Justification | Template): boolean => {
        if (onPath.has(current)) return true;
        if (done.has(current)) return false;
        onPath.add(current);
        const found = waitsOn(current).some(visit);
        onPath.delete(current);
        done.add(current);
        return found;
    };
    return visit(model);
}

/**
 * The models `model` is built from: its operator's sources, or else the template it implements.
 * The compiler builds a composed model from its sources alone, and refuses an `implements` written
 * beside them (`invalid-operator-call`), so that edge is not part of its graph.
 */
function waitsOn(model: Justification | Template): Array<Justification | Template> {
    const next = model.composition
        ? model.composition.params?.refs.map(ref => ref.ref) ?? []
        : [model.parent?.ref];
    return next.filter((link): link is Justification | Template => link !== undefined);
}

/**
 * `model`, then each template its `implements` chain names, as far as they resolve.
 *
 * Each model is visited once: a template may `implements` its way back to itself — the compiler
 * reports that as `cyclic-implements` — and the model is in that state while it is being edited.
 */
export function implementsChain(model: Justification | Template): Array<Justification | Template> {
    const chain: Array<Justification | Template> = [];
    let current: Justification | Template | undefined = model;
    while (current && !chain.includes(current)) {
        chain.push(current);
        current = current.parent?.ref;
    }
    return chain;
}

/** An element of a model, under the id the compiler gives it once `implements` is expanded. */
export interface ExpandedElement {
    readonly element: JustificationElement;
    readonly id: string;
}

/**
 * Every element of `model` under its **effective** id: the one the compiler's model carries after
 * template expansion, which is not always the one written in the file.
 *
 * A port of `JustificationModel.inline`. An inherited element is copied as `Decl:id`, where `Decl`
 * is the template that declared it, and an id already qualified keeps its qualifier — so an element
 * `U` declares is `U:e` in a model two `implements` below it, never `T:U:e`. A local element keeps
 * the id it is written with, and replaces the inherited one it shares an id with: that is how
 * `evidence T:a` overrides `@support a`. A conclusion written in a model that `implements` a
 * template is left out: the compiler reports it as `inherited-conclusion` and discards it, so the
 * model keeps the conclusion it inherits, and a hook or an override answers to that one.
 *
 * Inherited elements come first and local ones after, which is the compiler's order and the one a
 * suffix match is first-found in. The AST node is the declaration, so identity survives the
 * renaming — which is what lets rename follow a hook spelled with the effective id.
 */
export function expandedElements(
    model: Justification | Template,
    seen: Set<Justification | Template> = new Set()
): ExpandedElement[] {
    if (seen.has(model)) return [];
    seen.add(model);
    const parent = model.parent?.ref;
    const inherited = parent
        ? expandedElements(parent, seen).map(({ element, id }) =>
            ({ element, id: id.includes(':') ? id : `${parent.id}:${id}` }))
        : [];
    const local = getLocalElements(model)
        .filter(element => !isDiscardedConclusion(element))
        .map(element => ({ element, id: qualifiedIdText(element.id) }));
    const replaced = new Set(local.map(entry => entry.id));
    return [...inherited.filter(entry => !replaced.has(entry.id)), ...local];
}

/**
 * Whether `element` is a conclusion the compiler throws away: one declared by a model that
 * `implements` a template, and so inherits its conclusion.
 *
 * The compiler refuses it while reading the file (`inherited-conclusion`, from the declaration
 * alone) and drops it together with every relation that uses it, before any other rule runs. Every
 * check must therefore read the model as if it were not written: it does not satisfy
 * `conclusion-present`, support a strategy, override a `@support`, clash with another id, or need
 * support of its own.
 */
export function isDiscardedConclusion(element: AstNode | undefined): boolean {
    return isConclusion(element) && element.$container?.$container?.parent !== undefined;
}

/** A `@support` a justification must override, and the id the override has to be written with. */
export interface RequiredOverride {
    readonly support: AbstractSupport;
    readonly expectedKey: string;
    readonly sourceTemplateId: string;
}

/**
 * The `@support` elements a justification implementing `template` must override.
 *
 * `seen` guards the `implements` walk: a template may point back at itself, which the
 * compiler reports as `cyclic-implements`, and the model sits in that state while it is being
 * edited. Recursing through such a chain would exhaust the stack and abort validation for the
 * whole document.
 */
export function requiredOverrides(
    template: Template,
    refText: string,
    seen: Set<Template> = new Set()
): RequiredOverride[] {
    if (seen.has(template)) return [];
    seen.add(template);
    const local = template.contents?.body ?? [];
    // Keys of non-abstract elements defined directly in this template (these override parent abstracts)
    const localOverrideKeys = new Set(
        local.filter(e => !isAbstractSupport(e) && !isDiscardedConclusion(e)).map(e => qualifiedIdText(e.id))
    );
    const result: RequiredOverride[] = [];

    // Abstract supports declared directly in this template
    for (const elem of local) {
        if (isAbstractSupport(elem)) {
            result.push({
                support: elem,
                expectedKey: `${refText}:${qualifiedIdText(elem.id)}`,
                sourceTemplateId: template.id
            });
        }
    }

    // Propagate unresolved abstract supports from the parent chain
    if (template.parent?.ref) {
        const parentRefText = template.parent.$refText ?? template.parent.ref.id;
        for (const req of requiredOverrides(template.parent.ref, parentRefText, seen)) {
            // Skip if this template already provides a non-abstract override for it
            if (!localOverrideKeys.has(req.expectedKey)) {
                result.push(req);
            }
        }
    }

    return result;
}
