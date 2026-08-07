import * as vscode from 'vscode';

const SETTING = 'excludedPaths';
/** Pre-1.4 name, still honoured so existing settings keep working. Never written to. */
const LEGACY_SETTING = 'excludedDirectories';

const JD_EXTENSION = '.jd';

/**
 * Owns the client-side view of `jpipe.excludedPaths`.
 *
 * An entry is either a directory or a single `.jd` file. Entries are stored relative to a
 * workspace root: `relative/path` in a single-root workspace, `rootName:relative/path` in a
 * multi-root one. This class is the only place that encodes and decodes that format, and the
 * only place that writes the setting.
 */
export class ExclusionManager implements vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    private readonly disposables: vscode.Disposable[] = [];
    /** Resolved entries, recomputed lazily — `isExcluded` is called for every file the Explorer shows. */
    private resolved: vscode.Uri[] | undefined;

    /** Fires whenever the resolved set of excluded paths may have changed. */
    readonly onDidChange = this.changeEmitter.event;

    constructor() {
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration(`jpipe.${SETTING}`) || e.affectsConfiguration(`jpipe.${LEGACY_SETTING}`)) {
                    this.refresh();
                }
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

    /** The raw setting entries — the current key first, then any left over under the old name. */
    getEntries(): string[] {
        const config = vscode.workspace.getConfiguration('jpipe');
        return [...new Set([
            ...config.get<string[]>(SETTING, []),
            ...config.get<string[]>(LEGACY_SETTING, [])
        ])];
    }

    /** Excluded paths as absolute URIs — the form the language server consumes. */
    getResolvedUris(): string[] {
        return this.getResolvedPaths().map(uri => uri.toString());
    }

    /**
     * Excluded paths as URI paths. This is deliberately `uri.path` and not `uri.fsPath`:
     * it feeds the `jpipe.excludedResourcePaths` context key, which menu `when` clauses compare
     * against VS Code's `resourcePath` — the Uri path without the scheme, which on Windows is
     * `/c:/dir`, not `c:\dir`.
     */
    getExcludedResourcePaths(): string[] {
        return this.getResolvedPaths().map(uri => uri.path);
    }

    /** True when `uri` is an excluded path itself, or lives inside an excluded directory. */
    isExcluded(uri: vscode.Uri): boolean {
        return this.getResolvedPaths().some(excluded => isSameOrInside(excluded, uri));
    }

    /** True when `uri` is itself a declared entry (not merely inside an excluded directory). */
    isExcludedRoot(uri: vscode.Uri): boolean {
        const target = stripTrailingSlash(uri.toString());
        return this.getResolvedPaths().some(excluded => excluded.toString() === target);
    }

    /** Add `target` (a folder or a `.jd` file) to the setting. False when outside the workspace. */
    async addPath(target: vscode.Uri): Promise<boolean> {
        const entry = this.encode(target);
        if (!entry) return false;
        const config = vscode.workspace.getConfiguration('jpipe');
        const current = config.get<string[]>(SETTING, []);
        if (!current.includes(entry)) {
            await this.write(SETTING, [...current, entry]);
        }
        return true;
    }

    /**
     * Remove whichever entries resolve to `target`, in either setting. Entries are matched by
     * what they resolve to, so one spelled differently from `encode`'s output is still removed —
     * and an entry inherited from the deprecated key can be removed from the UI.
     */
    async removeResolved(target: vscode.Uri): Promise<boolean> {
        const wanted = stripTrailingSlash(target.toString());
        return this.removeMatching(entry => {
            const resolved = this.decode(entry);
            return resolved !== undefined && resolved.toString() === wanted;
        });
    }

    /** Remove a raw setting entry (used by the "remove" quick pick). */
    async removeEntry(entry: string): Promise<boolean> {
        return this.removeMatching(e => e === entry);
    }

    /** Drop matching entries from both settings, writing back only the ones that changed. */
    private async removeMatching(matches: (entry: string) => boolean): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('jpipe');
        let removed = false;
        for (const key of [SETTING, LEGACY_SETTING]) {
            const current = config.get<string[]>(key, []);
            const remaining = current.filter(entry => !matches(entry));
            if (remaining.length !== current.length) {
                await this.write(key, remaining);
                removed = true;
            }
        }
        return removed;
    }

    private async write(key: string, entries: string[]): Promise<void> {
        await vscode.workspace.getConfiguration('jpipe').update(key, entries, vscode.ConfigurationTarget.Workspace);
        // The configuration event also invalidates the cache, but its ordering relative to this
        // promise is not guaranteed — drop it here so callers read the value they just wrote.
        this.resolved = undefined;
    }

    private getResolvedPaths(): vscode.Uri[] {
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
    private encode(target: vscode.Uri): string | undefined {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(target);
        if (!workspaceFolder) return undefined;
        const roots = vscode.workspace.workspaceFolders ?? [];
        const rel = vscode.workspace.asRelativePath(target, false).replaceAll('\\', '/');
        return roots.length > 1 ? `${workspaceFolder.name}:${rel}` : rel;
    }
}

const DECLARED_DECORATION: vscode.FileDecoration = {
    badge: '⊘',
    color: new vscode.ThemeColor('disabledForeground'),
    tooltip: 'Excluded from jPipe validation',
    // Without this the badge would bubble up to every ancestor folder.
    propagate: false
};

const INSIDE_DECORATION: vscode.FileDecoration = {
    badge: '⊘',
    color: new vscode.ThemeColor('disabledForeground'),
    tooltip: 'Inside a folder excluded from jPipe validation',
    propagate: false
};

/**
 * Marks what jPipe is not checking — in the Explorer, on editor tabs and in Open Editors.
 *
 * Decorated: the declared entry itself, plus the `.jd` files and the sub-directories beneath an
 * excluded directory. A `README.md` next to the counter-examples is left alone: jPipe never
 * validated it, so calling it "excluded" would be noise.
 */
export class ExclusionDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
    private readonly decorationEmitter = new vscode.EventEmitter<undefined>();
    private readonly subscription: vscode.Disposable;
    /** Memoised `isDirectory` results, so scrolling a large tree does not re-stat. */
    private readonly directoryCache = new Map<string, boolean>();

    readonly onDidChangeFileDecorations = this.decorationEmitter.event;

    constructor(private readonly manager: ExclusionManager) {
        // Refresh every decoration: which paths are affected changes wholesale.
        this.subscription = manager.onDidChange(() => {
            // A path that swapped between file and directory keeps a stale entry until the next
            // exclusion change; that is the only staleness this cache can produce.
            this.directoryCache.clear();
            this.decorationEmitter.fire(undefined);
        });
    }

    dispose(): void {
        this.subscription.dispose();
        this.decorationEmitter.dispose();
        this.directoryCache.clear();
    }

    // Ordered cheapest-first: the filesystem is only touched for an item that is already inside
    // an excluded directory and is not a `.jd` file, which is the one case a Uri alone cannot
    // settle (an extension-less `LICENSE` looks exactly like a directory).
    async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
        if (uri.scheme !== 'file' || !this.manager.isExcluded(uri)) return undefined;
        if (this.manager.isExcludedRoot(uri)) return DECLARED_DECORATION;
        if (uri.path.toLowerCase().endsWith(JD_EXTENSION)) return INSIDE_DECORATION;
        return await this.isDirectory(uri) ? INSIDE_DECORATION : undefined;
    }

    private async isDirectory(uri: vscode.Uri): Promise<boolean> {
        const key = uri.toString();
        const cached = this.directoryCache.get(key);
        if (cached !== undefined) return cached;
        let isDirectory = false;
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
        } catch {
            // Deleted or unreadable: not decorated. `provideFileDecoration` must not reject.
        }
        this.directoryCache.set(key, isDirectory);
        return isDirectory;
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
