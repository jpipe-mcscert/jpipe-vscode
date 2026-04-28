import { AstNodeHoverProvider } from 'langium/lsp';
import type { AstNode, MaybePromise } from 'langium';
import type { LangiumServices } from 'langium/lsp';
import {
    isEvidence, isStrategy, isConclusion, isSubConclusion, isAbstractSupport,
    isJustification, isTemplate
} from './generated/ast.js';

export class JpipeHoverProvider extends AstNodeHoverProvider {
    constructor(services: LangiumServices) {
        super(services);
    }

    protected getAstNodeHoverContent(node: AstNode): MaybePromise<string | undefined> {
        if (isEvidence(node) || isStrategy(node) || isConclusion(node)
                || isSubConclusion(node) || isAbstractSupport(node)) {
            const kind = isSubConclusion(node) ? 'sub-conclusion' : node.$type.toLowerCase();
            return `**${node.name}** *(${kind})*`;
        }
        if (isJustification(node) || isTemplate(node)) {
            const kind = isJustification(node) ? 'justification' : 'template';
            return `**${node.id}** *(${kind})*`;
        }
        return undefined;
    }
}
