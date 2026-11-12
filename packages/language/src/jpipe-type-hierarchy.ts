/**
 * The `implements` relation, over the standard LSP type hierarchy and workspace symbols.
 *
 * A template is to the models implementing it what an interface is to its classes, so jPipe
 * speaks the protocol's vocabulary for that rather than inventing its own. Two consumers get it
 * for free: the editor's *Show Type Hierarchy*, and the extension's Models view, which builds its
 * tree out of `workspace/symbol` and `typeHierarchy/subtypes` alone.
 *
 * Only models take part. Elements are not types, and an `evidence` offered as the root of a type
 * hierarchy would be a hierarchy of one with nothing to say.
 */
import type { TypeHierarchyItem } from 'vscode-languageserver';
import { SymbolKind } from 'vscode-languageserver';
import type {
    AstNode,
    AstNodeDescription,
    AstNodeLocator,
    LangiumDocuments,
    NameProvider,
    References
} from 'langium';
import { AbstractTypeHierarchyProvider, DefaultNodeKindProvider } from 'langium/lsp';
import type { LangiumServices } from 'langium/lsp';
import { isJustification, isTemplate, Justification, Template } from './generated/ast.js';
import { getDocumentAndUnit } from './jpipe-ast-context.js';

/**
 * The symbol kind of a model: `Interface` for a template, `Class` for a justification.
 *
 * The same pair the outline uses, so a model carries one icon wherever it appears. `undefined`
 * for anything that is not a model.
 */
export function modelSymbolKind(type: string): SymbolKind | undefined {
    if (type === Template.$type) return SymbolKind.Interface;
    if (type === Justification.$type) return SymbolKind.Class;
    return undefined;
}

/**
 * Gives models their kind in `workspace/symbol` (Go to Symbol in Workspace).
 *
 * Langium's default answers `Field` for every node, which leaves a template and a justification
 * indistinguishable — and that difference is exactly what the Models view sorts on.
 */
export class JpipeNodeKindProvider extends DefaultNodeKindProvider {
    override getSymbolKind(node: AstNode | AstNodeDescription): SymbolKind {
        const type = '$type' in node ? node.$type : node.type;
        return modelSymbolKind(type) ?? super.getSymbolKind(node);
    }
}

export class JpipeTypeHierarchyProvider extends AbstractTypeHierarchyProvider {
    private readonly locator: AstNodeLocator;
    private readonly langiumDocuments: LangiumDocuments;
    private readonly names: NameProvider;
    private readonly refs: References;

    constructor(services: LangiumServices) {
        super(services);
        this.locator = services.workspace.AstNodeLocator;
        this.langiumDocuments = services.shared.workspace.LangiumDocuments;
        this.names = services.references.NameProvider;
        this.refs = services.references.References;
    }

    /**
     * Langium's version labels the item with the *requesting* document's URI, which is wrong as
     * soon as the declaration lives elsewhere — preparing on `implements T` with `T` loaded from
     * another file would hand back an item pointing at the right range of the wrong file. The
     * document argument is ignored, and each item placed in the document that owns its node.
     */
    protected override getTypeHierarchyItems(targetNode: AstNode): TypeHierarchyItem[] | undefined {
        const item = this.itemFor(targetNode);
        return item ? [item] : undefined;
    }

    /** The template a model implements — at most one, since `implements` names a single parent. */
    protected override getSupertypes(node: AstNode): TypeHierarchyItem[] | undefined {
        if (!isJustification(node) && !isTemplate(node)) return undefined;
        const parent = node.parent?.ref;
        const item = parent ? this.itemFor(parent) : undefined;
        return item ? [item] : undefined;
    }

    /**
     * Every model whose `implements` names this template, across the workspace.
     *
     * Read from the reference index rather than by walking documents: it already knows who
     * points at what, and it is current as of the last build. A reference whose container is a
     * model can only be its `parent` — the operands of a composition sit in their own
     * `ParamsDecl` node — so the container's type is enough to tell the two apart.
     */
    protected override getSubtypes(node: AstNode): TypeHierarchyItem[] | undefined {
        if (!isTemplate(node)) return undefined;
        const items: TypeHierarchyItem[] = [];
        for (const ref of this.refs.findReferences(node, { includeDeclaration: false })) {
            const document = this.langiumDocuments.getDocument(ref.sourceUri);
            if (!document) continue;
            const source = this.locator.getAstNode(document.parseResult.value, ref.sourcePath);
            if (!isJustification(source) && !isTemplate(source)) continue;
            const item = this.itemFor(source);
            if (item) items.push(item);
        }
        return items.length > 0 ? items : undefined;
    }

    private itemFor(node: AstNode): TypeHierarchyItem | undefined {
        const kind = modelSymbolKind(node.$type);
        if (kind === undefined) return undefined;
        const name = this.names.getName(node);
        const nameNode = this.names.getNameNode(node);
        const { document } = getDocumentAndUnit(node);
        if (!name || !nameNode || !node.$cstNode || !document) return undefined;
        return {
            name,
            kind,
            uri: document.uri.toString(),
            range: node.$cstNode.range,
            selectionRange: nameNode.range
        };
    }
}
