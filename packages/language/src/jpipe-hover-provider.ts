import { AstNodeHoverProvider } from 'langium/lsp';
import type { AstNode, LangiumDocument, MaybePromise } from 'langium';
import { CstUtils, GrammarUtils } from 'langium';
import type { LangiumServices } from 'langium/lsp';
import type { Hover, HoverParams } from 'vscode-languageserver';
import {
    isEvidence, isStrategy, isConclusion, isSubConclusion, isAbstractSupport,
    isJustification, isTemplate, isQualifiedId
} from './generated/ast.js';

function elementKind(node: AstNode): string {
    if (isSubConclusion(node)) return 'sub-conclusion';
    if (isAbstractSupport(node)) return '@support';
    return node.$type.toLowerCase();
}

export class JpipeHoverProvider extends AstNodeHoverProvider {
    constructor(services: LangiumServices) {
        super(services);
    }

    override async getHoverContent(document: LangiumDocument, params: HoverParams): Promise<Hover | undefined> {
        const result = await super.getHoverContent(document, params);
        if (result) return result;
        // AstNodeHoverProvider resolves cross-references and self-nodes via the name provider.
        // For jPipe element declarations (evidence/strategy/etc.), the id is a QualifiedId
        // sub-node that the base class cannot resolve to its containing element. Walk up manually.
        const rootCst = document.parseResult.value?.$cstNode;
        if (!rootCst) return undefined;
        const offset = document.textDocument.offsetAt(params.position);
        const cstNode = CstUtils.findDeclarationNodeAtOffset(rootCst, offset, this.grammarConfig.nameRegexp);
        if (!cstNode || cstNode.offset + cstNode.length <= offset) return undefined;
        if (isQualifiedId(cstNode.astNode)) {
            const content = await this.getAstNodeHoverContent(cstNode.astNode.$container as AstNode);
            if (typeof content === 'string') {
                return { contents: { kind: 'markdown', value: content } };
            }
        }
        const astNode = cstNode.astNode;
        if ((isJustification(astNode) || isTemplate(astNode)) && GrammarUtils.findAssignment(cstNode)?.feature === 'id') {
            const content = await this.getAstNodeHoverContent(astNode);
            if (typeof content === 'string') {
                return { contents: { kind: 'markdown', value: content } };
            }
        }
        return undefined;
    }

    protected getAstNodeHoverContent(node: AstNode): MaybePromise<string | undefined> {
        if (isEvidence(node) || isStrategy(node) || isConclusion(node)
                || isSubConclusion(node) || isAbstractSupport(node)) {
            const kind = elementKind(node);
            return `**${node.name}** *(${kind})*`;
        }
        if (isJustification(node) || isTemplate(node)) {
            const kind = isJustification(node) ? 'justification' : 'template';
            return `**${node.id}** *(${kind})*`;
        }
        return undefined;
    }
}
