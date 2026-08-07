import * as vscode from 'vscode';

const SETTING = 'excludedDirectories';

/**
 * Owns the client-side view of `jpipe.excludedDirectories`.
 *
 * Setting entries are stored relative to a workspace root: `relative/path` in a single-root
 * workspace, `rootName:relative/path` in a multi-root one. This class is the only place that
 * encodes and decodes that format, and the only place that writes the setting.
 */
export class ExclusionManager implements vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    private readonly disposables: vscode.Disposable[] = [];
    /** Resolved folders, recomputed lazily — `isExcluded` is called for every file the Explorer shows. */
    private resolved: vscode.Uri[] | undefined;

    /** Fires whenever the resolved set of excluded directories may have changed. */
    readonly onDidChange = this.changeEmitter.event;

    constructor() {
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration(`jpipe.${SETTING}`)) this.refresh();
            }),
            // Resolution depends on the workspace roots, so adding or removing one re-resolves.
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh())
        );
    }

    private refresh(): void {
        this.resolved = undefined;
        this.changeEmitter.fire();
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.changeEmitter.dispose();
    }

    /** The raw setting entries, as stored in `settings.json`. */
    getEntries(): string[] {
        return vscode.workspace.getConfiguration('jpipe').get<string[]>(SETTING, []);
    }

    /** Excluded directories as absolute URIs — the form the language server consumes. */
    getResolvedUris(): string[] {
        return this.getResolvedFolders().map(uri => uri.toString());
    }

    /**
     * Excluded directories as URI paths. This is deliberately `uri.path` and not `uri.fsPath`:
     * it feeds the `jpipe.excludedPaths` context key, which menu `when` clauses compare against
     * VS Code's `resourcePath` — the Uri path without the scheme, which on Windows is
     * `/c:/dir`, not `c:\dir`.
     */
    getExcludedResourcePaths(): string[] {
        return this.getResolvedFolders().map(uri => uri.path);
    }

    /** True when `uri` is one of the excluded directories, or lives inside one. */
    isExcluded(uri: vscode.Uri): boolean {
        return this.getResolvedFolders().some(dir => isSameOrInside(dir, uri));
    }

    /** True when `uri` is itself a declared excluded directory (not merely inside one). */
    isExcludedRoot(uri: vscode.Uri): boolean {
        return this.getResolvedFolders().some(dir => dir.toString() === stripTrailingSlash(uri.toString()));
    }

    /** Add `folder` to the setting. Returns false when it is outside the workspace. */
    async addFolder(folder: vscode.Uri): Promise<boolean> {
        const entry = this.encode(folder);
        if (!entry) return false;
        const current = this.getEntries();
        if (!current.includes(entry)) {
            await this.write([...current, entry]);
        }
        return true;
    }

    /**
     * Remove `folder` from the setting. Entries that resolve to `folder` are dropped even when
     * they are spelled differently from what `encode` would produce.
     */
    async removeFolder(folder: vscode.Uri): Promise<boolean> {
        const target = stripTrailingSlash(folder.toString());
        const current = this.getEntries();
        const remaining = current.filter(entry => {
            const resolved = this.decode(entry);
            return resolved === undefined || resolved.toString() !== target;
        });
        if (remaining.length === current.length) return false;
        await this.write(remaining);
        return true;
    }

    /** Remove a raw setting entry (used by the "remove" quick pick). */
    async removeEntry(entry: string): Promise<void> {
        await this.write(this.getEntries().filter(e => e !== entry));
    }

    private async write(entries: string[]): Promise<void> {
        await vscode.workspace.getConfiguration('jpipe').update(SETTING, entries, vscode.ConfigurationTarget.Workspace);
        // The configuration event also invalidates the cache, but its ordering relative to this
        // promise is not guaranteed — drop it here so callers read the value they just wrote.
        this.resolved = undefined;
    }

    private getResolvedFolders(): vscode.Uri[] {
        if (this.resolved === undefined) {
            const resolved: vscode.Uri[] = [];
            for (const entry of this.getEntries()) {
                const uri = this.decode(entry);
                if (uri) resolved.push(uri);
            }
            this.resolved = resolved;
        }
        return this.resolved;
    }

    /** `rootName:relative/path` or `relative/path` → absolute URI. */
    private decode(entry: string): vscode.Uri | undefined {
        if (!entry || entry.trim().length === 0) return undefined;
        const roots = vscode.workspace.workspaceFolders ?? [];
        const colon = entry.indexOf(':');
        if (colon > 0) {
            const folder = roots.find(f => f.name === entry.slice(0, colon));
            const rel = entry.slice(colon + 1);
            if (!folder || !rel) return undefined;
            return vscode.Uri.parse(stripTrailingSlash(vscode.Uri.joinPath(folder.uri, rel).toString()));
        }
        if (roots.length !== 1) return undefined;
        return vscode.Uri.parse(stripTrailingSlash(vscode.Uri.joinPath(roots[0].uri, entry).toString()));
    }

    /** Absolute URI → `rootName:relative/path` or `relative/path`; undefined outside the workspace. */
    private encode(folder: vscode.Uri): string | undefined {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(folder);
        if (!workspaceFolder) return undefined;
        const roots = vscode.workspace.workspaceFolders ?? [];
        const rel = vscode.workspace.asRelativePath(folder, false).replaceAll('\\', '/');
        return roots.length > 1 ? `${workspaceFolder.name}:${rel}` : rel;
    }
}

/**
 * Marks excluded directories, and everything inside them, with a badge and a dimmed label —
 * in the Explorer, on editor tabs and in the Open Editors view.
 */
export class ExclusionDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
    private readonly decorationEmitter = new vscode.EventEmitter<undefined>();
    private readonly subscription: vscode.Disposable;

    readonly onDidChangeFileDecorations = this.decorationEmitter.event;

    constructor(private readonly manager: ExclusionManager) {
        // Refresh every decoration: which paths are affected changes wholesale.
        this.subscription = manager.onDidChange(() => this.decorationEmitter.fire(undefined));
    }

    dispose(): void {
        this.subscription.dispose();
        this.decorationEmitter.dispose();
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme !== 'file' || !this.manager.isExcluded(uri)) return undefined;
        return {
            badge: '⊘',
            color: new vscode.ThemeColor('disabledForeground'),
            tooltip: this.manager.isExcludedRoot(uri)
                ? 'Excluded from jPipe validation'
                : 'Inside a folder excluded from jPipe validation',
            // Without this the badge would bubble up to every ancestor folder.
            propagate: false
        };
    }
}

function stripTrailingSlash(uri: string): string {
    return uri.endsWith('/') ? uri.slice(0, -1) : uri;
}

/** Path containment on URI segment boundaries, so `foo-old` is not matched by `foo`. */
function isSameOrInside(parent: vscode.Uri, child: vscode.Uri): boolean {
    const parentPath = stripTrailingSlash(parent.toString());
    const childPath = stripTrailingSlash(child.toString());
    return childPath === parentPath || childPath.startsWith(`${parentPath}/`);
}
