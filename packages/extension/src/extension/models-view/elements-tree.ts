/**
 * What the Outline view shows for one model: its own elements, then the ones it inherits, as the
 * language server lists them.
 *
 * The data is `textDocument/documentSymbol`, the request behind the Explorer's Outline, for the
 * model and for each template up its `implements` chain, which `typeHierarchy/supertypes` walks —
 * so the view needs nothing the server does not already provide. Everything with a decision in
 * it — which symbol is the model, which of its children count, which inherited elements are
 * still visible, how a row reads — is here, away from `vscode`, where it can be tested
 * (jpipe-vscode ADR-VSC-0004).
 */
import {
    SYMBOL_KIND_CLASS,
    SYMBOL_KIND_INTERFACE,
    TYPE_HIERARCHY_SUPERTYPES_REQUEST,
    keyOf,
    type Model,
    type Position,
    type Range,
    type RequestFn,
    type WireTypeHierarchyItem
} from './models-tree.js';

export const DOCUMENT_SYMBOL_REQUEST = 'textDocument/documentSymbol';

/** The part of an LSP `DocumentSymbol` this needs. */
export interface WireDocumentSymbol {
    name: string;
    kind: number;
    detail?: string;
    range: Range;
    selectionRange: Range;
    children?: WireDocumentSymbol[];
}

export type ElementKind = 'conclusion' | 'strategy' | 'evidence' | 'sub-conclusion' | 'support';

/**
 * The `SymbolKind` the server gives each kind of element (`elementKind` in jpipe-language's
 * `jpipe-symbol-provider.ts`): Constructor, Method, Field, Variable and TypeParameter.
 */
const ELEMENT_KINDS: Readonly<Record<number, ElementKind>> = {
    9: 'conclusion',
    6: 'strategy',
    8: 'evidence',
    13: 'sub-conclusion',
    26: 'support'
};

/** The prefix the server gives an element a model inherits from its template. */
const INHERITED_PREFIX = '(inherited) ';

/** The `(default)` namespace, under which a file's own models are listed. */
const DEFAULT_NAMESPACE = '(default)';

/** One element of the model, as a row. */
export interface Element {
    id: string;
    label?: string;
    kind: ElementKind;
    /** The whole declaration, to tell which element the cursor is in. */
    range: Range;
    /** The id, where the cursor goes when the row is clicked. */
    selection: Range;
    /** For an inherited element, the template declaring it; its ranges are in that file. */
    inheritedFrom?: { template: string; uri: string };
}

function contains(range: Range, position: Position): boolean {
    const after = (a: Position, b: Position) => a.line > b.line || (a.line === b.line && a.character >= b.character);
    return after(position, range.start) && after(range.end, position);
}

/**
 * The elements `model` itself declares, in the order written, or `undefined` if the file's
 * symbols do not include the model — it was renamed or deleted since it was selected.
 *
 * A file's outline also lists the models it loads, under the same `(default)` namespace and
 * possibly under the same name, so the model is the one whose range contains its own name. What
 * it inherits is left out here, because the server places those symbols on the model itself;
 * `fetchElements` reads them from the templates declaring them, where they have a place.
 */
export function elementsOf(symbols: readonly WireDocumentSymbol[], model: Model): Element[] | undefined {
    const namespace = symbols.find(s => s.name === DEFAULT_NAMESPACE);
    const symbol = namespace?.children?.find(s =>
        s.name === model.name && contains(s.range, model.selection.start));
    if (!symbol) return undefined;
    const elements: Element[] = [];
    for (const child of symbol.children ?? []) {
        const kind = ELEMENT_KINDS[child.kind];
        if (!kind || child.name.startsWith(INHERITED_PREFIX)) continue;
        elements.push({
            id: child.name,
            ...(child.detail !== undefined ? { label: child.detail } : {}),
            kind,
            range: child.range,
            selection: child.selectionRange
        });
    }
    return elements;
}

/**
 * The alias `template` is loaded under in the file whose symbols these are, or `undefined` when
 * it is declared there or loaded without one.
 *
 * A file's symbols list each aliased `load` as a namespace holding the models it brings in, so
 * the alias is the namespace listing a template of that name. Names are all there is to go by:
 * two aliased loads each bringing a template of the same name cannot be told apart here, and the
 * first is taken.
 */
function aliasOf(symbols: readonly WireDocumentSymbol[], template: string): string | undefined {
    const lists = (namespace: WireDocumentSymbol) => (namespace.children ?? []).some(s => s.name === template);
    if (symbols.some(s => s.name === DEFAULT_NAMESPACE && lists(s))) return undefined;
    return symbols.find(s => s.name !== DEFAULT_NAMESPACE && lists(s))?.name;
}

/** Whether `id`, declared nearer the model, is an override of `element` of `template`. */
const overrides = (id: string, template: string, element: string): boolean =>
    id === `${template}:${element}` || id.endsWith(`:${template}:${element}`);

/**
 * `model`'s elements: its own, then those it inherits, nearest template first, each under the id
 * the model refers to it by, as the compiler qualifies it (jpipe-compiler ADR-0012): `T:e1` for
 * `e1` of template `T`, `lib:T:e1` when `T` comes from a `load … as lib`. `undefined` if the
 * model is not in its file any more.
 *
 * An inherited element that has been overridden is not listed: `evidence T:slot` in the model,
 * or in a template between the model and `T`, is what `T:slot` now is, and it is already a row.
 * A template the server cannot place, or whose file cannot be read, ends the chain there rather
 * than failing the view: what was found is still true.
 */
export async function fetchElements(request: RequestFn, model: Model): Promise<Element[] | undefined> {
    const symbolsOf = async (uri: string) =>
        (await request(DOCUMENT_SYMBOL_REQUEST, { textDocument: { uri } }) ?? []) as WireDocumentSymbol[];

    const symbols = await symbolsOf(model.uri);
    const elements = elementsOf(symbols, model);
    if (!elements) return undefined;

    /** Ids as written by the model and by each template walked so far: what can override. */
    const nearer = elements.map(e => e.id);
    const visited = new Set<string>([model.key]);
    let item: WireTypeHierarchyItem = {
        name: model.name,
        kind: model.kind === 'template' ? SYMBOL_KIND_INTERFACE : SYMBOL_KIND_CLASS,
        uri: model.uri,
        range: model.selection,
        selectionRange: model.selection
    };
    for (;;) {
        let parent: WireTypeHierarchyItem | undefined;
        let declared: Element[] | undefined;
        try {
            parent = ((await request(TYPE_HIERARCHY_SUPERTYPES_REQUEST, { item }) ?? []) as WireTypeHierarchyItem[])[0];
            if (!parent) break;
            const key = keyOf(parent.uri, parent.name);
            if (visited.has(key)) break;
            visited.add(key);
            declared = elementsOf(await symbolsOf(parent.uri), {
                key, name: parent.name, kind: 'template', uri: parent.uri, selection: parent.selectionRange
            });
        } catch {
            break;
        }
        if (!declared) break;
        const template = parent.name;
        const alias = aliasOf(symbols, template);
        const inheritedFrom = { template, uri: parent.uri };
        const qualifier = alias ? `${alias}:${template}` : template;
        elements.push(...declared
            .filter(element => !nearer.some(id => overrides(id, template, element.id)))
            .map(element => ({ ...element, id: `${qualifier}:${element.id}`, inheritedFrom })));
        nearer.push(...declared.map(e => e.id));
        // Placed by its name, as `fetchModels` places a template: that is where the server looks.
        item = { ...parent, range: parent.selectionRange };
    }
    return elements;
}

/** How a row reads: `e1 • Tests pass`, or the id alone for an element with no label yet. */
export function elementLabel(element: Element): string {
    return element.label ? `${element.id} • ${element.label}` : element.id;
}

/** The icon of each kind of element. */
export const ELEMENT_ICONS: Readonly<Record<ElementKind, string>> = {
    conclusion: 'flag',
    'sub-conclusion': 'milestone',
    strategy: 'gear',
    evidence: 'file-text',
    // An `@support` is abstract, filled in by whoever implements the template: a type parameter.
    support: 'symbol-type-parameter'
};

/**
 * The theme colour of each kind of element, contributed in `package.json`.
 *
 * The defaults are the diagram's: the compiler colours each kind from the Okabe-Ito palette, which
 * stays distinguishable under every common colour-vision deficiency (jpipe-compiler ADR-0014), so
 * an element has the same colour in the outline as in the preview. On a dark theme the icons take
 * the diagram's fills as they are; on a light one, the darker base hues those fills were lightened
 * from. The conclusion's grey and the `@support`'s absence of colour become the theme's own
 * foreground and muted foreground.
 */
export const ELEMENT_COLORS: Readonly<Record<ElementKind, string>> = {
    conclusion: 'jpipe.conclusionIconForeground',
    'sub-conclusion': 'jpipe.subConclusionIconForeground',
    strategy: 'jpipe.strategyIconForeground',
    evidence: 'jpipe.evidenceIconForeground',
    support: 'jpipe.supportIconForeground'
};

/**
 * The element the cursor is in, if any. Elements never nest, so at most one contains it. An
 * inherited element is in another file, or elsewhere in this one, and is never the answer.
 */
export function elementAt(elements: readonly Element[], position: Position): Element | undefined {
    return elements.find(e => !e.inheritedFrom && contains(e.range, position));
}

/** Why the view is empty, or `undefined` when it has rows to show. */
export function emptyMessage(model: Model | undefined, elements: readonly Element[] | undefined): string | undefined {
    if (!model) return 'Select a model in Models to see its elements.';
    if (model.operator) {
        return `${model.name} is composed by ${model.operator}. Its elements only exist once the compiler runs it.`;
    }
    if (elements === undefined) return `${model.name} could not be found in its file.`;
    if (elements.length === 0) return `${model.name} has no elements.`;
    return undefined;
}
