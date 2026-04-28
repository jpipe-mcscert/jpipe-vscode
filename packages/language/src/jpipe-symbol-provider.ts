import type { DocumentSymbol, DocumentSymbolParams } from 'vscode-languageserver-protocol';
import { SymbolKind, type Range } from 'vscode-languageserver-types';
import type { LangiumDocument, MaybePromise } from 'langium';
import { DefaultDocumentSymbolProvider } from 'langium/lsp';
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
    type Justification,
    type JustificationElement,
    type Load,
    type Template,
    type Unit,
} from './generated/ast.js';
import { getLocalElements, qualifiedIdText } from './jpipe-utils.js';

const ZERO_RANGE: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

function elementKind(e: JustificationElement): SymbolKind {
    if (isConclusion(e))      return SymbolKind.Constructor;
    if (isStrategy(e))        return SymbolKind.Method;
    if (isEvidence(e))        return SymbolKind.Field;
    if (isSubConclusion(e))   return SymbolKind.Variable;
    if (isAbstractSupport(e)) return SymbolKind.TypeParameter;
    return SymbolKind.Field;
}

function syntheticSymbol(name: string, kind: SymbolKind, range: Range): DocumentSymbol {
    return { name, kind, range, selectionRange: range };
}

export class JpipeDocumentSymbolProvider extends DefaultDocumentSymbolProvider {
    private readonly importService: JpipeImportService;

    constructor(services: JpipeServices) {
        super(services);
        this.importService = services.references.JpipeImportService;
    }

    override getSymbols(
        document: LangiumDocument,
        _params: DocumentSymbolParams
    ): MaybePromise<DocumentSymbol[]> {
        const unit = document.parseResult?.value as Unit | undefined;
        if (!unit) return [];

        const unnamedLoads = unit.imports.filter(l => !l.namespace);
        const namedLoads   = unit.imports.filter(l => !!l.namespace);

        // Default namespace: local models first, then models from unnamed loads.
        const defaultChildren: DocumentSymbol[] = [];

        for (const body of unit.body) {
            if (!isJustification(body) && !isTemplate(body)) continue;
            if (!body.$cstNode) continue;
            defaultChildren.push(this.buildModelSymbol(body));
        }

        for (const load of unnamedLoads) {
            defaultChildren.push(...this.buildUnnamedLoadModels(load, document));
        }

        const symbols: DocumentSymbol[] = [];

        if (defaultChildren.length > 0) {
            symbols.push({
                ...syntheticSymbol('(default)', SymbolKind.Module, ZERO_RANGE),
                children: defaultChildren,
            });
        }

        for (const load of namedLoads) {
            if (!load.$cstNode || !load.namespace) continue;
            symbols.push(this.buildNamespaceSymbol(load, load.namespace, load.$cstNode.range, document));
        }

        return symbols;
    }

    private buildUnnamedLoadModels(load: Load, document: LangiumDocument): DocumentSymbol[] {
        const importedDoc = this.importService.parseDocumentFromPath(load.path, document);
        const importedUnit = importedDoc?.parseResult?.value as Unit | undefined;
        if (!importedUnit) return [];

        const loadRange = load.$cstNode?.range ?? ZERO_RANGE;
        const results: DocumentSymbol[] = [];

        for (const body of importedUnit.body) {
            if (!isJustification(body) && !isTemplate(body)) continue;
            const kind = isJustification(body) ? SymbolKind.Class : SymbolKind.Interface;
            const elementChildren = getLocalElements(body).map(e =>
                syntheticSymbol(qualifiedIdText(e.id), elementKind(e), loadRange)
            );
            results.push({
                ...syntheticSymbol(body.id, kind, loadRange),
                children: elementChildren.length > 0 ? elementChildren : undefined,
            });
        }
        return results;
    }

    private buildNamespaceSymbol(
        load: Load,
        ns: string,
        loadRange: Range,
        document: LangiumDocument
    ): DocumentSymbol {
        const importedDoc = this.importService.parseDocumentFromPath(load.path, document);
        const importedUnit = importedDoc?.parseResult?.value as Unit | undefined;
        const children: DocumentSymbol[] = [];

        if (importedUnit) {
            for (const body of importedUnit.body) {
                if (!isJustification(body) && !isTemplate(body)) continue;
                const kind = isJustification(body) ? SymbolKind.Class : SymbolKind.Interface;
                const elementChildren = getLocalElements(body).map(e =>
                    syntheticSymbol(qualifiedIdText(e.id), elementKind(e), loadRange)
                );
                children.push({
                    ...syntheticSymbol(body.id, kind, loadRange),
                    children: elementChildren.length > 0 ? elementChildren : undefined
                });
            }
        }

        return {
            ...syntheticSymbol(ns, SymbolKind.Module, loadRange),
            children: children.length > 0 ? children : undefined
        };
    }

    private buildModelSymbol(owner: Justification | Template): DocumentSymbol {
        const kind = isJustification(owner) ? SymbolKind.Class : SymbolKind.Interface;
        const ownerRange = owner.$cstNode!.range;

        // Local elements.
        const local = getLocalElements(owner).map(e => {
            const range = e.$cstNode?.range ?? ownerRange;
            return syntheticSymbol(qualifiedIdText(e.id), elementKind(e), range);
        });

        // Inherited elements from parent templates (transitively).
        const { document: doc, unit } = this.getDocumentAndUnit(owner);
        const inherited = doc && unit
            ? this.importService.getInheritedElementsWithKeys(owner, unit, doc).map(({ element }) =>
                syntheticSymbol(`(inherited) ${qualifiedIdText(element.id)}`, elementKind(element), ownerRange)
            )
            : [];

        const children = [...local, ...inherited];

        return {
            name: owner.id,
            kind,
            range: ownerRange,
            selectionRange: ownerRange,
            children: children.length > 0 ? children : undefined
        };
    }

    private getDocumentAndUnit(node: Justification | Template): {
        document: LangiumDocument | undefined;
        unit: Unit | undefined;
    } {
        let document = (node as unknown as Record<string, unknown>).$document as LangiumDocument | undefined;
        if (!document) {
            let current: unknown = node;
            while (current && !document) {
                document = (current as Record<string, unknown>).$document as LangiumDocument | undefined;
                current = (current as Record<string, unknown>).$container;
            }
        }
        const unit = document?.parseResult?.value as Unit | undefined;
        return { document, unit };
    }
}
