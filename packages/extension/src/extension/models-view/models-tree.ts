/**
 * What the Models view shows, worked out from what the language server says.
 *
 * Everything with a decision in it lives here, away from `vscode`, so it can be tested
 * (jpipe-vscode ADR-VSC-0004): which requests to make, how their answers become a tree, and which
 * model the cursor is in. `models-view.ts` only puts the result on screen.
 *
 * The server is asked standard questions and nothing else. `workspace/symbol` lists every model,
 * already labelled template or justification. `typeHierarchy/subtypes`, asked of each template,
 * says what implements it. `textDocument/prepareCallHierarchy`, asked of each model, says whether
 * it is a composition — its item's `detail` is the operator — and `callHierarchy/outgoingCalls`,
 * asked of each composition, lists its operands. No custom protocol: the same answers drive the
 * editor's Go to Symbol in Workspace, Show Type Hierarchy and Show Call Hierarchy.
 */

/** The LSP `SymbolKind`s the server gives models (see `modelSymbolKind` in jpipe-language). */
export const SYMBOL_KIND_CLASS = 5;
export const SYMBOL_KIND_INTERFACE = 11;

export const WORKSPACE_SYMBOL_REQUEST = 'workspace/symbol';
export const TYPE_HIERARCHY_SUBTYPES_REQUEST = 'typeHierarchy/subtypes';
export const PREPARE_CALL_HIERARCHY_REQUEST = 'textDocument/prepareCallHierarchy';
export const CALL_HIERARCHY_OUTGOING_REQUEST = 'callHierarchy/outgoingCalls';

/**
 * The parts of the LSP shapes this needs, declared structurally: the values arrive as plain JSON,
 * and describing them as data is what keeps this module loadable outside an extension host.
 */
export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }

export interface WireWorkspaceSymbol {
    name: string;
    kind: number;
    /** A `WorkspaceSymbol` may leave the range for later resolution; the server never does. */
    location: { uri: string; range?: Range };
}

export interface WireTypeHierarchyItem {
    name: string;
    kind: number;
    detail?: string;
    uri: string;
    range: Range;
    selectionRange: Range;
}

/** A call hierarchy item has the same shape. */
export type WireCallHierarchyItem = WireTypeHierarchyItem;

export interface WireOutgoingCall {
    to: WireCallHierarchyItem;
    fromRanges: Range[];
}

/** Sends one request to the language server. */
export type RequestFn = (method: string, params: unknown) => Promise<unknown>;

export type ModelKind = 'template' | 'justification';

/** A model, as the view knows it: where it is declared and what it implements. */
export interface Model {
    /** `uri#name` — names are only unique within a file. */
    key: string;
    name: string;
    kind: ModelKind;
    uri: string;
    /** The model's name in its declaration. */
    selection: Range;
    /** The key of the template this model implements, if that template is in the workspace. */
    parentKey?: string;
    /** The operator, for a model that is a composition: `assemble`, `refine`… */
    operator?: string;
    /** A composition's operands, as keys, in the order written. */
    operands?: string[];
}

export const keyOf = (uri: string, name: string): string => `${uri}#${name}`;

function kindOf(symbolKind: number): ModelKind | undefined {
    if (symbolKind === SYMBOL_KIND_INTERFACE) return 'template';
    if (symbolKind === SYMBOL_KIND_CLASS) return 'justification';
    return undefined;
}

const ZERO: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

/**
 * Every model in the workspace, each with its parent template resolved.
 *
 * One `workspace/symbol` request, then one `typeHierarchy/subtypes` request per template, in
 * parallel. Asking templates for their subtypes rather than every model for its supertype keeps
 * the count down to the number of templates, which in practice is a handful.
 *
 * The subtypes request is built straight from the symbol rather than through
 * `textDocument/prepareTypeHierarchy`: the server locates the model by the start of the item's
 * range, and a symbol's range is its name, so the extra round trip would return what is already
 * known. A template the server cannot place answers `null`, and it is simply left without
 * children rather than failing the whole view.
 */
export async function fetchModels(request: RequestFn): Promise<Model[]> {
    const symbols = (await request(WORKSPACE_SYMBOL_REQUEST, { query: '' }) ?? []) as WireWorkspaceSymbol[];

    const models = new Map<string, Model>();
    for (const symbol of symbols) {
        const kind = kindOf(symbol.kind);
        if (!kind || !symbol.name) continue;
        const key = keyOf(symbol.location.uri, symbol.name);
        models.set(key, {
            key,
            name: symbol.name,
            kind,
            uri: symbol.location.uri,
            selection: symbol.location.range ?? ZERO
        });
    }

    const templates = [...models.values()].filter(m => m.kind === 'template');
    const subtypes = await Promise.all(templates.map(async template => {
        const item: WireTypeHierarchyItem = {
            name: template.name,
            kind: SYMBOL_KIND_INTERFACE,
            uri: template.uri,
            range: template.selection,
            selectionRange: template.selection
        };
        try {
            return (await request(TYPE_HIERARCHY_SUBTYPES_REQUEST, { item }) ?? []) as WireTypeHierarchyItem[];
        } catch {
            return [];
        }
    }));

    templates.forEach((template, i) => {
        for (const child of subtypes[i]) {
            const model = models.get(keyOf(child.uri, child.name));
            if (model) model.parentKey = template.key;
        }
    });

    await Promise.all([...models.values()].map(model => readComposition(request, model)));
    return [...models.values()];
}

/**
 * Whether `model` is a composition, and if so of what.
 *
 * Asked of every model, since nothing else says which are compositions; a model the server cannot
 * place, or a written one, is simply left without an operator.
 */
async function readComposition(request: RequestFn, model: Model): Promise<void> {
    try {
        const items = (await request(PREPARE_CALL_HIERARCHY_REQUEST, {
            textDocument: { uri: model.uri },
            position: model.selection.start
        }) ?? []) as WireCallHierarchyItem[];
        const item = items[0];
        if (!item?.detail) return;
        model.operator = item.detail;
        const calls = (await request(CALL_HIERARCHY_OUTGOING_REQUEST, { item }) ?? []) as WireOutgoingCall[];
        model.operands = [...calls]
            .sort((a, b) => compareRanges(a.fromRanges[0], b.fromRanges[0]))
            .map(call => keyOf(call.to.uri, call.to.name));
    } catch {
        // Not a composition as far as the view can tell; the rest of the view stands.
    }
}

function compareRanges(a: Range | undefined, b: Range | undefined): number {
    if (!a || !b) return 0;
    return a.start.line - b.start.line || a.start.character - b.start.character;
}

/** A row in the tree. */
export type TreeNode = GroupNode | ModelNode;

export type GroupId = 'errors' | 'templates' | 'justifications' | 'compositions' | 'excluded';

export interface GroupNode {
    type: 'group';
    /** Stable, so VS Code keeps the group's expanded state across refreshes. */
    id: GroupId;
    label: string;
    children: ModelNode[];
}

export interface ModelNode {
    type: 'model';
    /** Unique within the tree: a model can appear in more than one group. */
    id: string;
    model: Model;
    /** The name of the template this model implements, for display. */
    parentName?: string;
    /** How many errors the model has; set on the nodes of the Errors group. */
    errors?: number;
    children: ModelNode[];
    parent: TreeNode;
}

/**
 * What the editor knows about a model's file that the language server's symbols do not say.
 *
 * Passed in rather than looked up, so that the grouping can be tested without diagnostics or
 * settings to read.
 */
export interface ModelStatus {
    /** Whether the file is excluded from jPipe validation. */
    isExcluded(uri: string): boolean;
    /** The zero-based start lines of the file's error diagnostics. */
    errorLines(uri: string): readonly number[];
}

const NO_STATUS: ModelStatus = { isExcluded: () => false, errorLines: () => [] };

const byName = (a: Model, b: Model): number =>
    a.name.localeCompare(b.name) || a.uri.localeCompare(b.uri);

/** Templates before justifications, then by name. */
const templatesFirst = (a: Model, b: Model): number =>
    (a.kind === b.kind ? 0 : a.kind === 'template' ? -1 : 1) || byName(a, b);

/**
 * How many errors each model has.
 *
 * A diagnostic belongs to the model whose declaration it falls in, found the way the cursor's
 * model is (`modelAtLine`). One above every model — on a `load` — belongs to all of the file's
 * models: a load that does not resolve leaves each of them referring to things that are not
 * there, so every one of them fails to build.
 */
export function errorCounts(models: readonly Model[], errorLines: (uri: string) => readonly number[]): Map<string, number> {
    const byFile = new Map<string, Model[]>();
    for (const model of models) {
        const inFile = byFile.get(model.uri) ?? [];
        inFile.push(model);
        byFile.set(model.uri, inFile);
    }
    const counts = new Map<string, number>();
    const add = (model: Model) => counts.set(model.key, (counts.get(model.key) ?? 0) + 1);
    for (const [uri, inFile] of byFile) {
        for (const line of errorLines(uri)) {
            const owner = modelAtLine(inFile, line);
            if (owner) add(owner);
            else inFile.forEach(add);
        }
    }
    return counts;
}

/**
 * The groups the view shows, in this order:
 *
 * - **Errors** — every model that has an error, flat, with how many. An overlay, not a partition:
 *   a model with errors stays in its own group too, because it is still part of the argument,
 *   only broken. An error is something the build fails on (jpipe-vscode ADR-VSC-0023), so this is
 *   the list of models that will not build. It comes first since, when it is there at all, it is
 *   what needs doing.
 * - **Templates** — the `implements` forest: a template whose parent is not shown here is a
 *   root, and each template lists what implements it, templates first, then justifications.
 * - **Compositions** — every model made by an operator, each listing the models it is made of,
 *   in the order written. Placed under Templates since both are about how models are built from
 *   other models. A composed justification is listed here and not under Justifications: it is
 *   produced, not written, and that is the first thing to know about it. A composed template stays
 *   in the Templates forest as well, since other models may implement it and that is where they
 *   are listed. An operand that is itself a composition lists its own operands in turn, down to
 *   the written models; a composition already on the path is not descended into again.
 * - **Justifications** — every justification written by hand, flat, which is the list most
 *   people come for. A justification implementing a template therefore appears under both, which
 *   lets each group answer its own question without the other.
 * - **Excluded** — models in files excluded from validation, flat. A partition: they leave the
 *   two groups above, because excluding a file says it is not part of the argument — counter-
 *   examples, drafts, fixtures — and listing it among the real models would say the opposite.
 *   They cannot be in Errors either, since nothing validates them.
 *
 * A cycle of templates is a modelling error the validator reports, but the tree must still be
 * finite: a template already on the current path is not descended into again. Templates only
 * reachable through such a cycle have no root, so they are listed as roots themselves rather than
 * vanishing from the view.
 *
 * Empty groups are left out, so a healthy workspace with no templates shows only its
 * justifications.
 */
export function buildTree(models: readonly Model[], status: ModelStatus = NO_STATUS): GroupNode[] {
    const byKey = new Map(models.map(m => [m.key, m]));
    const parentName = (m: Model) => m.parentKey ? byKey.get(m.parentKey)?.name : undefined;
    const flat = (group: GroupNode, members: Model[]): ModelNode[] => members.map(model => ({
        type: 'model' as const,
        id: `${group.id}>${model.key}`,
        model,
        parentName: parentName(model),
        children: [],
        parent: group
    }));

    const excludedModels = models.filter(m => status.isExcluded(m.uri));
    const included = models.filter(m => !status.isExcluded(m.uri));
    const shown = new Set(included.map(m => m.key));

    const children = new Map<string, Model[]>();
    for (const model of included) {
        if (!model.parentKey || !shown.has(model.parentKey)) continue;
        const siblings = children.get(model.parentKey) ?? [];
        siblings.push(model);
        children.set(model.parentKey, siblings);
    }

    const templates: GroupNode = { type: 'group', id: 'templates', label: 'Templates', children: [] };
    const placed = new Set<string>();

    const grow = (model: Model, parent: TreeNode, path: readonly string[]): ModelNode => {
        placed.add(model.key);
        const id = [...path, model.key].join('>');
        const node: ModelNode = { type: 'model', id, model, parentName: parentName(model), children: [], parent };
        if (model.kind === 'template' && !path.includes(model.key)) {
            node.children = (children.get(model.key) ?? [])
                .filter(child => !path.includes(child.key) && child.key !== model.key)
                .sort(templatesFirst)
                .map(child => grow(child, node, [...path, model.key]));
        }
        return node;
    };

    const allTemplates = included.filter(m => m.kind === 'template').sort(byName);
    for (const template of allTemplates) {
        if (template.parentKey && shown.has(template.parentKey)) continue;
        templates.children.push(grow(template, templates, ['templates']));
    }
    for (const template of allTemplates) {
        if (!placed.has(template.key)) templates.children.push(grow(template, templates, ['templates']));
    }

    const justifications: GroupNode = { type: 'group', id: 'justifications', label: 'Justifications', children: [] };
    justifications.children = flat(justifications,
        included.filter(m => m.kind === 'justification' && m.operator === undefined).sort(byName));

    const counts = errorCounts(included, status.errorLines);
    const errors: GroupNode = { type: 'group', id: 'errors', label: 'Errors', children: [] };
    errors.children = flat(errors, included.filter(m => counts.has(m.key)).sort(templatesFirst))
        .map(node => ({ ...node, errors: counts.get(node.model.key) }));

    const compositions: GroupNode = { type: 'group', id: 'compositions', label: 'Compositions', children: [] };
    const compose = (model: Model, parent: TreeNode, path: readonly string[]): ModelNode => {
        const node: ModelNode = {
            type: 'model', id: [...path, model.key].join('>'), model,
            parentName: parentName(model), children: [], parent
        };
        if (!path.includes(model.key)) {
            node.children = (model.operands ?? [])
                .map(key => byKey.get(key))
                .filter((operand): operand is Model => operand !== undefined && !path.includes(operand.key))
                .map(operand => compose(operand, node, [...path, model.key]));
        }
        return node;
    };
    compositions.children = included
        .filter(m => m.operator !== undefined)
        .sort(templatesFirst)
        .map(model => compose(model, compositions, ['compositions']));

    const excluded: GroupNode = { type: 'group', id: 'excluded', label: 'Excluded', children: [] };
    excluded.children = flat(excluded, excludedModels.sort(templatesFirst));

    return [errors, templates, compositions, justifications, excluded].filter(group => group.children.length > 0);
}

/**
 * Names held by more than one model. The view shows a model's file only on hover, except for
 * these, whose rows would otherwise be indistinguishable — the rule editor tabs follow.
 */
export function ambiguousNames(models: readonly Model[]): Set<string> {
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const { name } of models) (seen.has(name) ? repeated : seen).add(name);
    return repeated;
}

/** The icon of each operator jPipe knows. A test holds this in step with the language server's list. */
export const OPERATOR_ICONS: Readonly<Record<string, string>> = {
    // Grafts one model onto an element of another: the refinement goes down into the base.
    refine: 'arrow-circle-down',
    // Stacks several models under a new conclusion.
    assemble: 'layers'
};

/** For an operator the language server does not know — a typo, or one from a newer compiler. */
export const UNKNOWN_OPERATOR_ICON = 'question';

/**
 * The codicon a model is drawn with: its operator's, if it is a composition, otherwise its kind's.
 * A composed model looks the same in every group it appears in.
 */
export function modelIcon(model: Model): string {
    if (model.operator !== undefined) return OPERATOR_ICONS[model.operator] ?? UNKNOWN_OPERATOR_ICON;
    return model.kind === 'template' ? 'book' : 'bookmark';
}

/**
 * The model the cursor is in, given the models declared in that file.
 *
 * Models are top-level and never nest, so the one containing a line is the last whose name starts
 * on or before it. A cursor above the first model — among the `load`s — is in none.
 */
export function modelAtLine(modelsInFile: readonly Model[], line: number): Model | undefined {
    let best: Model | undefined;
    for (const model of modelsInFile) {
        const start = model.selection.start.line;
        if (start <= line && (!best || start >= best.selection.start.line)) best = model;
    }
    return best;
}

/**
 * Everything about a tree that would show on screen, as one string: two trees with the same
 * signature render identically, so replacing one with the other is not worth a refresh.
 */
export function treeSignature(tree: readonly GroupNode[]): string {
    const parts: string[] = [];
    const walk = (nodes: readonly TreeNode[]) => nodes.forEach(node => {
        parts.push(node.type === 'model' ? `${node.id}:${node.errors ?? ''}:${node.model.operator ?? ''}` : node.id);
        walk(node.children);
        parts.push(')');
    });
    walk(tree);
    return parts.join('|');
}

/**
 * Whether the selected row already stands for this model, wherever in the tree it is.
 *
 * A model can have several rows — under its template, among a composition's operands, in its own
 * group — and clicking any of them opens its file. The editor then reports the cursor in that
 * model, and revealing the model's usual row would move the selection away from the row just
 * clicked. A row for the same model is as good as any other, so it is left selected.
 */
export function showsModel(selected: TreeNode | undefined, key: string): boolean {
    return selected?.type === 'model' && selected.model.key === key;
}

/**
 * The node to reveal for a model: the place it always has. For a written justification that is
 * the flat Justifications list, for a template its place in the forest, for a composed
 * justification its own entry under Compositions, and for an excluded model the Excluded group.
 * Errors is never the answer, since a model is only there for as long as it is broken.
 *
 * Each group is searched breadth first, so a model's own row wins over the places it appears as
 * someone else's child — a composition's entry rather than its appearance among another's operands.
 */
export function nodeForModel(tree: readonly GroupNode[], key: string): ModelNode | undefined {
    for (const id of ['justifications', 'templates', 'compositions', 'excluded'] as const) {
        const queue: ModelNode[] = [...(tree.find(g => g.id === id)?.children ?? [])];
        for (let node = queue.shift(); node; node = queue.shift()) {
            if (node.model.key === key) return node;
            queue.push(...node.children);
        }
    }
    return undefined;
}
