import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import { cursorAt, type Model } from './models-tree.js';
import { editorRange, sameFile, type ModelsView } from './models-view.js';
import type { LibrariesView } from '../runner/libraries-view.js';
import { bindSteps, stepLabel, stepNote, type LibraryStep } from '../runner/step-binding.js';
import {
    ELEMENT_COLORS,
    ELEMENT_ICONS,
    elementAt,
    elementLabel,
    emptyMessage,
    fetchElements,
    type Element
} from './elements-tree.js';
import { TreeLoader } from './tree-loader.js';

export const ELEMENTS_VIEW_ID = 'jpipe.elements';

/** A step of a checked library, under the element it implements. */
interface StepRow {
    element: Element;
    step: LibraryStep;
}

type Row = Element | StepRow;

const isStep = (row: Row): row is StepRow => 'step' in row;

/**
 * The jPipe activity's Outline: the elements of the model selected in Models.
 *
 * It follows Models rather than the editor, so a model can be looked into without opening its
 * file — and since Models follows the editor, it follows the editor too. Within the model, it
 * selects the element the cursor is in, as the Explorer's Outline does.
 *
 * Its rows are the model's own elements in the order written, then the ones it inherits under
 * their qualified ids (`T:e1`); `elements-tree.ts` decides which they are and how they read. Once a
 * library is checked, each element has under it the steps implementing it, as `step-binding.ts`
 * works them out.
 */
export class ElementsView implements vscode.TreeDataProvider<Row>, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<undefined>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    private readonly view: vscode.TreeView<Row>;
    private readonly disposables: vscode.Disposable[] = [];
    private model: Model | undefined;
    private elements: Element[] | undefined;
    /** Loaded as the Models view is: long enough to let a name be typed, short enough to look live. */
    private readonly loader = new TreeLoader(
        () => this.load(),
        () => this.view.visible,
        () => this.changeEmitter.fire(undefined));
    /** The id of the row last selected; see `ModelsView.selectedKey` for why it is kept here. */
    private selectedId: string | undefined;
    /** The steps of the checked libraries implementing each element, by element id. */
    private bindings = new Map<string, LibraryStep[]>();
    /** Whether any library was checked when the steps were bound: what "no step" is said against. */
    private anyChecked = false;

    constructor(
        private readonly client: LanguageClient,
        private readonly models: ModelsView,
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
                if (this.isShown(e.document.uri) && e.contentChanges.length > 0) this.loader.scheduleRefresh();
            }),
            this.view.onDidChangeSelection(e => {
                // A step counts as its element, so moving the cursor within that element leaves it selected.
                const row = e.selection[0];
                if (row) this.selectedId = isStep(row) ? row.element.id : row.id;
            }),
            this.view.onDidChangeVisibility(e => {
                if (e.visible && this.loader.isStale) this.refresh();
            }),
            vscode.window.onDidChangeTextEditorSelection(e => {
                if (e.textEditor === vscode.window.activeTextEditor) void this.revealElementAtCursor();
            })
        );
    }

    private isModelFile(uri: vscode.Uri): boolean {
        return this.model !== undefined && sameFile(this.model.uri, uri);
    }

    /** Whether `uri` holds something on show: the model, or a template it inherits elements from. */
    private isShown(uri: vscode.Uri): boolean {
        return this.isModelFile(uri) || (this.elements ?? []).some(e =>
            e.inheritedFrom !== undefined && sameFile(e.inheritedFrom.uri, uri));
    }

    refresh(): void {
        this.loader.refresh();
    }

    private async load(): Promise<void> {
        const selected = this.model;
        // The model is found in its file by where it was: after an edit above it, that is where
        // the server places it now, not where it was when it was selected.
        const model = selected && ((await this.models.freshModels()).find(m => m.key === selected.key) ?? selected);
        if (selected !== this.model) return;
        this.model = model;
        this.view.description = model?.name;
        if (!model || model.operator) {
            this.elements = [];
        } else {
            try {
                await this.client.start();
                const elements = await fetchElements((method, params) => this.client.sendRequest(method, params), model);
                // The selection may have moved on while the server was answering.
                if (model !== this.model) return;
                this.elements = elements;
            } catch (err: unknown) {
                this.logger.error(`Could not list the elements of ${model.name}: ${messageOf(err)}`);
                this.elements = undefined;
            }
        }
        this.view.message = emptyMessage(model, this.elements);
        this.bind();
    }

    private bind(): void {
        this.anyChecked = this.libraries.checkedLibraries().length > 0;
        this.bindings = this.model && this.elements
            ? bindSteps(this.model.name, this.elements.map(e => e.id), this.libraries.checkedSteps())
            : new Map();
    }

    async getChildren(row?: Row): Promise<Row[]> {
        if (row) return isStep(row) ? [] : (this.bindings.get(row.id) ?? []).map(step => ({ element: row, step }));
        await this.loader.loaded();
        setTimeout(() => void this.revealElementAtCursor(), 0);
        return this.elements ?? [];
    }

    getParent(row: Row): Element | undefined {
        return isStep(row) ? row.element : undefined;
    }

    getTreeItem(row: Row): vscode.TreeItem {
        return isStep(row) ? this.stepItem(row) : this.elementItem(row);
    }

    /** A step: the function, the library it is in, and a click that opens it there. */
    private stepItem({ element, step }: StepRow): vscode.TreeItem {
        const library = vscode.Uri.parse(step.libraryUri);
        const item = new vscode.TreeItem(stepLabel(step), vscode.TreeItemCollapsibleState.None);
        item.id = `${element.id}>${step.libraryUri}#${step.line}`;
        // The library's own file icon, from the user's icon theme: the Python logo in most of them.
        item.resourceUri = library;
        item.iconPath = vscode.ThemeIcon.File;
        item.description = vscode.workspace.asRelativePath(library);
        item.tooltip = `Implements ${element.id}\n${vscode.workspace.asRelativePath(library)}, line ${step.line + 1}`;
        item.command = {
            command: 'vscode.open',
            title: 'Open',
            arguments: [library, { selection: new vscode.Range(step.line, 0, step.line, 0) }]
        };
        return item;
    }

    private elementItem(element: Element): vscode.TreeItem {
        const steps = this.bindings.get(element.id);
        // Open by default: the steps are what a checked library is looked at for.
        const item = new vscode.TreeItem(elementLabel(element), steps?.length
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None);
        item.id = element.id;
        item.iconPath = new vscode.ThemeIcon(ELEMENT_ICONS[element.kind], new vscode.ThemeColor(ELEMENT_COLORS[element.kind]));
        // In grey, only what is wrong: a required element no step implements, or one with several.
        item.description = stepNote(element.kind, steps, this.anyChecked);
        item.tooltip = `${element.kind === 'support' ? '@support' : element.kind} ${element.id}` +
            (element.label ? `\n${element.label}` : '') +
            (element.inheritedFrom ? `\nInherited from ${element.inheritedFrom.template}` : '');
        if (this.model) {
            item.command = {
                command: 'vscode.open',
                title: 'Open',
                arguments: [
                    // An inherited element opens where it is declared, in its template.
                    vscode.Uri.parse(element.inheritedFrom?.uri ?? this.model.uri),
                    { selection: editorRange(cursorAt(element.selection)) }
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
        this.loader.dispose();
        for (const d of this.disposables) d.dispose();
    }
}
