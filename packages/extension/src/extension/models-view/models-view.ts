import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import {
    buildTree,
    fetchModels,
    modelAtLine,
    nodeForModel,
    type GroupNode,
    type Model,
    type ModelNode,
    type TreeNode
} from './models-tree.js';

export const MODELS_VIEW_ID = 'jpipe.models';

/**
 * How long to wait after the last edit before asking the server again. Long enough that typing
 * a name does not send a request per keystroke, short enough that a renamed model looks renamed.
 */
const REFRESH_DELAY_MS = 500;

/**
 * The Models view: every template and justification in the workspace, in the jPipe activity.
 *
 * The shape of the tree and the requests behind it are decided in `models-tree.ts`; this class
 * owns only what needs the editor — the `TreeDataProvider`, when to refresh, and following the
 * active editor.
 *
 * Refreshing is driven from this side, since the standard protocol has no "symbols changed"
 * notification. The triggers are the ones that can change the answer: `.jd` files created,
 * deleted or changed on disk, and edits to an open model. A refresh requested while the view is
 * hidden is only remembered, and made when the view is shown — there is no point keeping a tree
 * nobody is looking at up to date.
 */
export class ModelsView implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<undefined>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    private readonly view: vscode.TreeView<TreeNode>;
    private readonly disposables: vscode.Disposable[] = [];
    private tree: GroupNode[] = [];
    private models: Model[] = [];
    /** The load in progress, which `getChildren` waits on so the view shows progress, not emptiness. */
    private loading: Promise<void> | undefined;
    private stale = true;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly client: LanguageClient, private readonly logger: JpipeLogger) {
        this.view = vscode.window.createTreeView(MODELS_VIEW_ID, {
            treeDataProvider: this,
            showCollapseAll: true
        });

        const watcher = vscode.workspace.createFileSystemWatcher('**/*.jd');
        this.disposables.push(
            this.view,
            this.changeEmitter,
            watcher,
            watcher.onDidCreate(() => this.scheduleRefresh()),
            watcher.onDidDelete(() => this.scheduleRefresh()),
            watcher.onDidChange(() => this.scheduleRefresh()),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.languageId === 'jpipe' && e.contentChanges.length > 0) this.scheduleRefresh();
            }),
            this.view.onDidChangeVisibility(e => {
                if (e.visible && this.stale) this.refresh();
                else if (e.visible) void this.revealActiveModel();
            }),
            vscode.window.onDidChangeActiveTextEditor(() => void this.revealActiveModel()),
            vscode.window.onDidChangeTextEditorSelection(e => {
                if (e.textEditor === vscode.window.activeTextEditor) void this.revealActiveModel();
            })
        );
    }

    /** Ask the server again, now if the view is showing, otherwise the next time it is. */
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
        try {
            await this.client.start();
            this.models = await fetchModels((method, params) => this.client.sendRequest(method, params));
            this.tree = buildTree(this.models);
            this.view.message = undefined;
        } catch (err: unknown) {
            this.logger.error(`Could not list the workspace's models: ${messageOf(err)}`);
            this.view.message = 'Could not list the models — see the jPipe output channel.';
        }
    }

    async getChildren(node?: TreeNode): Promise<TreeNode[]> {
        if (node) return node.children;
        // Being asked means someone is looking; no need to fire a change for the answer.
        if (this.stale) this.startLoad();
        await this.loading;
        // The first paint is the moment the view becomes visible, so it is also the first moment
        // there is anything to reveal.
        setTimeout(() => void this.revealActiveModel(), 0);
        return this.tree;
    }

    getParent(node: TreeNode): TreeNode | undefined {
        return node.type === 'model' ? node.parent : undefined;
    }

    getTreeItem(node: TreeNode): vscode.TreeItem {
        if (node.type === 'group') {
            const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
            item.id = node.id;
            item.description = String(node.children.length);
            item.contextValue = 'jpipe.group';
            return item;
        }
        return this.modelItem(node);
    }

    private modelItem(node: ModelNode): vscode.TreeItem {
        const { model } = node;
        const uri = vscode.Uri.parse(model.uri);
        const item = new vscode.TreeItem(
            model.name,
            node.children.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );
        item.id = node.id;
        // Set so that file decorations apply — notably the exclusion badge, which marks a model
        // whose file jPipe is not validating without this view having to know about exclusions.
        item.resourceUri = uri;
        item.iconPath = new vscode.ThemeIcon(model.kind === 'template' ? 'symbol-interface' : 'symbol-class');
        item.description = vscode.workspace.asRelativePath(uri);
        const kind = model.kind === 'template' ? 'Template' : 'Justification';
        item.tooltip = new vscode.MarkdownString(
            `**${kind}** \`${model.name}\`` +
            (node.parentName ? ` implements \`${node.parentName}\`` : '') +
            `\n\n${vscode.workspace.asRelativePath(uri)}`
        );
        item.contextValue = `jpipe.model.${model.kind}`;
        item.command = {
            command: 'vscode.open',
            title: 'Open',
            arguments: [uri, { selection: this.selectionOf(model), preserveFocus: false }]
        };
        return item;
    }

    private selectionOf(model: Model): vscode.Range {
        const { start, end } = model.selection;
        return new vscode.Range(start.line, start.character, end.line, end.character);
    }

    /** Open the file declaring `node`'s model with the cursor on its name. */
    async openModel(node: ModelNode): Promise<void> {
        await vscode.window.showTextDocument(vscode.Uri.parse(node.model.uri), {
            selection: this.selectionOf(node.model)
        });
    }

    /**
     * Select the model the cursor is in, the way the Explorer selects the active file.
     *
     * Never takes focus — it follows the editor, it does not compete with it — and does nothing
     * while the view is hidden, because revealing would open the jPipe activity on every cursor
     * move in a `.jd` file.
     */
    private async revealActiveModel(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!this.view.visible || editor?.document.languageId !== 'jpipe') return;
        const uri = editor.document.uri.toString();
        const inFile = this.models.filter(m => vscode.Uri.parse(m.uri).toString() === uri);
        const model = modelAtLine(inFile, editor.selection.active.line);
        const node = model ? nodeForModel(this.tree, model.key) : undefined;
        if (!node || this.view.selection[0]?.id === node.id) return;
        try {
            await this.view.reveal(node, { select: true, focus: false, expand: false });
        } catch {
            // The tree moved under us (a refresh landed mid-reveal). The next cursor move retries.
        }
    }

    dispose(): void {
        if (this.timer) clearTimeout(this.timer);
        for (const d of this.disposables) d.dispose();
    }
}
