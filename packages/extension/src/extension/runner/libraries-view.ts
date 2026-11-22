import * as vscode from 'vscode';
import type { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import { decodeWorkspacePath, encodeWorkspacePath } from '../workspace-paths.js';
import { scanFile, type Step } from './library-scan.js';
import { LIBRARIES_SETTING } from './runner-invocation.js';
import type { LibraryStep } from './step-binding.js';
import type { RunnerEnvironment } from './environment.js';
import { fixLabel } from './python-environment.js';

export const LIBRARIES_VIEW_ID = 'jpipe.libraries';

/**
 * Where step libraries are not: virtual environments — the runner's own package defines the
 * decorators, and would otherwise be listed — and the caches and tool directories beside them.
 * One list, for the scan's glob and for a saved file alike.
 */
const IGNORED_FOLDERS = ['node_modules', '.venv', 'venv', 'site-packages', '__pycache__', '.tox', '.git', '.mypy_cache', '.pytest_cache'];
const IGNORED = `**/{${IGNORED_FOLDERS.join(',')}}/**`;
/** A path inside one of them, as a saved file's: the same folders the scan leaves out. */
const IN_IGNORED = new RegExp(`/(${IGNORED_FOLDERS.map(name => name.replaceAll('.', String.raw`\.`)).join('|')})/`);

/** A Python file declaring steps, or importing the decorators to declare them. */
export interface Library {
    uri: vscode.Uri;
    steps: Step[];
}

/** The row above the libraries saying why a run would not work yet, and offering the fix. */
interface StatusRow {
    status: true;
}

type Row = Library | StatusRow;

const isStatus = (row: Row): row is StatusRow => 'status' in row;
const STATUS_ROW: StatusRow = { status: true };

/**
 * The jPipe activity's Libraries: every Python file of the workspace that declares jpipe-runner
 * steps, with a checkbox saying whether a run loads it.
 *
 * Files are found by reading them (`library-scan.ts`), never by importing them. The checkboxes
 * are the `jpipe.runner.libraries` workspace setting, so they last, can be edited by hand, and
 * are shared exactly when the project commits its `.vscode/settings.json`. Nothing is checked
 * until someone checks it: a run never loads a library nobody chose.
 */
export class LibrariesView implements vscode.TreeDataProvider<Row>, vscode.Disposable {
    private readonly treeEmitter = new vscode.EventEmitter<undefined>();
    readonly onDidChangeTreeData = this.treeEmitter.event;

    private readonly changeEmitter = new vscode.EventEmitter<void>();
    /** The libraries found, or which of them are checked, changed. */
    readonly onDidChange = this.changeEmitter.event;

    private readonly view: vscode.TreeView<Row>;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly libraries = new Map<string, Library>();
    private scanning: Promise<void> | undefined;
    /** Whether the environment fix has been proposed in this window; once is enough. */
    private offered = false;
    private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private readonly logger: JpipeLogger, private readonly environment: RunnerEnvironment) {
        this.view = vscode.window.createTreeView(LIBRARIES_VIEW_ID, {
            treeDataProvider: this,
            manageCheckboxStateManually: true
        });
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.py');
        this.disposables.push(
            this.view,
            this.treeEmitter,
            this.changeEmitter,
            watcher,
            watcher.onDidCreate(uri => this.rescanSoon(uri)),
            watcher.onDidChange(uri => this.rescanSoon(uri)),
            watcher.onDidDelete(uri => {
                if (this.libraries.delete(uri.toString())) this.changed();
            }),
            this.view.onDidChangeCheckboxState(e => void this.applyCheckboxes(e)),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration(`jpipe.${LIBRARIES_SETTING}`)) this.changed();
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => void this.rescanAll()),
            environment.onDidChange(() => {
                // A run with a checkout of the runner is not a run with a release: say so where runs start.
                this.view.description = environment.localRunner ? 'local jpipe-runner' : undefined;
                this.treeEmitter.fire(undefined);
            })
        );
    }

    /** Look for libraries for the first time. Called once, as the extension activates. */
    start(): void {
        this.scanning = this.scanAll();
    }

    /** Look at every Python file again. */
    rescanAll(): Promise<void> {
        this.libraries.clear();
        this.scanning = this.scanAll();
        return this.scanning;
    }

    private async scanAll(): Promise<void> {
        const files = await vscode.workspace.findFiles('**/*.py', IGNORED);
        await Promise.all(files.map(uri => this.scan(uri)));
        this.changed();
    }

    private rescanSoon(uri: vscode.Uri): void {
        if (vscode.workspace.getWorkspaceFolder(uri) === undefined) return;
        if (IN_IGNORED.test(uri.path)) return;
        const key = uri.toString();
        clearTimeout(this.pending.get(key));
        this.pending.set(key, setTimeout(async () => {
            this.pending.delete(key);
            await this.scan(uri);
            this.changed();
        }, 300));
    }

    private async scan(uri: vscode.Uri): Promise<void> {
        try {
            const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
            const { isLibrary, steps } = scanFile(text);
            if (isLibrary) this.libraries.set(uri.toString(), { uri, steps });
            else this.libraries.delete(uri.toString());
        } catch (err: unknown) {
            this.libraries.delete(uri.toString());
            this.logger.debug(`Could not read ${uri.fsPath} for step libraries: ${messageOf(err)}`);
        }
    }

    private changed(): void {
        // What the ▶ menu of a Python editor asks, to offer a run only on a checked library.
        void vscode.commands.executeCommand('setContext', 'jpipe.checkedLibraryPaths',
            this.checkedLibraries().map(library => library.uri.path));
        this.treeEmitter.fire(undefined);
        this.changeEmitter.fire();
        // A workspace with step libraries is one that will want to run them: if its Python cannot,
        // say so once, rather than at the first ▶ — when the workspace opens with libraries in
        // it, or when its first one is created, which is the moment the editor starts flagging
        // the `jpipe_runner` import.
        if (this.libraries.size > 0 && !this.offered) {
            this.offered = true;
            // Pylance after the environment, so the two offers never stack.
            void this.environment.offer(false).then(() => this.environment.offerPylance());
        }
    }

    /** The workspace paths of the checked libraries, as the setting holds them. */
    private entries(): string[] {
        return vscode.workspace.getConfiguration('jpipe').get<string[]>(LIBRARIES_SETTING, []) ?? [];
    }

    private checkedUris(): Set<string> {
        return new Set(this.entries()
            .map(entry => decodeWorkspacePath(entry)?.toString())
            .filter((uri): uri is string => uri !== undefined));
    }

    private async write(entries: string[]): Promise<void> {
        await vscode.workspace.getConfiguration('jpipe')
            .update(LIBRARIES_SETTING, entries, vscode.ConfigurationTarget.Workspace);
    }

    private async applyCheckboxes(e: vscode.TreeCheckboxChangeEvent<Row>): Promise<void> {
        let entries = this.entries();
        for (const [library, state] of e.items) {
            if (isStatus(library)) continue;
            const entry = encodeWorkspacePath(library.uri);
            if (!entry) continue;
            entries = entries.filter(existing => decodeWorkspacePath(existing)?.toString() !== library.uri.toString());
            if (state === vscode.TreeItemCheckboxState.Checked) entries.push(entry);
        }
        await this.write(entries);
    }

    /** Once the scan in progress, if any, is done: before asking how many libraries there are. */
    async ready(): Promise<void> {
        await this.scanning;
    }

    async checkAll(): Promise<void> {
        await this.scanning;
        const checked = this.checkedUris();
        const added = [...this.libraries.values()]
            .filter(library => !checked.has(library.uri.toString()))
            .map(library => encodeWorkspacePath(library.uri))
            .filter((entry): entry is string => entry !== undefined);
        await this.write([...this.entries(), ...added]);
    }

    async uncheckAll(): Promise<void> {
        await this.write([]);
    }

    /** A library just created: list it now rather than when the file watcher gets to it, and check it. */
    async add(uri: vscode.Uri): Promise<void> {
        await this.scan(uri);
        this.changed();
        const entry = encodeWorkspacePath(uri);
        if (entry && !this.checkedUris().has(uri.toString())) await this.write([...this.entries(), entry]);
    }

    /** Every library found, checked or not. */
    allLibraries(): Library[] {
        return this.sorted();
    }

    /** The checked libraries that exist and still declare steps, in path order. */
    checkedLibraries(): Library[] {
        const checked = this.checkedUris();
        return this.sorted().filter(library => checked.has(library.uri.toString()));
    }

    /** Every step of the checked libraries, as the Outline binds them. */
    checkedSteps(): LibraryStep[] {
        return this.checkedLibraries().flatMap(library => library.steps.map(step => ({
            ...step,
            libraryUri: library.uri.toString()
        })));
    }

    private sorted(): Library[] {
        return [...this.libraries.values()].sort((a, b) =>
            vscode.workspace.asRelativePath(a.uri).localeCompare(vscode.workspace.asRelativePath(b.uri)));
    }

    async getChildren(row?: Row): Promise<Row[]> {
        if (row) return [];
        await this.scanning;
        const libraries = this.sorted();
        // Only above libraries: with none, the view's own explanation of what a library is shows.
        return libraries.length > 0 && this.environment.message() ? [STATUS_ROW, ...libraries] : libraries;
    }

    getTreeItem(row: Row): vscode.TreeItem {
        if (isStatus(row)) return this.statusItem();
        const { uri, steps } = row;
        const path = vscode.workspace.asRelativePath(uri);
        const item = new vscode.TreeItem(path, vscode.TreeItemCollapsibleState.None);
        item.id = uri.toString();
        item.resourceUri = uri;
        item.checkboxState = this.checkedUris().has(uri.toString())
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked;
        const plural = steps.length === 1 ? '' : 's';
        item.description = `${steps.length} step${plural}`;
        item.tooltip = `${path}\n${steps.length} jpipe-runner step${plural}`;
        item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
        return item;
    }

    private statusItem(): vscode.TreeItem {
        const item = new vscode.TreeItem(this.environment.message() ?? '', vscode.TreeItemCollapsibleState.None);
        item.id = 'jpipe.runner.status';
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        const label = fixLabel(this.environment.status);
        if (label) {
            item.tooltip = `${this.environment.message()}\nClick to ${label.toLowerCase()}.`;
            item.command = { command: 'jpipe.runner.fixEnvironment', title: label };
        }
        return item;
    }

    dispose(): void {
        for (const timer of this.pending.values()) clearTimeout(timer);
        for (const d of this.disposables) d.dispose();
    }
}
