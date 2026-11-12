import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import { cursorAt, type Model } from './models-tree.js';
import type { ModelsView } from './models-view.js';
import type { LibrariesView } from '../runner/libraries-view.js';
import { bindSteps, stepNote, type LibraryStep } from '../runner/step-binding.js';
import {
    DOCUMENT_SYMBOL_REQUEST,
    ELEMENT_COLORS,
    ELEMENT_ICONS,
    elementAt,
    elementLabel,
    elementsOf,
    emptyMessage,
    type Element,
    type WireDocumentSymbol
} from './elements-tree.js';

export const ELEMENTS_VIEW_ID = 'jpipe.elements';

/** As in the Models view: long enough to let a name be typed, short enough to look live. */
const REFRESH_DELAY_MS = 500;

/**
 * The jPipe activity's Outline: the elements of the model selected in Models.
 *
 * It follows Models rather than the editor, so a model can be looked into without opening its
 * file — and since Models follows the editor, it follows the editor too. Within the model, it
 * selects the element the cursor is in, as the Explorer's Outline does.
 *
 * Its rows are the model's own elements only, flat and in the order written; `elements-tree.ts`
 * decides which they are and how they read.
 */
export class ElementsView implements vscode.TreeDataProvider<Element>, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<undefined>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    private readonly view: vscode.TreeView<Element>;
    private readonly disposables: vscode.Disposable[] = [];
    private model: Model | undefined;
    private elements: Element[] | undefined;
    private loading: Promise<void> | undefined;
    private stale = true;
    private timer: ReturnType<typeof setTimeout> | undefined;
    /** The id of the row last selected; see `ModelsView.selectedKey` for why it is kept here. */
    private selectedId: string | undefined;
    /** The steps of the checked libraries implementing each element, by element id. */
    private bindings = new Map<string, LibraryStep[]>();

    constructor(
        private readonly client: LanguageClient,
        models: ModelsView,
        private readonly libraries: LibrariesView,
        private readonly logger: JpipeLogger
    ) {
        this.view = vscode.window.createTreeView(ELEMENTS_VIEW_ID, { treeDataProvider: this });
        this.model = models.currentModel;

        this.disposables.push(
            this.view,
            this.changeEmitter,
            // Checking a library changes which elements have a step; the elements themselves do not.
            libraries.onDidChange(() => {
                this.bind();
                this.changeEmitter.fire(undefined);
            }),
            models.onDidChangeCurrentModel(model => {
                this.model = model;
                this.selectedId = undefined;
                this.refresh();
            }),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (this.isModelFile(e.document.uri) && e.contentChanges.length > 0) this.scheduleRefresh();
            }),
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (this.isModelFile(doc.uri)) this.scheduleRefresh();
            }),
            this.view.onDidChangeSelection(e => {
                if (e.selection[0]) this.selectedId = e.selection[0].id;
            }),
            this.view.onDidChangeVisibility(e => {
                if (e.visible && this.stale) this.refresh();
            }),
            vscode.window.onDidChangeTextEditorSelection(e => {
                if (e.textEditor === vscode.window.activeTextEditor) void this.revealElementAtCursor();
            })
        );
    }

    private isModelFile(uri: vscode.Uri): boolean {
        return this.model !== undefined && vscode.Uri.parse(this.model.uri).toString() === uri.toString();
    }

    refresh(): void {
        this.stale = true;
        if (!this.view.visible) return;
        this.startLoad();
        this.changeEmitter.fire(undefined);
    }

    private startLoad(): void {
        this.stale = false;
        this.loading = this.load();
    }

    private scheduleRefresh(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.refresh();
        }, REFRESH_DELAY_MS);
    }

    private async load(): Promise<void> {
        const model = this.model;
        this.view.description = model?.name;
        if (!model || model.operator) {
            this.elements = [];
        } else {
            try {
                await this.client.start();
                const symbols = await this.client.sendRequest<WireDocumentSymbol[] | null>(
                    DOCUMENT_SYMBOL_REQUEST, { textDocument: { uri: model.uri } });
                // The selection may have moved on while the server was answering.
                if (model !== this.model) return;
                this.elements = elementsOf(symbols ?? [], model);
            } catch (err: unknown) {
                this.logger.error(`Could not list the elements of ${model.name}: ${messageOf(err)}`);
                this.elements = undefined;
            }
        }
        this.view.message = emptyMessage(model, this.elements);
        this.bind();
    }

    private bind(): void {
        this.bindings = this.model && this.elements
            ? bindSteps(this.model.name, this.elements.map(e => e.id), this.libraries.checkedSteps())
            : new Map();
    }

    async getChildren(element?: Element): Promise<Element[]> {
        if (element) return [];
        if (this.stale) this.startLoad();
        await this.loading;
        setTimeout(() => void this.revealElementAtCursor(), 0);
        return this.elements ?? [];
    }

    getParent(): undefined {
        return undefined;
    }

    getTreeItem(element: Element): vscode.TreeItem {
        const item = new vscode.TreeItem(elementLabel(element), vscode.TreeItemCollapsibleState.None);
        item.id = element.id;
        item.iconPath = new vscode.ThemeIcon(ELEMENT_ICONS[element.kind], new vscode.ThemeColor(ELEMENT_COLORS[element.kind]));
        const steps = this.bindings.get(element.id);
        // Step functions in grey: what the runner will call for this element, once libraries are checked.
        item.description = stepNote(element.kind, steps, this.libraries.checkedLibraries().length > 0);
        item.tooltip = `${element.kind === 'support' ? '@support' : element.kind} ${element.id}` +
            (element.label ? `\n${element.label}` : '') +
            (steps ?? []).map(step =>
                `\nImplemented by ${step.functionName ?? 'a step'} in ${vscode.workspace.asRelativePath(vscode.Uri.parse(step.libraryUri))}`).join('');
        if (this.model) {
            const { start, end } = cursorAt(element.selection);
            item.command = {
                command: 'vscode.open',
                title: 'Open',
                arguments: [
                    vscode.Uri.parse(this.model.uri),
                    { selection: new vscode.Range(start.line, start.character, end.line, end.character) }
                ]
            };
        }
        return item;
    }

    /** Select the element the cursor is in, when the cursor is in the model being shown. */
    private async revealElementAtCursor(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!this.view.visible || !editor || !this.isModelFile(editor.document.uri) || !this.elements) return;
        const { line, character } = editor.selection.active;
        const element = elementAt(this.elements, { line, character });
        if (!element || element.id === this.selectedId) return;
        try {
            await this.view.reveal(element, { select: true, focus: false });
        } catch {
            // The list was replaced mid-reveal; the next cursor move retries.
        }
    }

    dispose(): void {
        if (this.timer) clearTimeout(this.timer);
        for (const d of this.disposables) d.dispose();
    }
}
