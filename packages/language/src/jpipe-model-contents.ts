/**
 * What a model's elements are, behind one question (jpipe-vscode ADR-VSC-0034).
 *
 * Every rule and provider that needs a model's whole element list asks `ModelContents.contentsOf`,
 * and none reads a body, calls `getAllElements` or `expandedElements`, or asks whether a model is
 * composed: that choice is made here, once. The answer is the model's effective elements, under the
 * ids the compiler gives them, or *cannot tell*, which a consumer answers by staying silent.
 *
 * Two implementations stand behind the question:
 *
 * - **declared** contents, read from the bodies (`expandedElements`), for a model whose `implements`
 *   chain is plain and resolves;
 * - **compiled** contents, for a model that builds on a composition. Its elements are the ones the
 *   operator builds, which only the compiler knows; until they are read from its JSON export
 *   (#132), the answer is *cannot tell*.
 *
 * Linking is the one reader left outside: Langium resolves references synchronously, during the
 * build, so the scope provider and the import service read the declarations themselves.
 */
import type { AstNode } from 'langium';
import type { JustificationElement, Justification, Template } from './generated/ast.js';
import { isConclusion } from './generated/ast.js';
import { expandedElements, getLocalElements, implementsChain, implementsLoops, type ExpandedElement } from './jpipe-utils.js';

/**
 * What `contentsOf` answers. `elements` is the whole list. `cannot-tell` says some elements are in
 * no body this can read; `visible` lists those it can, never enough to conclude that an element is
 * missing. Of those, `declared` are the model's own: an element found among them by its exact id is
 * the one the compiler finds, since what a model declares replaces any element of that id it
 * inherits. An inherited one may share its id with a hidden element, which the compiler finds first.
 */
export type Contents =
    | { readonly kind: 'elements'; readonly elements: readonly ExpandedElement[] }
    | {
        readonly kind: 'cannot-tell';
        readonly visible: readonly ExpandedElement[];
        readonly declared: readonly ExpandedElement[];
    };

/** *Cannot tell*, for `model`, with what its bodies show. */
function cannotTell(model: Justification | Template, namespace = ''): Contents {
    const visible = expandedElements(model, namespace);
    const own = new Set<AstNode>(getLocalElements(model));
    return { kind: 'cannot-tell', visible, declared: visible.filter(entry => own.has(entry.element)) };
}

/** The elements `contents` lists, whole or not. */
export function listedIn(contents: Contents): readonly ExpandedElement[] {
    return contents.kind === 'elements' ? contents.elements : contents.visible;
}

/**
 * One way of answering for a model's contents. `namespace` is the one the model is seen under from
 * the file asking, `lib` for a model reached as `lib:K`; ids are given as the compiler gives them
 * there (`expandedElements`).
 */
export interface ContentsSource {
    contentsOf(model: Justification | Template, namespace?: string): Promise<Contents>;
}

/**
 * Contents read from the bodies of the model and the templates it implements: the whole list for a
 * model whose chain is plain and resolves (`expandedElements`).
 */
export class DeclaredContents implements ContentsSource {
    async contentsOf(model: Justification | Template, namespace = ''): Promise<Contents> {
        return { kind: 'elements', elements: expandedElements(model, namespace) };
    }
}

/**
 * Contents of a model built on a composition: the elements its operator builds. Read from the
 * compiler's JSON export once #132 lands; until then *cannot tell*, with what the bodies show.
 */
export class CompiledContents implements ContentsSource {
    async contentsOf(model: Justification | Template, namespace = ''): Promise<Contents> {
        return cannotTell(model, namespace);
    }
}

/** The contents service the DI module binds: it picks which implementation answers. */
export class ModelContents {
    constructor(
        private readonly declared: ContentsSource = new DeclaredContents(),
        private readonly compiled: ContentsSource = new CompiledContents()
    ) {}

    /**
     * `model`'s effective elements, or *cannot tell*.
     *
     * - **A chain that loops** has no element list at all: the compiler reports `cyclic-implements`
     *   there and judges nothing else, so neither may this (`implementsCycle` finds the cycle).
     * - **A chain that does not resolve** stops at the missing template, and the inherited half of
     *   the list with it. That line is already reported as an unresolved reference, which points the
     *   user at the one thing to fix (#129).
     * - **A chain that reaches a composed model** (`template T is refine(P, Q) { hook: "a" }`) has
     *   elements no body declares, under ids such as `P:b`, which `implements` hands down to every
     *   model below it: compiled contents answer.
     * - **Any other chain** is plain: declared contents answer.
     *
     * `namespace` is the one `model` is seen under from the file asking: `lib` for a model reached
     * as `lib:K` (`writtenNamespace`), and the ids answered are the ones the compiler gives there.
     */
    async contentsOf(model: Justification | Template, namespace = ''): Promise<Contents> {
        const chain = implementsChain(model);
        if (implementsLoops(model) || chain.some(link => link.parent !== undefined && !link.parent.ref)) {
            return cannotTell(model, namespace);
        }
        if (chain.some(link => link.composition !== undefined)) return this.compiled.contentsOf(model, namespace);
        return this.declared.contentsOf(model, namespace);
    }
}

/**
 * The element a `refine` hook names in a base whose contents are `contents`, or `undefined` if it
 * names none.
 *
 * A port of the compiler's `JustificationModel.findById`, and it must stay one: this decides both
 * whether a hook is reported as unknown and whether renaming an element rewrites it, so a rule
 * stricter than the compiler's invents errors and a looser one misses them.
 *
 * It matches against effective ids, so `hook: "T:e"` names an `e` that `Base` inherits from `T`
 * without overriding it. Two ways to match, in the compiler's order. An **exact** id, and failing
 * that a **suffix**: an id ending in `':' + hook`, which is what lets `hook: "a"` name `T:a`. The
 * suffix pass skips the conclusion, as the compiler's does, so an inherited conclusion answers only
 * to its full `T:c`.
 *
 * When the contents *cannot tell*, some elements are hidden from this, and the compiler scans them
 * first. An exact id stays reliable among what the base declares itself, which replaces any
 * inherited element of that id, and nowhere else: an inherited element may share its id with a
 * hidden one, and a suffix may match a hidden one too. Only that exact pass runs then, so
 * `undefined` means "not found" for whole contents and "cannot tell" otherwise; callers must not
 * report the latter.
 */
export function hookTarget(contents: Contents, hook: string): JustificationElement | undefined {
    if (contents.kind === 'cannot-tell') return contents.declared.find(entry => entry.id === hook)?.element;
    const exact = contents.elements.find(entry => entry.id === hook);
    if (exact) return exact.element;
    const suffix = `:${hook}`;
    return contents.elements.find(entry => !isConclusion(entry.element) && entry.id.endsWith(suffix))?.element;
}
