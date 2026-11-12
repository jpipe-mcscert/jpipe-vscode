/**
 * What the Models view shows, worked out from what the language server says.
 *
 * Everything with a decision in it lives here, away from `vscode`, so it can be tested
 * (jpipe-vscode ADR-VSC-0004): which requests to make, how their answers become a tree, and which
 * model the cursor is in. `models-view.ts` only puts the result on screen.
 *
 * The server is asked two standard questions and nothing else. `workspace/symbol` lists every
 * model, already labelled template or justification. `typeHierarchy/subtypes`, asked of each
 * template, says what implements it. No custom protocol: the same two answers drive the editor's
 * Go to Symbol in Workspace and Show Type Hierarchy.
 */

/** The LSP `SymbolKind`s the server gives models (see `modelSymbolKind` in jpipe-language). */
export const SYMBOL_KIND_CLASS = 5;
export const SYMBOL_KIND_INTERFACE = 11;

export const WORKSPACE_SYMBOL_REQUEST = 'workspace/symbol';
export const TYPE_HIERARCHY_SUBTYPES_REQUEST = 'typeHierarchy/subtypes';

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
    uri: string;
    range: Range;
    selectionRange: Range;
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
    return [...models.values()];
}

/** A row in the tree. */
export type TreeNode = GroupNode | ModelNode;

export interface GroupNode {
    type: 'group';
    /** Stable, so VS Code keeps the group's expanded state across refreshes. */
    id: 'templates' | 'justifications';
    label: string;
    children: ModelNode[];
}

export interface ModelNode {
    type: 'model';
    /** Unique within the tree: a justification can appear both under its template and in the flat list. */
    id: string;
    model: Model;
    /** The name of the template this model implements, for display. */
    parentName?: string;
    children: ModelNode[];
    parent: TreeNode;
}

const byName = (a: Model, b: Model): number =>
    a.name.localeCompare(b.name) || a.uri.localeCompare(b.uri);

/** Templates before justifications, then by name. */
const templatesFirst = (a: Model, b: Model): number =>
    (a.kind === b.kind ? 0 : a.kind === 'template' ? -1 : 1) || byName(a, b);

/**
 * The two groups the view shows.
 *
 * **Templates** is the `implements` forest: a template whose parent is not in the workspace is a
 * root, and each template lists what implements it — templates first, then justifications.
 * **Justifications** is every justification, flat, which is the list most people come for. A
 * justification implementing a template therefore appears twice, which is what lets each group
 * answer its own question without the other.
 *
 * A cycle of templates is a modelling error the validator reports, but the tree must still be
 * finite: a template already on the current path is not descended into again. Templates that are
 * only reachable through such a cycle have no root, so they are listed as roots themselves rather
 * than vanishing from the view.
 *
 * Empty groups are left out, so a workspace with no templates shows only its justifications.
 */
export function buildTree(models: readonly Model[]): GroupNode[] {
    const byKey = new Map(models.map(m => [m.key, m]));
    const children = new Map<string, Model[]>();
    for (const model of models) {
        if (!model.parentKey || !byKey.has(model.parentKey)) continue;
        const siblings = children.get(model.parentKey) ?? [];
        siblings.push(model);
        children.set(model.parentKey, siblings);
    }
    const parentName = (m: Model) => m.parentKey ? byKey.get(m.parentKey)?.name : undefined;

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

    const allTemplates = models.filter(m => m.kind === 'template').sort(byName);
    for (const template of allTemplates) {
        if (template.parentKey && byKey.has(template.parentKey)) continue;
        templates.children.push(grow(template, templates, ['templates']));
    }
    for (const template of allTemplates) {
        if (!placed.has(template.key)) templates.children.push(grow(template, templates, ['templates']));
    }

    const justifications: GroupNode = { type: 'group', id: 'justifications', label: 'Justifications', children: [] };
    justifications.children = models
        .filter(m => m.kind === 'justification')
        .sort(byName)
        .map(model => ({
            type: 'model' as const,
            id: `justifications>${model.key}`,
            model,
            parentName: parentName(model),
            children: [],
            parent: justifications
        }));

    return [templates, justifications].filter(group => group.children.length > 0);
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
 * The node to reveal for a model: its place in the flat Justifications list for a justification,
 * since that is where it always is; for a template, its one place in the forest.
 */
export function nodeForModel(tree: readonly GroupNode[], key: string): ModelNode | undefined {
    const visit = (nodes: readonly ModelNode[]): ModelNode | undefined => {
        for (const node of nodes) {
            if (node.model.key === key) return node;
            const found = visit(node.children);
            if (found) return found;
        }
        return undefined;
    };
    const justifications = tree.find(g => g.id === 'justifications');
    const templates = tree.find(g => g.id === 'templates');
    return visit(justifications?.children ?? []) ?? visit(templates?.children ?? []);
}
