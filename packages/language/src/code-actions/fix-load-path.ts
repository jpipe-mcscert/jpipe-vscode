/**
 * "Change to './lib/base.jd'" — repairing a `load` whose path names nothing.
 *
 * The usual cause is a file that moved or a path typed from memory, so the candidates are the
 * `.jd` files the workspace already knows about: first those whose name matches exactly, then
 * those whose name is close enough to be a typo. Paths are offered relative to the file doing the
 * loading, which is how they have to be written.
 */
import { CodeActionKind, type CodeAction } from 'vscode-languageserver';
import * as path from 'node:path';
import { isLoad } from '../generated/ast.js';
import { nodeForDiagnostic } from '../jpipe-ast-context.js';
import { isLoaded, relativeLoadPath } from '../jpipe-edits.js';
import { JpipeIssue } from '../jpipe-diagnostic-codes.js';
import { editDistance } from '../jpipe-text.js';
import { fsPathOf } from '../jpipe-utils.js';
import { quickFix, type JpipeActionContext } from './types.js';

/** Past this, a "did you mean" is guesswork. */
const MAX_NAME_DISTANCE = 3;

/** More than a handful of candidates is a list to read rather than a fix to accept. */
const MAX_SUGGESTIONS = 5;

export const fixLoadPath = quickFix<typeof JpipeIssue.LoadUnresolved>({
    id: 'fix-load-path',
    codes: [JpipeIssue.LoadUnresolved],

    create(context, diagnostic, data): CodeAction[] {
        let node = nodeForDiagnostic(context.document, diagnostic);
        while (node && !isLoad(node)) node = node.$container;
        if (!node?.$cstNode || node.path !== data.path) return [];

        const currentPath = fsPathOf(context.document.uri);
        const wanted = path.basename(data.path);

        const candidates = workspaceModelPaths(context)
            .filter(candidate => candidate !== currentPath)
            .map(candidate => ({
                candidate,
                distance: editDistance(wanted.toLowerCase(), path.basename(candidate).toLowerCase())
            }))
            .filter(({ distance }) => distance <= MAX_NAME_DISTANCE)
            .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
            .map(({ candidate }) => relativeLoadPath(currentPath, candidate))
            // A path the file already loads would swap a broken load for a duplicate one.
            .filter(relative => !isLoaded(context.unit, relative))
            .slice(0, MAX_SUGGESTIONS);

        // The STRING token, quotes included, so the replacement keeps its own.
        const pathRange = pathRangeOf(context, node.$cstNode.offset, data.path);
        if (!pathRange) return [];

        return candidates.map((relative, index) => ({
            title: `Change to '${relative}'`,
            kind: CodeActionKind.QuickFix,
            isPreferred: index === 0 && candidates.length === 1,
            edit: {
                changes: {
                    [context.document.uri.toString()]: [{ range: pathRange, newText: relative }]
                }
            }
        }));
    }
});

/** Every `.jd` file the workspace index has seen. */
function workspaceModelPaths(context: JpipeActionContext): string[] {
    const documents = context.services.shared.workspace.LangiumDocuments.all.toArray();
    return documents.map(document => fsPathOf(document.uri));
}

/** The range covering the path text inside the load's quotes. */
function pathRangeOf(context: JpipeActionContext, from: number, value: string) {
    const offset = context.document.textDocument.getText().indexOf(value, from);
    if (offset < 0) return undefined;
    return {
        start: context.document.textDocument.positionAt(offset),
        end: context.document.textDocument.positionAt(offset + value.length)
    };
}
