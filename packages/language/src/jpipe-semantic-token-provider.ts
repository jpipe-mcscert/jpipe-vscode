import { AbstractSemanticTokenProvider, type SemanticTokenAcceptor } from 'langium/lsp';
import type { AstNode } from 'langium';
import type { LangiumServices } from 'langium/lsp';
import {
    isLoad, isJustification, isTemplate, isRelation,
    isAbstractSupport, isEvidence, isConclusion, isStrategy, isSubConclusion
} from './generated/ast.js';

export const TOKEN_LOAD      = 'jpipe-load';
export const TOKEN_STRUCTURE = 'jpipe-structure';
export const TOKEN_RELATION  = 'jpipe-relation';
export const TOKEN_ABSTRACT  = 'jpipe-abstract';
export const TOKEN_ELEMENT   = 'jpipe-element';

const CUSTOM_TOKENS = [TOKEN_LOAD, TOKEN_STRUCTURE, TOKEN_RELATION, TOKEN_ABSTRACT, TOKEN_ELEMENT] as const;

export class JpipeSemanticTokenProvider extends AbstractSemanticTokenProvider {
    constructor(services: LangiumServices) {
        super(services);
    }

    override get tokenTypes(): Record<string, number> {
        const standard = super.tokenTypes;
        const base = Object.keys(standard).length;
        const custom: Record<string, number> = {};
        CUSTOM_TOKENS.forEach((t, i) => { custom[t] = base + i; });
        return { ...standard, ...custom };
    }

    protected highlightElement(node: AstNode, acceptor: SemanticTokenAcceptor): void {
        if (isLoad(node)) {
            acceptor({ node, keyword: 'load', type: TOKEN_LOAD });
        } else if (isJustification(node)) {
            acceptor({ node, keyword: 'justification', type: TOKEN_STRUCTURE });
            acceptor({ node, keyword: 'implements', type: TOKEN_STRUCTURE });
        } else if (isTemplate(node)) {
            acceptor({ node, keyword: 'template', type: TOKEN_STRUCTURE });
            acceptor({ node, keyword: 'implements', type: TOKEN_STRUCTURE });
        } else if (isRelation(node)) {
            acceptor({ node, keyword: 'supports', type: TOKEN_RELATION });
        } else if (isAbstractSupport(node)) {
            acceptor({ node, keyword: '@support', type: TOKEN_ABSTRACT });
        } else if (isEvidence(node)) {
            acceptor({ node, keyword: 'evidence', type: TOKEN_ELEMENT });
        } else if (isConclusion(node)) {
            acceptor({ node, keyword: 'conclusion', type: TOKEN_ELEMENT });
        } else if (isStrategy(node)) {
            acceptor({ node, keyword: 'strategy', type: TOKEN_ELEMENT });
        } else if (isSubConclusion(node)) {
            acceptor({ node, keyword: 'sub-conclusion', type: TOKEN_ELEMENT });
        }
    }
}
