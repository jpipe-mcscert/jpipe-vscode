import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { JpipeLogger } from '../logger.js';
import type { ExclusionManager } from '../exclusions.js';
import { messageOf } from '../../shared/errors.js';
import {
    ambiguousNames,
    buildTree,
    fetchModels,
    modelAtLine,
    modelIcon,
    nodeForModel,
    type GroupNode,
    type Model,
    type ModelNode,
    type ModelStatus,
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
 *
 * The Errors and Excluded groups depend on things the server's symbols do not carry: the
 * diagnostics it has published, and the exclusion setting. When only those change, the models
 * already known are regrouped without asking the server again.
 */
export class ModelsView implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<undefined>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    private readonly view: vscode.TreeView<TreeNode>;
    private readonly disposables: vscode.Disposable[] = [];
    private tree: GroupNode[] = [];
    private models: Model[] = [];
    private ambiguous = new Set<string>();
    /** The load in progress, which `getChildren` waits on so the view shows progress, not emptiness. */
    private loading: Promise<void> | undefined;
    private stale = true;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly client: LanguageClient,
        private readonly exclusions: ExclusionManager,
        private readonly logger: JpipeLogger
    ) {
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
            vscode.languages.onDidChangeDiagnostics(e => {
                if (e.uris.some(uri => uri.path.endsWith('.jd'))) this.regroup();
            }),
            exclusions.onDidChange(() => this.regroup()),
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
            this.ambiguous = ambiguousNames(this.models);
            this.tree = buildTree(this.models, this.status());
            this.view.message = undefined;
        } catch (err: unknown) {
            this.logger.error(`Could not list the workspace's models: ${messageOf(err)}`);
            this.view.message = 'Could not list the models — see the jPipe output channel.';
        }
    }

    /** Rebuild the groups from the models already known — for a change the server's symbols do not see. */
    private regroup(): void {
        if (this.models.length === 0) return;
        this.tree = buildTree(this.models, this.status());
        this.changeEmitter.fire(undefined);
    }

    /** Only this extension's own diagnostics count: another linter's opinion of a `.jd` file is not a build failure. */
    private status(): ModelStatus {
        return {
            isExcluded: uri => this.exclusions.isExcluded(vscode.Uri.parse(uri)),
            errorLines: uri => (this.client.diagnostics?.get(vscode.Uri.parse(uri)) ?? [])
                .filter(d => d.severity === vscode.DiagnosticSeverity.Error)
                .map(d => d.range.start.line)
        };
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
            // Excluded starts folded: it is there to be found, not to be read every time.
            const item = new vscode.TreeItem(node.label, node.id === 'excluded'
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.Expanded);
            item.id = node.id;
            item.description = String(node.children.length);
            item.contextValue = `jpipe.group.${node.id}`;
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
        const path = vscode.workspace.asRelativePath(uri);
        // Codicons rather than shipped SVGs, so they follow the theme and take the tints below.
        item.iconPath = new vscode.ThemeIcon(modelIcon(model), new vscode.ThemeColor(this.iconColor(node)));
        // Kept short: the file and the operator are in the tooltip, and the icon already says
        // which operator. The file shows here only when another model has the same name.
        const facts = [
            ...(node.errors === undefined ? [] : [`${node.errors} error${node.errors === 1 ? '' : 's'}`]),
            ...(this.ambiguous.has(model.name) ? [path] : [])
        ];
        item.description = facts.length > 0 ? facts.join(' · ') : undefined;
        const kind = model.kind === 'template' ? 'Template' : 'Justification';
        item.tooltip = new vscode.MarkdownString(
            `**${kind}** \`${model.name}\`` +
            (node.parentName ? ` implements \`${node.parentName}\`` : '') +
            (model.operator ? ` — composed by \`${model.operator}\`` : '') +
            `\n\n${path}`
        );
        item.contextValue = `jpipe.model.${model.kind}`;
        item.command = {
            command: 'vscode.open',
            title: 'Open',
            arguments: [uri, { selection: this.selectionOf(model), preserveFocus: false }]
        };
        return item;
    }

    /**
     * Red in Errors, greyed in Excluded, and otherwise the model's own colour: one for templates,
     * one for justifications, one for compositions. All three are contributed by the extension, so
     * a theme or `workbench.colorCustomizations` can change them. By default templates and
     * justifications wear the editor's interface and class colours, as they do in the Outline and
     * Go to Symbol, and compositions its function colour — an operator applied to models being a
     * call, which is how Show Call Hierarchy presents them.
     */
    private iconColor(node: ModelNode): string {
        if (node.errors !== undefined) return 'list.errorForeground';
        if (node.parent.type === 'group' && node.parent.id === 'excluded') return 'disabledForeground';
        if (node.model.operator !== undefined) return 'jpipe.compositionIconForeground';
        return node.model.kind === 'template' ? 'jpipe.templateIconForeground' : 'jpipe.justificationIconForeground';
    }

    private selectionOf(model: Model): vscode.Range {
        const { start, end } = model.selection;
        return new vscode.Range(start.line, start.character, end.line, end.character);
    }

    /** The models as of the last refresh. */
    get knownModels(): readonly Model[] {
        return this.models;
    }

    /** The model selected in the view, if a model row is selected. */
    get selectedModel(): Model | undefined {
        const node = this.view.selection[0];
        return node?.type === 'model' ? node.model : undefined;
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
