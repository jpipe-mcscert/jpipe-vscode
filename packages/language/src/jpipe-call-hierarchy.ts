/**
 * Compositions, over the standard LSP call hierarchy.
 *
 * `justification Release is assemble(Build, Tests)` applies an operator to two models, which is a
 * call in all but name, so the protocol's call hierarchy says what it needs to: the *outgoing*
 * calls of a composed model are its operands, and the *incoming* calls of a model are the
 * compositions using it. The editor's *Show Call Hierarchy* gets both for free, and the Models
 * view builds its Compositions group from them.
 *
 * Only models take part, as with the type hierarchy. A composed model's item carries its operator
 * as `detail` (see `modelItem`), which is how a caller tells a composition from a written model.
 *
 * Operands are listed once each, in the order they are first written: `refine(A, A)` calls `A`
 * twice, which the protocol expresses as one call with two `fromRanges`, not two calls.
 */
import type { CallHierarchyIncomingCall, CallHierarchyItem, CallHierarchyOutgoingCall, Range } from 'vscode-languageserver';
import type { AstNode, AstNodeLocator, LangiumDocuments, NameProvider, ReferenceDescription, Stream } from 'langium';
import { AbstractCallHierarchyProvider } from 'langium/lsp';
import type { LangiumServices } from 'langium/lsp';
import { isJustification, isParamsDecl, isTemplate } from './generated/ast.js';
import { modelItem, type ModelItem } from './jpipe-type-hierarchy.js';

/** Calls grouped by the model at the far end, in first-seen order. */
class CallGroups {
    private readonly groups = new Map<string, { item: ModelItem; fromRanges: Range[] }>();

    add(item: ModelItem, from: Range): void {
        const key = `${item.uri}#${item.name}`;
        const group = this.groups.get(key) ?? { item, fromRanges: [] };
        group.fromRanges.push(from);
        this.groups.set(key, group);
    }

    values() {
        return [...this.groups.values()];
    }
}

export class JpipeCallHierarchyProvider extends AbstractCallHierarchyProvider {
    private readonly names: NameProvider;
    private readonly locator: AstNodeLocator;
    private readonly langiumDocuments: LangiumDocuments;

    constructor(services: LangiumServices) {
        super(services);
        this.names = services.references.NameProvider;
        this.locator = services.workspace.AstNodeLocator;
        this.langiumDocuments = services.shared.workspace.LangiumDocuments;
    }

    /** The document argument is ignored: see `modelItem`. */
    protected override getCallHierarchyItems(targetNode: AstNode): CallHierarchyItem[] | undefined {
        const item = modelItem(targetNode, this.names);
        return item ? [item] : undefined;
    }

    /** The models a composition is made of. None for a model written out by hand. */
    protected override getOutgoingCalls(node: AstNode): CallHierarchyOutgoingCall[] | undefined {
        if (!isJustification(node) && !isTemplate(node)) return undefined;
        const calls = new CallGroups();
        for (const ref of node.composition?.params?.refs ?? []) {
            const operand = ref.ref;
            const item = operand ? modelItem(operand, this.names) : undefined;
            if (item && ref.$refNode) calls.add(item, ref.$refNode.range);
        }
        const result = calls.values().map(({ item, fromRanges }) => ({ to: item, fromRanges }));
        return result.length > 0 ? result : undefined;
    }

    /**
     * The compositions using this model as an operand.
     *
     * A model is also referenced by `implements`, and that is not a call; only references held by
     * a composition's parameter list count, which the reference's container says.
     */
    protected override getIncomingCalls(
        _node: AstNode,
        references: Stream<ReferenceDescription>
    ): CallHierarchyIncomingCall[] | undefined {
        const calls = new CallGroups();
        for (const ref of references) {
            const document = this.langiumDocuments.getDocument(ref.sourceUri);
            if (!document) continue;
            const params = this.locator.getAstNode(document.parseResult.value, ref.sourcePath);
            if (!isParamsDecl(params)) continue;
            const item = modelItem(params.$container.$container, this.names);
            if (item) calls.add(item, ref.segment.range);
        }
        const result = calls.values().map(({ item, fromRanges }) => ({ from: item, fromRanges }));
        return result.length > 0 ? result : undefined;
    }
}
