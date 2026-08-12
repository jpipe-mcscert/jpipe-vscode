/**
 * "Organize loads" — sorting and de-duplicating the import block.
 *
 * Deliberately **not** registered as `source.organizeImports`, despite being that action for this
 * language. Plenty of people carry `"editor.codeActionsOnSave": { "source.organizeImports":
 * "explicit" }` globally for TypeScript, and VS Code matches action kinds by prefix — so taking
 * the well-known name would silently rewrite the top of every `.jd` file they save, having never
 * asked for it here. Reordering someone's source is a decision they should make, not one that
 * happens behind them.
 *
 * Under its own name it still appears in Source Action…, and anyone who genuinely wants it on
 * save can still say so; they just have to mean it.
 *
 * Two restraints besides:
 *
 * It never removes a load whose path does not resolve. A load being broken is exactly the state a
 * file is in halfway through typing one, and an action that silently deletes what the author is
 * still writing is worse than one that leaves a mess. Only exact duplicates go.
 *
 * It refuses outright when a comment sits inside the block. A comment above a load is about that
 * load, and reordering would leave it pointing at whatever moved into its place — with nothing
 * on screen to say so.
 */
import type { CodeAction } from 'vscode-languageserver';
import type { Load } from '../generated/ast.js';
import { normalizeLoadPath } from '../jpipe-edits.js';
import { refactoring, type JpipeActionContext } from './types.js';

/**
 * This action's kind. Outside the `source.organizeImports` subtree on purpose — see above.
 */
export const ORGANIZE_LOADS_KIND = 'source.jpipe.organizeLoads';

export const organizeLoads = refactoring({
    id: 'organize-loads',
    actionKind: ORGANIZE_LOADS_KIND,

    create(context): CodeAction[] {
        const loads = context.unit.imports;
        if (loads.length < 1) return [];
        if (!loads.every(load => load.$cstNode)) return [];

        const first = loads[0].$cstNode!.range.start;
        const last = loads.at(-1)!.$cstNode!.range.end;

        // Only a contiguous block is safe to rewrite wholesale.
        if (!isContiguousBlock(context, loads)) return [];

        const organized = organize(loads);
        const rendered = organized.map(render).join('\n');
        const current = context.document.textDocument.getText({ start: first, end: last });
        if (rendered === current) return [];

        return [{
            title: 'Organize loads',
            kind: ORGANIZE_LOADS_KIND,
            edit: {
                changes: {
                    [context.document.uri.toString()]: [
                        { range: { start: first, end: last }, newText: rendered }
                    ]
                }
            }
        }];
    }
});

/**
 * Whether the loads sit together with nothing but whitespace between them.
 *
 * Anything else — a comment, a declaration wedged between two loads — means the block has
 * structure this action would destroy, so it declines.
 */
function isContiguousBlock(context: JpipeActionContext, loads: readonly Load[]): boolean {
    for (let i = 1; i < loads.length; i++) {
        const between = context.document.textDocument.getText({
            start: loads[i - 1].$cstNode!.range.end,
            end: loads[i].$cstNode!.range.start
        });
        if (between.trim() !== '') return false;
    }
    return true;
}

/**
 * Sorts and de-duplicates, keeping local paths above the ones that climb out of the directory.
 *
 * Two loads of the same path with different namespaces are both kept: they are two different
 * bindings, not a repetition.
 */
function organize(loads: readonly Load[]): Load[] {
    const seen = new Set<string>();
    const unique = loads.filter(load => {
        const key = `${normalizeLoadPath(load.path)}\u0000${load.namespace ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return [...unique].sort((a, b) => {
        const upA = a.path.startsWith('../') ? 1 : 0;
        const upB = b.path.startsWith('../') ? 1 : 0;
        if (upA !== upB) return upA - upB;
        const byPath = normalizeLoadPath(a.path).localeCompare(normalizeLoadPath(b.path));
        return byPath !== 0 ? byPath : (a.namespace ?? '').localeCompare(b.namespace ?? '');
    });
}

/**
 * A load written as the author wrote it, reordered but not rewritten.
 *
 * The path text is left alone deliberately. `load "base.jd"` and `load "./base.jd"` mean the same
 * thing to the compiler, and rewriting one into the other would make this action offer itself on
 * nearly every existing file — including every model in the compiler's own example set, none of
 * which has anything wrong with it. Sorting and de-duplicating are what the action is for.
 */
function render(load: Load): string {
    const alias = load.namespace ? ` as ${load.namespace}` : '';
    return `load "${load.path}"${alias}`;
}
