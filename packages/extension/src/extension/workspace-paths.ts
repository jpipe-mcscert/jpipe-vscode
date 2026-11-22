import * as vscode from 'vscode';
import { formatEntry, parseEntry, stripTrailingSlash } from './exclusion-paths.js';

/**
 * How a setting names a file or folder of the workspace: `relative/path` in a single-root
 * workspace, `rootName:relative/path` in a multi-root one.
 *
 * Shared by every setting that lists workspace paths — excluded paths, step libraries — so they
 * are spelled one way and a path written by one reads the same in another. The spelling itself,
 * and its edge cases, are in `exclusion-paths.ts`, where they are tested.
 */

/** `rootName:relative/path` or `relative/path` → absolute URI; undefined if no root matches. */
export function decodeWorkspacePath(entry: string): vscode.Uri | undefined {
    const parsed = parseEntry(entry);
    if (!parsed) return undefined;
    const roots = vscode.workspace.workspaceFolders ?? [];
    // A bare entry can only be resolved when there is exactly one root to resolve it against.
    let folder: vscode.WorkspaceFolder | undefined;
    if (parsed.rootName !== undefined) {
        folder = roots.find(f => f.name === parsed.rootName);
    } else if (roots.length === 1) {
        folder = roots[0];
    }
    if (!folder) return undefined;
    return vscode.Uri.parse(stripTrailingSlash(vscode.Uri.joinPath(folder.uri, parsed.relativePath).toString()));
}

/** Absolute URI → `rootName:relative/path` or `relative/path`; undefined outside the workspace. */
export function encodeWorkspacePath(target: vscode.Uri): string | undefined {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(target);
    if (!workspaceFolder) return undefined;
    const roots = vscode.workspace.workspaceFolders ?? [];
    const rel = vscode.workspace.asRelativePath(target, false).replaceAll('\\', '/');
    return formatEntry(roots.length > 1 ? workspaceFolder.name : undefined, rel);
}
