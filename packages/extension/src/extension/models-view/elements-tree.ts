/**
 * What the Outline view shows for one model: its own elements, as the language server lists them.
 *
 * The data is `textDocument/documentSymbol`, the request behind the Explorer's Outline, so the
 * view needs nothing the server does not already provide. Everything with a decision in it — which
 * symbol is the model, which of its children count, how a row reads — is here, away from `vscode`,
 * where it can be tested (jpipe-vscode ADR-VSC-0004).
 */
import type { Model, Range, Position } from './models-tree.js';

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
 * it inherits from its template is left out: the view is about what this model says.
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

/** How a row reads: `e1 • Tests pass`, or the id alone for an element with no label yet. */
export function elementLabel(element: Element): string {
    return element.label ? `${element.id} • ${element.label}` : element.id;
}

/** The icon of each kind of element. */
export const ELEMENT_ICONS: Readonly<Record<ElementKind, string>> = {
    conclusion: 'flag',
    'sub-conclusion': 'milestone',
    strategy: 'lightbulb',
    evidence: 'file-text',
    // An `@support` is a slot an implementation fills in.
    support: 'circle-large-outline'
};

/** The element the cursor is in, if any. Elements never nest, so at most one contains it. */
export function elementAt(elements: readonly Element[], position: Position): Element | undefined {
    return elements.find(e => contains(e.range, position));
}

/** Why the view is empty, or `undefined` when it has rows to show. */
export function emptyMessage(model: Model | undefined, elements: readonly Element[] | undefined): string | undefined {
    if (!model) return 'Select a model in Models to see its elements.';
    if (model.operator) {
        return `${model.name} is composed by ${model.operator}. Its elements only exist once the compiler runs it.`;
    }
    if (elements === undefined) return `${model.name} could not be found in its file.`;
    if (elements.length === 0) return `${model.name} declares no elements of its own.`;
    return undefined;
}
