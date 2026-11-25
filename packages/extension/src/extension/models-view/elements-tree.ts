/**
 * What the Outline view shows for one model: its elements, as the language server lists them.
 *
 * The list is the server's answer to `jpipe/modelContents`: `ModelContents.contentsOf`, the
 * question every rule asks (jpipe-vscode ADR-VSC-0034). So the elements of a model built on a
 * composition are the ones the compiler builds, under the ids it gives them, and those a model
 * inherits are the ones the compiler keeps once overrides are bound: none of it is worked out
 * here. What is decided here — how the answer becomes rows, how a row reads, which element the
 * cursor is in, what an empty or partial view says — stays away from `vscode`, where it can be
 * tested (jpipe-vscode ADR-VSC-0004).
 */
import type { ContentsRow, ModelContentsAnswer, ModelContentsParams } from 'jpipe-language';
import { MODEL_CONTENTS } from '../../shared/lsp-protocol.js';
import { rangeContains } from '../preview/document-symbols.js';
import type { Model, Position, Range, RequestFn } from './models-tree.js';

/** What `templateReach` reads of a symbol, which the editor's own `DocumentSymbol` also has. */
export interface NamedSymbol {
    readonly name: string;
    readonly kind: number;
    readonly children?: readonly NamedSymbol[];
}

export type ElementKind = 'conclusion' | 'strategy' | 'evidence' | 'sub-conclusion' | 'support';

/** The `(default)` namespace, under which a file's own models are listed. */
const DEFAULT_NAMESPACE = '(default)';

/** One element of the model, as a row. */
export interface Element {
    /** The id the compiler gives it in the model: `T:e1` for `e1` inherited from `T`. */
    id: string;
    label?: string;
    kind: ElementKind;
    /**
     * Where it is declared: the whole declaration, to tell which element the cursor is in, and its
     * id, where the cursor goes when the row is clicked. Absent for an element an operator made up.
     */
    location?: { uri: string; range: Range; selection: Range };
    /** The model declaring it, when that is not the model shown: a template it inherits, or a model it is built from. */
    declaredIn?: string;
    /** Merged by an operator from several elements; `location` is one of theirs. */
    merged?: boolean;
}

/** A model's elements, and whether they are all of them. */
export interface ElementList {
    /**
     * `false` when the server cannot tell: the compiler has not built a composition the model is
     * built on, as its files stand, or its `implements` chain loops or does not resolve. The list
     * then holds what the files declare, and an element missing from it may still be there.
     */
    complete: boolean;
    /** The model's own elements in the order written, then the others in the compiler's order. */
    elements: Element[];
}

/** The server's kinds are the compiler's, which call a `@support` an `abstract-support`. */
function elementOf(row: ContentsRow): Element {
    return {
        id: row.id,
        ...(row.label === undefined ? {} : { label: row.label }),
        kind: row.kind === 'abstract-support' ? 'support' : row.kind,
        ...(row.location ? { location: { uri: row.location.uri, range: row.location.range, selection: row.location.selection } } : {}),
        ...(row.declaredIn === undefined ? {} : { declaredIn: row.declaredIn }),
        ...(row.merged ? { merged: true } : {})
    };
}

/**
 * `model`'s elements, as the server lists them, or `undefined` if the model is not in its file
 * any more. The model is named by its file and name, and by where its name is, since a file may
 * load another model of that name.
 */
export async function fetchElements(request: RequestFn, model: Model): Promise<ElementList | undefined> {
    const params: ModelContentsParams = { uri: model.uri, name: model.name, position: model.selection.start };
    const answer = await request(MODEL_CONTENTS, params) as ModelContentsAnswer | null;
    if (!answer) return undefined;
    return { complete: answer.complete, elements: answer.elements.map(elementOf) };
}

/**
 * How the file whose symbols these are reaches `template`: `{}` when it declares it or loads it
 * without a name, `{ alias }` when it loads it `as` one, `undefined` when it does not reach it.
 *
 * A file's symbols list its own models and those of its plain loads under `(default)`, and each
 * aliased `load` as a namespace holding the models it brings in, a glob's matches included. Names
 * and kinds are all there is to go by: two loads each bringing a template of the same name
 * cannot be told apart here, and the plain one, then the first, is taken. `templateKind` is the
 * `SymbolKind` of a template, `Interface`, as the caller's symbols number it: 11 on the wire, 10
 * in the editor's own enum.
 */
export function templateReach(
    symbols: readonly NamedSymbol[],
    template: string,
    templateKind: number
): { alias?: string } | undefined {
    // A justification of that name is not the template: `implements` names templates only.
    const lists = (namespace: NamedSymbol) =>
        (namespace.children ?? []).some(s => s.name === template && s.kind === templateKind);
    if (symbols.some(s => s.name === DEFAULT_NAMESPACE && lists(s))) return {};
    const alias = symbols.find(s => s.name !== DEFAULT_NAMESPACE && lists(s))?.name;
    return alias === undefined ? undefined : { alias };
}

/** How a row reads: `e1 • Tests pass`, or the id alone for an element with no label yet. */
export function elementLabel(element: Element): string {
    return element.label ? `${element.id} • ${element.label}` : element.id;
}

/** What a row's tooltip says of an element, beyond its kind, id and label: where it comes from. */
export function elementOrigin(element: Element): string | undefined {
    if (!element.location) return 'Made by the composition';
    if (element.merged) return `Merged by the composition from several elements, one declared in ${element.declaredIn ?? 'this model'}`;
    return element.declaredIn === undefined ? undefined : `Declared in ${element.declaredIn}`;
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
 * The element the cursor is in, if any, the cursor being in the model's file. Elements never
 * nest, so at most one contains it. Only the model's own elements are declared there: one it
 * inherits or is built from is declared in another model, and is never the answer.
 */
export function elementAt(elements: readonly Element[], position: Position): Element | undefined {
    return elements.find(e => e.declaredIn === undefined && e.location !== undefined &&
        rangeContains(e.location.range, position.line, position.character));
}

/**
 * What the view says above its rows, or `undefined` when its rows say it all: why it is empty, or
 * that the list may be missing elements.
 */
export function viewMessage(model: Model | undefined, list: ElementList | undefined): string | undefined {
    if (!model) return 'Select a model in Models to see its elements.';
    if (list === undefined) return `${model.name} could not be found in its file.`;
    if (!list.complete) {
        return `Some elements of ${model.name} may be missing: only those its files declare are listed. ` +
            'A model built on a composition is listed whole once the compiler has built its saved files.';
    }
    if (list.elements.length === 0) return `${model.name} has no elements.`;
    return undefined;
}
