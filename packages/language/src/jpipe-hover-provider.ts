import { AstNodeHoverProvider } from 'langium/lsp';
import { URI, type AstNode, type LangiumDocument, type MaybePromise } from 'langium';
import { CstUtils, GrammarUtils } from 'langium';
import type { LangiumServices } from 'langium/lsp';
import type { Hover, HoverParams } from 'vscode-languageserver';
import * as path from 'node:path';
import {
    isEvidence, isStrategy, isConclusion, isSubConclusion, isAbstractSupport,
    isJustification, isTemplate, isQualifiedId, isLoad, type Load
} from './generated/ast.js';
import type { JpipeServices } from './jpipe-module.js';
import type { JpipeImportService } from './jpipe-import.js';
import { GlobSyntaxError, isGlobPattern } from './jpipe-glob.js';
import { fsPathOf } from './jpipe-utils.js';

/** Beyond this, a hover becomes a wall of text rather than an answer. */
const MAX_LISTED_MATCHES = 50;

function elementKind(node: AstNode): string {
    if (isSubConclusion(node)) return 'sub-conclusion';
    if (isAbstractSupport(node)) return '@support';
    return node.$type.toLowerCase();
}

export class JpipeHoverProvider extends AstNodeHoverProvider {
    private readonly importService: JpipeImportService;

    constructor(services: JpipeServices) {
        super(services as unknown as LangiumServices);
        this.importService = services.references.JpipeImportService;
    }

    override async getHoverContent(document: LangiumDocument, params: HoverParams): Promise<Hover | undefined> {
        // Checked before delegating: a `load` path is a STRING token, which the name-based
        // lookups below will not resolve — and a cursor on `*` or `[` is not name-like at all.
        const loadHover = this.getLoadHover(document, params);
        if (loadHover) return loadHover;

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

    /**
     * Hover for a `load` path: which files a glob matched, or where a literal path landed.
     *
     * For a glob this is the only place the match set is surfaced — go-to-definition
     * deliberately declines to answer for a pattern (see `jpipe-definition-provider.ts`), so the
     * entries here are rendered as links to keep navigation available.
     */
    private getLoadHover(document: LangiumDocument, params: HoverParams): Hover | undefined {
        const rootCst = document.parseResult.value?.$cstNode;
        if (!rootCst) return undefined;
        const offset = document.textDocument.offsetAt(params.position);
        // findLeafNodeAtOffset, not findDeclarationNodeAtOffset: the latter backtracks over
        // name characters, which glob punctuation is not.
        const leaf = CstUtils.findLeafNodeAtOffset(rootCst, offset);
        let node: AstNode | undefined = leaf?.astNode;
        while (node && !isLoad(node)) node = node.$container;
        if (!node || !isLoad(node)) return undefined;

        const value = this.renderLoadHover(node as Load, document);
        return value ? { contents: { kind: 'markdown', value } } : undefined;
    }

    private renderLoadHover(load: Load, document: LangiumDocument): string | undefined {
        const baseDir = path.dirname(fsPathOf(document.uri));
        const relativeLabel = (target: string) => path.relative(baseDir, target).split(path.sep).join('/');
        const link = (target: string) => `[${relativeLabel(target)}](${URI.file(target).toString()})`;

        if (!isGlobPattern(load.path)) {
            const resolved = this.importService.resolveExistingImportPath(load.path, document);
            // The validator already reports an unresolved literal path; no need to repeat it here.
            return resolved ? `Resolves to ${link(resolved)}` : undefined;
        }

        let matches: string[];
        try {
            matches = this.importService.expandLoadPath(load.path, document);
        } catch (error) {
            const reason = error instanceof GlobSyntaxError ? error.description : String(error);
            return `Invalid glob pattern \`${load.path}\` — ${reason}`;
        }
        if (matches.length === 0) {
            return `No file matches \`${load.path}\``;
        }

        const shown = matches.slice(0, MAX_LISTED_MATCHES);
        const lines = [
            `**${matches.length} file${matches.length === 1 ? '' : 's'}** match \`${load.path}\``,
            '',
            ...shown.map(match => `- ${link(match)}`)
        ];
        if (matches.length > shown.length) {
            lines.push(`- …and ${matches.length - shown.length} more`);
        }
        return lines.join('\n');
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
