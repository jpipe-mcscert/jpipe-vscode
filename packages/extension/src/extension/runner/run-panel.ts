import * as vscode from 'vscode';
import type { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import type { HostToRunPanel, NoticeAction, RunPanelToHost } from '../../shared/run-protocol.js';
import { editorRange, sameFile, type ModelsView } from '../models-view/models-view.js';
import { fetchElements } from '../models-view/elements-tree.js';
import type { Model, Range, RequestFn } from '../models-view/models-tree.js';
import { revealColumnAmong } from '../preview/reveal-column.js';
import { ZOOM_SENSITIVITY_SETTING, clampZoomSensitivity } from '../preview/zoom-sensitivity.js';
import { LIBRARIES_VIEW_ID } from './libraries-view.js';
import type { ResultsView } from './results-view.js';
import { getRunShellHtml } from './run-shell.js';
import type { RunSession } from './run-session.js';
import { drawingOf, elementCandidates, panelState } from './run-state.js';

/** The webview panel's type, which VS Code keys a panel's state by. */
export const RUN_PANEL_TYPE = 'jpipe.run';

/** Where each notice's button goes. */
const NOTICE_COMMANDS: Readonly<Record<Exclude<NoticeAction, 'showOutput'>, string>> = {
    showLibraries: `${LIBRARIES_VIEW_ID}.focus`,
    fixEnvironment: 'jpipe.runner.fixEnvironment',
    showProblems: 'workbench.actions.view.problems',
    checkInstallation: 'jpipe.checkInstallation'
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
        private readonly models: ModelsView,
        /** The language server, for a model's elements as the Outline lists them. */
        private readonly request: RequestFn
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
                this.session.showOutput();
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
                await this.download(typeof msg.svg === 'string' ? msg.svg : null);
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
        // The run the button belongs to, taken before setting up, which may take a while: if another
        // run has started meanwhile, it is not the one to start again.
        const token = this.session.current;
        const check = this.session.run?.check ?? false;
        const done = await vscode.commands.executeCommand<boolean | undefined>(NOTICE_COMMANDS[id]);
        if (id === 'fixEnvironment' && done === true && this.session.isCurrent(token)) this.runEmitter.fire(check);
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
     * Open a double-clicked element where it is declared, found as the Outline finds a model's
     * elements, inherited ones included (`fetchElements`): in the justification shown, else in the
     * model the report names just before it (`elementCandidates`). Models are looked up among the
     * workspace's, the run's own document first, since names are unique only within a file. An
     * element found nowhere opens the first model looked in.
     */
    private async openElement(id: string): Promise<void> {
        const run = this.session.run;
        if (!run) return;
        const models = await this.models.freshModels();
        const modelNamed = (name: string): Model | undefined => {
            const named = models.filter(m => m.name === name);
            return named.find(m => sameFile(m.uri, run.uri)) ?? named[0];
        };
        let fallback: Model | undefined;
        for (const candidate of elementCandidates(id, run.name)) {
            const model = modelNamed(candidate.model);
            if (!model) continue;
            fallback ??= model;
            const found = (await fetchElements(this.request, model))?.elements.find(e => e.id === candidate.element);
            if (found) {
                // One an operator made up has no declaration: the model it is in stands for it.
                await this.openAt(vscode.Uri.parse(found.location?.uri ?? model.uri), found.location?.selection ?? model.selection);
                return;
            }
        }
        if (fallback) {
            await this.openAt(vscode.Uri.parse(fallback.uri), fallback.selection);
        } else {
            void vscode.window.showInformationMessage(`${id} is not declared in a model of this workspace.`);
        }
    }

    /** Open `uri` with `range` selected, in a column that holds text rather than over the panel. */
    private async openAt(uri: vscode.Uri, range: Range): Promise<void> {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, {
            viewColumn: revealColumnAmong(vscode.window.visibleTextEditors, document),
            selection: editorRange(range)
        });
    }

    /**
     * Save the drawing where the user says: the one the page shows, which, while a run's own drawing
     * is coloured as it goes, is the runner's with the statuses the run has decided so far.
     */
    private async download(shown: string | null): Promise<void> {
        const run = this.session.run;
        const svg = shown ?? (run && drawingOf(run));
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
