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
 * - **compiled** contents, for a model that builds on a composition. The composed model's elements
 *   are the ones its operator builds, which only the compiler knows: they are read from its report
 *   (`jpipe-compiler-report.ts`), and the bodies of the models below it are read on top of them.
 *
 * Linking is the one reader left outside: Langium resolves references synchronously, during the
 * build, so the scope provider and the import service read the declarations themselves.
 */
import * as path from 'node:path';
import { AstUtils, type LangiumDocument } from 'langium';
import type { JustificationElement, Justification, Template } from './generated/ast.js';
import {
    buildsOnCycle, expandedElements, expandedOnto, fsPathOf, getLocalElements, implementsChain, implementsLoops,
    qualify, writtenNamespace, type ModelElement
} from './jpipe-utils.js';
import { fileKey } from './jpipe-import.js';
import type { CompilerReport, CompilerReports, ReportModel } from './jpipe-compiler-report.js';
import { RULE_CODES } from './jpipe-compiler-codes.js';

/**
 * What `contentsOf` answers. `elements` is the whole list, with the `aliases` the model's own
 * operator registered when it has one: an id it merged away, and the id that now names it.
 * `cannot-tell` says some elements are in no body this can read; `visible` lists those it can,
 * never enough to conclude that an element is missing. Of those, `declared` are the model's own:
 * an element found among them by its exact id is the one the compiler finds, since what a model
 * declares replaces any element of that id it inherits. An inherited one may share its id with a
 * hidden element, which the compiler finds first.
 */
export type Contents =
    | {
        readonly kind: 'elements';
        readonly elements: readonly ModelElement[];
        readonly aliases?: ReadonlyMap<string, string>;
    }
    | {
        readonly kind: 'cannot-tell';
        readonly visible: readonly ModelElement[];
        readonly declared: readonly ModelElement[];
    };

/** *Cannot tell*, for `model`, with what its bodies show. */
function cannotTell(model: Justification | Template, namespace = ''): Contents {
    const visible = expandedElements(model, namespace);
    const own = new Set<JustificationElement>(getLocalElements(model));
    return { kind: 'cannot-tell', visible, declared: visible.filter(entry => own.has(entry.element)) };
}

/** The elements `contents` lists, whole or not. */
export function listedIn(contents: Contents): readonly ModelElement[] {
    return contents.kind === 'elements' ? contents.elements : contents.visible;
}

/**
 * One way of answering for a model's contents. `namespace` is the one the model is seen under from
 * `from`, the document asking, which is the model's own unless said otherwise: `lib` for a model
 * reached as `lib:K`. Ids are given as the compiler gives them there (`expandedElements`).
 */
export interface ContentsSource {
    contentsOf(model: Justification | Template, namespace?: string, from?: LangiumDocument): Promise<Contents>;
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
 * Contents of a model built on a composition: the elements the compiler built for the composed
 * model nearest it on its chain, as the asking file's report gives them, with the bodies of the
 * models between read on top, as for a plain chain.
 *
 * The report is the file's as last saved, and it covers the whole file. A model is read from it
 * only when the compiler built it whole: when no error lies in it or in any model it is built
 * from. A model the compiler failed to build is still in the report, as far as it got, and its
 * elements are missing whatever came after the failure. *Cannot tell* is the answer then, and
 * whenever there is no report: no compiler, one too old, or a run that failed.
 */
export class CompiledContents implements ContentsSource {
    constructor(private readonly reports?: CompilerReports) {}

    async contentsOf(model: Justification | Template, namespace = '', from?: LangiumDocument): Promise<Contents> {
        const chain = implementsChain(model);
        // Each link's namespace as the asking file sees it, as `expandedElements` accumulates them.
        let linkNamespace = namespace;
        const index = chain.findIndex((link, i) => {
            if (i > 0) linkNamespace = qualify(linkNamespace, writtenNamespace(chain[i - 1].parent?.$refText, link.id));
            return link.composition !== undefined;
        });
        const base = chain[index];
        if (!base || !this.reports || buildsOnCycle(base)) return cannotTell(model, namespace);

        const document = from ?? AstUtils.getDocument(model);
        const report = await this.reports.reportOf(document);
        const built = report?.models.find(candidate => candidate.name === qualify(linkNamespace, base.id));
        if (!report || !built || !builtWhole(report, base, document)) return cannotTell(model, namespace);

        const elements = expandedOnto(model, namespace, base, elementsOf(built, base, report, document));
        return model === base
            ? { kind: 'elements', elements, aliases: new Map(built.aliases.map(alias => [alias.from, alias.to])) }
            : { kind: 'elements', elements };
    }
}

/** `model`, and every model it is built from: its operator's sources, or the template it implements, and theirs. */
function buildClosure(model: Justification | Template): Array<Justification | Template> {
    const closure: Array<Justification | Template> = [];
    const visit = (current: Justification | Template | undefined): void => {
        if (!current || closure.includes(current)) return;
        closure.push(current);
        if (current.composition) current.composition.params?.refs.forEach(ref => visit(ref.ref));
        else visit(current.parent?.ref);
    };
    visit(model);
    return closure;
}

/** The file `source` names in `report`, asked of `document`: the document's own when it is the report's. */
function fileOf(source: string | undefined, report: CompilerReport, document: LangiumDocument): string {
    const own = fsPathOf(document.uri);
    if (source === undefined || source === report.source) return own;
    return path.resolve(path.dirname(own), source);
}

/** The file a model is declared in, and the lines it spans there, 1-based as the compiler counts them. */
function spanOf(model: Justification | Template): { file: string; first: number; last: number } | undefined {
    const range = model.$cstNode?.range;
    if (!range) return undefined;
    return { file: fileKey(fsPathOf(AstUtils.getDocument(model).uri)), first: range.start.line + 1, last: range.end.line + 1 };
}

/**
 * Whether the compiler built `base` whole: whether no failure it reports lies in a model `base` is
 * built from, itself included. A failure it reports nowhere in particular, but under a code, may
 * be about any of them. The ones under no code are its summaries, `model construction failed`,
 * which repeat what it reported where it was. What its validation rules report is no failure to
 * build (`RULE_CODES`).
 */
function builtWhole(report: CompilerReport, base: Justification | Template, document: LangiumDocument): boolean {
    const spans = buildClosure(base).map(spanOf);
    if (spans.includes(undefined)) return false;
    return report.diagnostics.every(diagnostic => {
        if (diagnostic.code !== undefined && RULE_CODES.has(diagnostic.code)) return true;
        if (diagnostic.line === undefined) return diagnostic.code === undefined;
        const file = fileKey(fileOf(diagnostic.source, report, document));
        const line = diagnostic.line;
        return !spans.some(span => span!.file === file && span!.first <= line && line <= span!.last);
    });
}

/**
 * The elements of `built`, each tied to the declaration it was built from where it has one: the
 * element of a model `base` is built from whose id the compiler places it at. An element that is
 * the target of an alias was merged from several, and is marked so.
 */
function elementsOf(built: ReportModel, base: Justification | Template, report: CompilerReport, document: LangiumDocument): ModelElement[] {
    const declarations = new Map<string, JustificationElement>();
    for (const model of buildClosure(base)) {
        const file = fileKey(fsPathOf(AstUtils.getDocument(model).uri));
        for (const element of getLocalElements(model)) {
            const start = element.id?.$cstNode?.range.start;
            if (start) declarations.set(`${file}:${start.line + 1}:${start.character}`, element);
        }
    }
    const merged = new Set(built.aliases.map(alias => alias.to));
    return built.symbols.map(symbol => {
        const at = symbol.location;
        const element = at && declarations.get(`${fileKey(fileOf(at.source, report, document))}:${at.line}:${at.column}`);
        return {
            id: symbol.id,
            kind: symbol.kind,
            ...(element ? { element } : {}),
            ...(merged.has(symbol.id) ? { merged: true } : {})
        };
    });
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
     * `namespace` is the one `model` is seen under from `from`, the document asking, which is
     * `model`'s own when it is not given: `lib` for a model reached as `lib:K` (`writtenNamespace`),
     * and the ids answered are the ones the compiler gives there.
     */
    async contentsOf(model: Justification | Template, namespace = '', from?: LangiumDocument): Promise<Contents> {
        const chain = implementsChain(model);
        if (implementsLoops(model) || chain.some(link => link.parent !== undefined && !link.parent.ref)) {
            return cannotTell(model, namespace);
        }
        if (chain.some(link => link.composition !== undefined)) return this.compiled.contentsOf(model, namespace, from);
        return this.declared.contentsOf(model, namespace, from);
    }
}

/** `id` followed through `aliases` to the id it was last merged into, as the compiler's `resolveAlias` does. */
function followAliases(aliases: ReadonlyMap<string, string> | undefined, id: string): string {
    const seen = new Set<string>();
    let current = id;
    while (aliases?.has(current) && !seen.has(current)) {
        seen.add(current);
        current = aliases.get(current)!;
    }
    return current;
}

/**
 * The element a `refine` hook names in a base whose contents are `contents`, or `undefined` if it
 * names none.
 *
 * A port of the compiler's `RefineOperator.resolveHook`, and it must stay one: this decides both
 * whether a hook is reported as unknown and whether renaming an element rewrites it, so a rule
 * stricter than the compiler's invents errors and a looser one misses them.
 *
 * The hook is first followed through the base's aliases, since an operator may have merged the
 * element it names into another, under a new id, at any step: `both:a:e` names what `both`'s
 * unification made of `a:e`. Then it matches against effective ids, so `hook: "T:e"` names an `e`
 * that `Base` inherits from `T` without overriding it. Two ways to match, in the compiler's order.
 * An **exact** id, and failing that a **suffix**: an id ending in `':' + hook`, which is what lets
 * `hook: "a"` name `T:a`. The suffix pass skips the conclusion, so an inherited conclusion answers
 * only to its full `T:c`.
 *
 * When the contents *cannot tell*, some elements are hidden from this, and the compiler scans them
 * first. An exact id stays reliable among what the base declares itself, which replaces any
 * inherited element of that id, and nowhere else: an inherited element may share its id with a
 * hidden one, and a suffix may match a hidden one too. Only that exact pass runs then, so
 * `undefined` means "not found" for whole contents and "cannot tell" otherwise; callers must not
 * report the latter.
 */
export function hookTarget(contents: Contents, hook: string): ModelElement | undefined {
    if (contents.kind === 'cannot-tell') return contents.declared.find(entry => entry.id === hook);
    const id = followAliases(contents.aliases, hook);
    const exact = contents.elements.find(entry => entry.id === id);
    if (exact) return exact;
    const suffix = `:${id}`;
    return contents.elements.find(entry => entry.kind !== 'conclusion' && entry.id.endsWith(suffix));
}
