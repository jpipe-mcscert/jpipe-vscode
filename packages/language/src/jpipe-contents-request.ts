/**
 * A model's elements as the client shows them: `ModelContents.contentsOf`, answered as rows the
 * editor can list and open (jpipe-vscode ADR-VSC-0034).
 *
 * The activity's Outline and the Run panel ask it. So the elements a composition builds are listed
 * under the ids the compiler gives them, and inherited ones as the compiler binds them, by the one
 * service every rule asks, never by a second reading of `implements` in the client. No standard
 * LSP request carries a model's elements: `textDocument/documentSymbol` places symbols in one file,
 * and a model's elements are declared in several.
 */
import { AstUtils, DocumentState, ReadPriority, URI, type LangiumDocument } from 'langium';
import type { CancellationToken } from 'vscode-languageserver-protocol';
import type { Position, Range } from 'vscode-languageserver-types';
import { isJustification, isTemplate, isUnit, type Justification, type Template } from './generated/ast.js';
import type { JpipeServices } from './jpipe-module.js';
import { listedIn } from './jpipe-model-contents.js';
import type { ElementKind, ModelElement } from './jpipe-utils.js';

/** Which model: by its file and name, and a position in its name for a file declaring two of that name. */
export interface ModelContentsParams {
    readonly uri: string;
    readonly name: string;
    readonly position?: Position;
}

/** One element, as a row. */
export interface ContentsRow {
    /** The id the compiler gives it in the model asked about. */
    readonly id: string;
    readonly kind: ElementKind;
    readonly label?: string;
    /** Where it is declared; absent for an element an operator made up, such as `assemble`'s conclusion. */
    readonly location?: { readonly uri: string; readonly range: Range; readonly selection: Range };
    /** The model declaring it, when that is not the model asked about: a template it inherits, or a model it is built from. */
    readonly declaredIn?: string;
    /** Merged by an operator from several elements: `location` is one of theirs. */
    readonly merged?: true;
}

export interface ModelContentsAnswer {
    /**
     * Whether `elements` is the whole list. When it is not, the server cannot tell (the compiler has
     * not built a composition the model builds on, as its files stand, or the model's `implements`
     * chain loops or does not resolve), and the list holds what the files declare: an element missing
     * from it may still be there.
     */
    readonly complete: boolean;
    /** The model's own elements in the order written, then the others in the compiler's order. */
    readonly elements: readonly ContentsRow[];
}

/**
 * The answer to the client's request for a model's contents, once the model's file is linked, as Langium's own requests
 * wait for theirs; `null` when the file or the model is not in the workspace.
 */
export async function answerModelContents(
    services: JpipeServices,
    params: ModelContentsParams,
    cancelToken?: CancellationToken
): Promise<ModelContentsAnswer | null> {
    const workspace = services.shared.workspace;
    const uri = URI.parse(params.uri);
    await workspace.WorkspaceManager.ready;
    if (!workspace.LangiumDocuments.hasDocument(uri)) return null;
    await workspace.DocumentBuilder.waitUntil(DocumentState.Linked, uri, cancelToken);
    return workspace.WorkspaceLock.read(async () => {
        const document = workspace.LangiumDocuments.getDocument(uri);
        return document ? modelContentsIn(services, document, params) : null;
    }, ReadPriority.Immediate);
}

/** The contents of the model `params` names in `document`, or `null` when it declares no such model. */
export async function modelContentsIn(
    services: JpipeServices,
    document: LangiumDocument,
    params: Pick<ModelContentsParams, 'name' | 'position'>
): Promise<ModelContentsAnswer | null> {
    const model = modelIn(document, params);
    if (!model) return null;
    const contents = await services.references.ModelContents.contentsOf(model, '', document);
    const rows = listedIn(contents).map(entry => rowOf(entry, model));
    return {
        complete: contents.kind === 'elements',
        elements: [...rows.filter(row => row.declaredIn === undefined && row.location), ...rows.filter(row => row.declaredIn !== undefined || !row.location)]
    };
}

/** The model of that name in `document`: the one whose declaration holds `position`, else the first. */
function modelIn(document: LangiumDocument, { name, position }: Pick<ModelContentsParams, 'name' | 'position'>): Justification | Template | undefined {
    const unit = document.parseResult?.value;
    if (!isUnit(unit)) return undefined;
    const named = unit.body.filter(model => model.id === name);
    const holding = position && named.find(model => {
        const range = model.$cstNode?.range;
        return range !== undefined && !before(position, range.start) && !before(range.end, position);
    });
    return holding ?? named[0];
}

const before = (a: Position, b: Position): boolean =>
    a.line < b.line || (a.line === b.line && a.character < b.character);

function rowOf(entry: ModelElement, model: Justification | Template): ContentsRow {
    const declaration = entry.element;
    const owner = declaration && AstUtils.getContainerOfType(declaration, (node): node is Justification | Template =>
        isJustification(node) || isTemplate(node));
    const range = declaration?.$cstNode?.range;
    return {
        id: entry.id,
        kind: entry.kind,
        ...(declaration?.name === undefined ? {} : { label: declaration.name }),
        ...(declaration && range ? {
            location: {
                uri: AstUtils.getDocument(declaration).uri.toString(),
                range,
                selection: declaration.id?.$cstNode?.range ?? range
            }
        } : {}),
        ...(owner && owner !== model ? { declaredIn: owner.id } : {}),
        ...(entry.merged ? { merged: true } : {})
    };
}
