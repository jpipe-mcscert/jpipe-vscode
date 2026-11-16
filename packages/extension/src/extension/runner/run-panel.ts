import * as vscode from 'vscode';
import type { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import type { HostToRunPanel, NoticeAction, RunPanelToHost } from '../../shared/run-protocol.js';
import type { ModelsView } from '../models-view/models-view.js';
import { revealColumnAmong } from '../preview/reveal-column.js';
import { ZOOM_SENSITIVITY_SETTING, clampZoomSensitivity } from '../preview/zoom-sensitivity.js';
import { LIBRARIES_VIEW_ID } from './libraries-view.js';
import type { ResultsView } from './results-view.js';
import { getRunShellHtml } from './run-shell.js';
import type { RunSession } from './run-session.js';
import { elementLocation, panelState } from './run-state.js';

/** The webview panel's type, which VS Code keys a panel's state by. */
export const RUN_PANEL_TYPE = 'jpipe.run';

/** Where each notice's button goes. */
const NOTICE_COMMANDS: Readonly<Record<Exclude<NoticeAction, 'showOutput'>, string>> = {
    showLibraries: `${LIBRARIES_VIEW_ID}.focus`,
    fixEnvironment: 'jpipe.runner.fixEnvironment',
    showProblems: 'workbench.actions.view.problems'
};

/**
 * The run panel: the last run's dataflow, as jpipe-runner draws it, beside the editor
 * (jpipe-vscode ADR-VSC-0031). There is one, opened by ▶ and ✓, reused for every run, and
 * never locking its editor group (ADR-VSC-0019).
 *
 * What it shows is the session's: this only opens it, tells the page, and acts on what the page
 * asks. Its decisions are in `run-state.ts`, which is tested.
 */
export class RunPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly runEmitter = new vscode.EventEmitter<boolean>();
    /** The panel's ▶ (false) or ✓ (true) was pressed: run the justification on show again, or check it. */
    readonly onDidRequestRun = this.runEmitter.event;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly logger: JpipeLogger,
        private readonly session: RunSession,
        private readonly results: ResultsView,
        private readonly models: ModelsView
    ) {
        this.disposables.push(
            this.runEmitter,
            session.onDidChange(() => this.sendState()),
            results.onDidSelectElement(element => this.post({ type: 'select', element })),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration(`jpipe.${ZOOM_SENSITIVITY_SETTING}`)) this.postConfig();
            })
        );
    }

    /**
     * Open the panel beside the editor, or bring it forward, leaving the focus where it is; and the
     * Results view with it, at the bottom, since the two show one run.
     */
    reveal(): void {
        if (this.panel) {
            this.panel.reveal(undefined, true);
        } else {
            this.panel = this.create();
            this.sendState();
        }
        void this.results.bringForward();
    }

    private create(): vscode.WebviewPanel {
        const panel = vscode.window.createWebviewPanel(
            RUN_PANEL_TYPE,
            'jPipe Run',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                // The run is kept in memory only, and the pan and zoom with the page.
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview')]
            }
        );
        panel.webview.html = getRunShellHtml(panel.webview, this.context.extensionUri);
        panel.iconPath = {
            light: vscode.Uri.joinPath(this.context.extensionUri, 'images', 'icon_light.svg'),
            dark: vscode.Uri.joinPath(this.context.extensionUri, 'images', 'icon_dark.svg')
        };
        // The page's listener lives as long as the panel, not as long as the extension: a panel
        // closed and opened again must not leave its predecessor's listener behind.
        const listener = panel.webview.onDidReceiveMessage((msg: RunPanelToHost) => void this.receive(msg));
        panel.onDidDispose(() => {
            listener.dispose();
            this.panel = undefined;
        });
        return panel;
    }

    /** Act on what the page asks; whatever fails is logged and said, never left unhandled. */
    private async receive(msg: RunPanelToHost): Promise<void> {
        try {
            await this.act(msg);
        } catch (err: unknown) {
            this.logger.error(`The run panel could not do '${msg.type}': ${messageOf(err)}`);
            void vscode.window.showErrorMessage(`jPipe could not do that: ${messageOf(err)}`);
        }
    }

    private async act(msg: RunPanelToHost): Promise<void> {
        switch (msg.type) {
            case 'ready':
                this.postConfig();
                this.sendState();
                break;
            case 'run':
            case 'check':
                this.runEmitter.fire(msg.type === 'check');
                break;
            case 'stop':
                this.session.stop();
                break;
            case 'results':
                await this.results.reveal(msg.row);
                break;
            case 'output':
                if (!this.session.showOutput()) this.results.showOutput();
                break;
            case 'select':
                // Clearing the panel's selection leaves Results as it is: it lists the run, and
                // its selection is only ever a row.
                if (msg.element !== null) await this.results.reveal(`element/${msg.element}`, false);
                break;
            case 'open':
                await this.openElement(msg.element);
                break;
            case 'download':
                await this.download();
                break;
            case 'action':
                await this.noticeAction(msg.id);
                break;
        }
    }

    /**
     * Do what a notice's button says. Setting the environment up is followed by the run it stopped,
     * once the environment can run steps: that run is why the reader pressed it.
     */
    private async noticeAction(id: NoticeAction): Promise<void> {
        if (id === 'showOutput') {
            this.session.showOutput();
            return;
        }
        const done = await vscode.commands.executeCommand<boolean | undefined>(NOTICE_COMMANDS[id]);
        const run = this.session.run;
        if (id === 'fixEnvironment' && done === true && run) this.runEmitter.fire(run.check);
    }

    private sendState(): void {
        const run = this.session.run;
        if (!this.panel || !run) return;
        this.panel.title = `Run: ${run.name}`;
        this.post({ type: 'state', state: panelState(run, this.session.revision) });
    }

    private post(message: HostToRunPanel): void {
        void this.panel?.webview.postMessage(message);
    }

    /** The zoom setting is the preview's: one canvas, one feel. */
    private postConfig(): void {
        const sensitivity = vscode.workspace.getConfiguration('jpipe').get<unknown>(ZOOM_SENSITIVITY_SETTING, 1);
        this.post({ type: 'config', zoomSensitivity: clampZoomSensitivity(sensitivity) });
    }

    /**
     * Open a double-clicked element where it is declared: in the model the report says it was
     * reached through last, looked up among the workspace's models — the run's own document first,
     * since names are unique only within a file. An element the model does not declare itself, one
     * it inherits, opens the model.
     */
    private async openElement(id: string): Promise<void> {
        const run = this.session.run;
        if (!run) return;
        const { model: modelName, element } = elementLocation(id);
        const named = (await this.models.freshModels()).filter(m => m.name === (modelName ?? run.name));
        const model = named.find(m => vscode.Uri.parse(m.uri).toString() === run.uri) ?? named[0];
        if (!model) {
            void vscode.window.showInformationMessage(`${id} is not declared in a model of this workspace.`);
            return;
        }
        try {
            const uri = vscode.Uri.parse(model.uri);
            const document = await vscode.workspace.openTextDocument(uri);
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
                'vscode.executeDocumentSymbolProvider', uri) ?? [];
            const declared = symbols.find(s => s.name === model.name)?.children.find(s => s.name === element);
            const { start } = model.selection;
            const range = declared?.selectionRange ?? new vscode.Range(start.line, start.character, start.line, start.character);
            await vscode.window.showTextDocument(document, {
                viewColumn: revealColumnAmong(vscode.window.visibleTextEditors, document),
                selection: range
            });
        } catch (err: unknown) {
            this.logger.warn(`Could not open ${id}: ${messageOf(err)}`);
        }
    }

    /** Save the runner's drawing where the user says. */
    private async download(): Promise<void> {
        const run = this.session.run;
        const svg = run?.dataflow;
        if (!run || !svg) return;
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(run.uri))?.uri;
        const name = `${run.name}-dataflow.svg`;
        const target = await vscode.window.showSaveDialog({
            defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined,
            filters: { SVG: ['svg'] }
        });
        if (!target) return;
        try {
            await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(svg));
        } catch (err: unknown) {
            this.logger.error(`Could not save the dataflow of ${run.name} to ${target.fsPath}: ${messageOf(err)}`);
            void vscode.window.showErrorMessage(`The dataflow of ${run.name} was not saved: ${messageOf(err)}`);
            return;
        }
        this.logger.info(`Saved the dataflow of ${run.name} to ${target.fsPath}`);
    }

    dispose(): void {
        this.panel?.dispose();
        for (const d of this.disposables) d.dispose();
    }
}
