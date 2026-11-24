import { type AstNode, type CstNode, GrammarUtils, URI } from 'langium';
import { DefaultNameProvider } from 'langium';
import {
    isAbstractSupport,
    isConclusion,
    isEvidence,
    isSubConclusion,
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

/**
 * The namespace a reference to the model `id` is written with: `lib` for `lib:T`, empty for `T`.
 * A reference that does not end with the model's id, being edited say, is read as having none.
 */
export function writtenNamespace(refText: string | undefined, id: string): string {
    const written = (refText ?? '').replaceAll(/\s+/g, '');
    return written.endsWith(`:${id}`) ? written.slice(0, -(id.length + 1)) : '';
}

/** `name` under `namespace`: `lib:T`, or `T` under none. */
export function qualify(namespace: string, name: string): string {
    if (!namespace) return name;
    return name ? `${namespace}:${name}` : namespace;
}

/**
 * The id an element of template `parentName` has in a model implementing it: a plain id is
 * copied as `T:id`, and an id already qualified keeps its qualifier (`JustificationModel.inline`).
 */
export function inheritedId(parentName: string, id: string): string {
    return id.includes(':') ? id : `${parentName}:${id}`;
}

/** An element's kind, in the compiler's words (`type` in its exports, `kind` in its report). */
export type ElementKind = 'conclusion' | 'sub-conclusion' | 'strategy' | 'evidence' | 'abstract-support';

/** The kind `element` declares. */
export function kindOf(element: JustificationElement): ElementKind {
    switch (element.$type) {
        case 'Conclusion': return 'conclusion';
        case 'SubConclusion': return 'sub-conclusion';
        case 'Strategy': return 'strategy';
        case 'Evidence': return 'evidence';
        default: return 'abstract-support';
    }
}

/**
 * An element of a model, under the id the compiler gives it once `implements` is expanded and
 * every operator has run, with the kind it has there.
 *
 * `element` is its declaration, when there is one this can read. An element an operator makes up,
 * such as `assemble`'s conclusion, has none. One into which an operator merged several, as
 * unification does or `refine` does with its hook, is `merged`: `element` is then the declaration
 * of one of them, which is enough to go to but not to say which of them a name means. The kind is
 * the element's own, not always its declaration's: a refined `@support` is a sub-conclusion.
 */
export interface ModelElement {
    readonly id: string;
    readonly kind: ElementKind;
    readonly element?: JustificationElement;
    readonly merged?: boolean;
    /**
     * A `@support` an override named among others, ambiguously: the compiler reports that
     * override, where it is, and requires no other override of the `@support` elements it named.
     */
    readonly contested?: boolean;
}

/** An element some body declares: its declaration is always there. */
export interface ExpandedElement extends ModelElement {
    readonly element: JustificationElement;
}

/**
 * Every element of `model` under its **effective** id: the one the compiler's model carries after
 * template expansion, which is not always the one written in the file.
 *
 * A port of `JustificationModel.inline`. An inherited element is copied as `Decl:id`, where `Decl`
 * is the template that declared it, and an id already qualified keeps its qualifier — so an element
 * `U` declares is `U:e` in a model two `implements` below it, never `T:U:e`. A local element keeps
 * the id it is written with, and replaces the inherited one it shares an id with: that is how
 * `evidence T:a` overrides `@support a`. An override with no element of its id is bound as the
 * compiler binds it (`bind`): it replaces the one `@support` its id ends, under that `@support`'s
 * id, and an override naming several replaces none and marks them `contested`. A conclusion written in a model that `implements` a
 * template is left out: the compiler reports it as `inherited-conclusion` and discards it, so the
 * model keeps the conclusion it inherits, and a hook or an override answers to that one.
 *
 * `namespace` is the one `model` is seen under, from the file the question is asked in: `lib` for a
 * model of a file loaded `as lib`, empty for one of that file. The compiler names everything of a
 * file loaded under a namespace with it, models and the qualified ids written there alike, so a
 * template `T` of that file is `lib:T`, an element `a` it hands down is `lib:T:a`, and an override
 * written `U:x` in it is `lib:U:x`. Namespaces compose along nested loads, so each `implements`
 * adds the one its reference is written with (`writtenNamespace`).
 *
 * Inherited elements come first and local ones after, which is the compiler's order and the one a
 * suffix match is first-found in. The AST node is the declaration, so identity survives the
 * renaming — which is what lets rename follow a hook spelled with the effective id.
 */
export function expandedElements(
    model: Justification | Template,
    namespace = '',
    seen: Set<Justification | Template> = new Set()
): ExpandedElement[] {
    return expand(model, namespace, seen) as ExpandedElement[];
}

/**
 * Every element of `model`, as `expandedElements` gives them, except that the elements of `base`
 * are `elements`: those the compiler built for it, which is how a model is read on top of a
 * composed template. `namespace` is as there; `elements` carry theirs already.
 */
export function expandedOnto(
    model: Justification | Template,
    namespace: string,
    base: Justification | Template,
    elements: readonly ModelElement[]
): ModelElement[] {
    return expand(model, namespace, new Set(), base, elements);
}

function expand(
    model: Justification | Template,
    namespace: string,
    seen: Set<Justification | Template>,
    base?: Justification | Template,
    baseElements: readonly ModelElement[] = []
): ModelElement[] {
    if (model === base) return [...baseElements];
    if (seen.has(model)) return [];
    seen.add(model);
    const parent = model.parent?.ref;
    let inherited: ModelElement[] = [];
    if (parent) {
        const parentNamespace = qualify(namespace, writtenNamespace(model.parent?.$refText, parent.id));
        const parentName = qualify(parentNamespace, parent.id);
        inherited = expand(parent, parentNamespace, seen, base, baseElements)
            .map(entry => ({ ...entry, id: inheritedId(parentName, entry.id) }));
    }
    // An override is bound as the compiler binds it, and takes the id of the `@support` it
    // names: `evidence T:a` replaces `lib:T:a`. One naming several replaces none.
    let kept = inherited;
    const contested = new Set<ModelElement>();
    const local: ModelElement[] = [];
    for (const element of getLocalElements(model)) {
        if (isDiscardedConclusion(element)) continue;
        const written = qualifiedIdText(element.id);
        const entry = { element, kind: kindOf(element), id: written.includes(':') ? qualify(namespace, written) : written };
        const overrides = (isEvidence(element) || isSubConclusion(element)) && written.includes(':');
        if (overrides && !kept.some(candidate => candidate.id === entry.id)) {
            const binding = bind(kept, entry.id);
            if (binding.kind === 'ambiguous') {
                binding.candidates.forEach(candidate => contested.add(candidate));
                continue;
            }
            if (binding.kind === 'found' && binding.element.kind === 'abstract-support') {
                kept = kept.filter(candidate => candidate !== binding.element);
                local.push({ ...entry, id: binding.element.id });
                continue;
            }
        }
        local.push(entry);
    }
    const replaced = new Set(local.map(entry => entry.id));
    return [
        ...kept.filter(entry => !replaced.has(entry.id)).map(entry => contested.has(entry) ? { ...entry, contested: true } : entry),
        ...local
    ];
}

/** What an id names: one element, several, or none. */
export type Binding =
    | { readonly kind: 'found'; readonly element: ModelElement }
    | { readonly kind: 'ambiguous'; readonly candidates: readonly ModelElement[] }
    | { readonly kind: 'missing' };

/**
 * What `id`, as the source writes it, names among `elements`: a port of the compiler's
 * `JustificationModel.bind`. The element with exactly that id; failing that, the elements whose id
 * ends with `':' + id`, the conclusion last, which are an ambiguity when there are several
 * (`ambiguous-id`, jpipe-compiler ADR-0012).
 */
export function bind(elements: readonly ModelElement[], id: string): Binding {
    const exact = elements.find(entry => entry.id === id);
    if (exact) return { kind: 'found', element: exact };
    const suffix = `:${id}`;
    const matching = elements.filter(entry => entry.id.endsWith(suffix));
    const candidates = [
        ...matching.filter(entry => entry.kind !== 'conclusion'),
        ...matching.filter(entry => entry.kind === 'conclusion')
    ];
    if (candidates.length > 1) return { kind: 'ambiguous', candidates };
    return candidates.length === 1 ? { kind: 'found', element: candidates[0] } : { kind: 'missing' };
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
