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
import { getDocumentAndUnit } from './jpipe-ast-context.js';

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

/**
 * A symbol for something that has a name yet, or `undefined`.
 *
 * A declaration is nameless for as long as it takes to type a name — `justification ` and
 * `evidence ` are both states every model passes through. The LSP client rejects a symbol whose
 * name is empty with "name must not be falsy" and throws away the *whole* response, so one
 * half-typed line would empty the outline and raise a notification on every keystroke. Something
 * without a name is simply not a symbol yet.
 */
function namedSymbol(name: string | undefined, kind: SymbolKind, range: Range): DocumentSymbol | undefined {
    return name ? syntheticSymbol(name, kind, range) : undefined;
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
            const symbol = this.buildModelSymbol(body);
            if (symbol) defaultChildren.push(symbol);
        }

        for (const load of unnamedLoads) {
            const loadRange = load.$cstNode?.range ?? ZERO_RANGE;
            for (const importedUnit of this.resolveImportedUnits(load, document)) {
                defaultChildren.push(...this.buildImportedModelSymbols(importedUnit, loadRange));
            }
        }

        const symbols: DocumentSymbol[] = [];

        if (defaultChildren.length > 0) {
            const unitRange = unit.$cstNode?.range ?? ZERO_RANGE;
            symbols.push({
                ...syntheticSymbol('(default)', SymbolKind.Module, unitRange),
                children: defaultChildren,
            });
        }

        for (const load of namedLoads) {
            if (!load.$cstNode || !load.namespace) continue;
            symbols.push(this.buildNamespaceSymbol(load, load.namespace, load.$cstNode.range, document));
        }

        return symbols;
    }

    /** The units a `load` brings in — several when its path is a glob. */
    private resolveImportedUnits(load: Load, document: LangiumDocument): Unit[] {
        return this.importService.resolveImportedDocuments(load, document)
            .map(doc => doc.parseResult?.value as Unit | undefined)
            .filter((unit): unit is Unit => unit !== undefined);
    }

    private buildImportedModelSymbols(importedUnit: Unit, loadRange: Range): DocumentSymbol[] {
        const results: DocumentSymbol[] = [];
        for (const body of importedUnit.body) {
            if (!isJustification(body) && !isTemplate(body)) continue;
            const kind = isJustification(body) ? SymbolKind.Class : SymbolKind.Interface;
            const model = namedSymbol(body.id, kind, loadRange);
            if (!model) continue;
            const elementChildren = getLocalElements(body)
                .map(e => namedSymbol(qualifiedIdText(e.id), elementKind(e), loadRange))
                .filter((symbol): symbol is DocumentSymbol => symbol !== undefined);
            results.push({
                ...model,
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
        // A globbed load with an alias puts every matched file under the one namespace.
        const children = this.resolveImportedUnits(load, document)
            .flatMap(importedUnit => this.buildImportedModelSymbols(importedUnit, loadRange));

        return {
            ...syntheticSymbol(ns, SymbolKind.Module, loadRange),
            children: children.length > 0 ? children : undefined
        };
    }

    private buildModelSymbol(owner: Justification | Template): DocumentSymbol | undefined {
        if (!owner.id) return undefined;
        const kind = isJustification(owner) ? SymbolKind.Class : SymbolKind.Interface;
        const ownerRange = owner.$cstNode!.range;

        // Local elements.
        const local = getLocalElements(owner)
            .map(e => namedSymbol(qualifiedIdText(e.id), elementKind(e), e.$cstNode?.range ?? ownerRange))
            .filter((symbol): symbol is DocumentSymbol => symbol !== undefined);

        // Inherited elements from parent templates (transitively).
        // localKey = templateId:elementQualifiedId, omitting any namespace prefix.
        const { document: doc, unit } = getDocumentAndUnit(owner);
        const inherited = doc && unit
            ? this.importService.getInheritedElementsWithKeys(owner, unit, doc)
                .filter(({ localKey }) => localKey.length > 0)
                .map(({ element, localKey }) =>
                    syntheticSymbol(`(inherited) ${localKey}`, elementKind(element), ownerRange))
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

}
