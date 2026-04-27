import { AstUtils, type AstNode, type LangiumDocument } from 'langium';
import { DefaultDefinitionProvider } from 'langium/lsp';
import { LocationLink, type DefinitionParams } from 'vscode-languageserver';
import type { CstNode } from 'langium';
import type { MaybePromise } from 'langium';
import type { JpipeServices } from './jpipe-module.js';
import type { JpipeImportService } from './jpipe-import.js';
import {
    isAbstractSupport,
    isConclusion,
    isEvidence,
    isJustification,
    isStrategy,
    isSubConclusion,
    isTemplate,
    type JustificationElement,
    type QualifiedId,
    type Template,
    type Unit,
} from './generated/ast.js';
import { getAllElements, localName } from './jpipe-utils.js';

function asJustificationElement(node: AstNode): JustificationElement | undefined {
    if (isEvidence(node) || isStrategy(node) || isConclusion(node) ||
        isSubConclusion(node) || isAbstractSupport(node)) return node;
    return undefined;
}

export class JpipeDefinitionProvider extends DefaultDefinitionProvider {
    private readonly importService: JpipeImportService;

    constructor(services: JpipeServices) {
        super(services);
        this.importService = services.references.JpipeImportService;
    }

    protected override collectLocationLinks(
        sourceCstNode: CstNode,
        params: DefinitionParams
    ): MaybePromise<LocationLink[] | undefined> {
        // Standard cross-reference navigation (relations, implements, etc.)
        const links = this.findLinks(sourceCstNode);
        if (links.length > 0) {
            return links.map(link => LocationLink.create(
                link.targetDocument.textDocument.uri,
                (link.target.astNode.$cstNode ?? link.target).range,
                link.target.range,
                link.source.range
            ));
        }

        // Fallback: if cursor is on a multi-part element id declaration (e.g. t:abs),
        // navigate to the @support or element in the parent template being overridden.
        return this.overrideTargetLink(sourceCstNode);
    }

    private overrideTargetLink(sourceCstNode: CstNode): LocationLink[] | undefined {
        // Walk up from the CST node to find the containing JustificationElement.
        let node: AstNode | undefined = sourceCstNode.astNode;
        let element: JustificationElement | undefined;
        while (node) {
            element = asJustificationElement(node);
            if (element) break;
            node = node.$container;
        }
        if (!element || !element.$cstNode) return undefined;

        const id = element.id as QualifiedId;
        if (!id?.parts || id.parts.length < 2) return undefined; // plain name, no template prefix

        const owner = AstUtils.getContainerOfType(element, isJustification)
                   ?? AstUtils.getContainerOfType(element, isTemplate);
        if (!owner) return undefined;

        const ownerDoc = this.getDocument(owner);
        const unit = ownerDoc?.parseResult?.value as Unit | undefined;
        if (!ownerDoc || !unit) return undefined;

        const elementName = id.parts.at(-1)!;
        const templatePath = id.parts.slice(0, -1);
        const template = this.resolveTemplate(templatePath, unit, ownerDoc);
        if (!template) return undefined;

        const targetElement = getAllElements(template).find(e => localName(e.id) === elementName);
        if (!targetElement || !targetElement.$cstNode) return undefined;

        const targetDoc = this.getDocument(targetElement);
        if (!targetDoc) return undefined;

        const nameNode = this.nameProvider.getNameNode(targetElement) ?? targetElement.$cstNode;
        return [LocationLink.create(
            targetDoc.textDocument.uri,
            targetElement.$cstNode.range,
            nameNode.range,
            element.$cstNode.range
        )];
    }

    private resolveTemplate(path: string[], unit: Unit, document: LangiumDocument): Template | undefined {
        if (path.length === 0) return undefined;

        if (path.length === 1) {
            // Local (same-unit) template or unnameSpaced import.
            const [templateId] = path;
            const local = unit.body.find((b): b is Template => isTemplate(b) && b.id === templateId);
            if (local) return local;
            // Try unnameSpaced imports.
            for (const load of unit.imports) {
                if (load.namespace) continue;
                const doc = this.importService.parseDocumentFromPath(load.path, document);
                const importedUnit = doc?.parseResult?.value as Unit | undefined;
                if (!importedUnit) continue;
                const found = importedUnit.body.find((b): b is Template => isTemplate(b) && b.id === templateId);
                if (found) return found;
            }
            return undefined;
        }

        // Namespaced: path = [namespace, templateId].
        const namespace = path[0];
        const templateId = path.slice(1).join(':');
        for (const load of unit.imports) {
            if (load.namespace !== namespace) continue;
            const doc = this.importService.parseDocumentFromPath(load.path, document);
            const importedUnit = doc?.parseResult?.value as Unit | undefined;
            if (!importedUnit) continue;
            const found = importedUnit.body.find((b): b is Template => isTemplate(b) && b.id === templateId);
            if (found) return found;
        }
        return undefined;
    }

    private getDocument(node: AstNode): LangiumDocument | undefined {
        let doc = (node as unknown as Record<string, unknown>).$document as LangiumDocument | undefined;
        if (!doc) {
            let cur: unknown = node;
            while (cur && !doc) {
                doc = (cur as Record<string, unknown>).$document as LangiumDocument | undefined;
                cur = (cur as Record<string, unknown>).$container;
            }
        }
        return doc;
    }
}
