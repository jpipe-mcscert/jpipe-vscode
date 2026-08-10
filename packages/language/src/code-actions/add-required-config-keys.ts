/**
 * "Add required key 'hook'" — supplying a config key the operator cannot run without.
 *
 * The awkward case is a composition with no config block at all. `RuleConfig` is
 * `'{' entries+=KeyValDecl+ '}'`, so an empty `{}` is a *syntax error*: the block and its first
 * entry have to be written by one edit, or the fix leaves behind a file that does not parse.
 */
import { CodeActionKind, type CodeAction, type Range, type TextEdit } from 'vscode-languageserver';
import { isComposition, type Composition } from '../generated/ast.js';
import { nodeForDiagnostic } from '../jpipe-ast-context.js';
import { indentationOf, insertLinesEdit } from '../jpipe-edits.js';
import { JpipeIssue } from '../jpipe-diagnostic-codes.js';
import { requiredConfigKeys } from '../jpipe-operators.js';
import { quickFix, type JpipeActionContext } from './types.js';

export const addRequiredConfigKeys = quickFix<typeof JpipeIssue.MissingConfigKey>({
    id: 'add-required-config-keys',
    codes: [JpipeIssue.MissingConfigKey],

    create(context, diagnostic, data): CodeAction[] {
        let node = nodeForDiagnostic(context.document, diagnostic);
        while (node && !isComposition(node)) node = node.$container;
        if (!node?.$cstNode) return [];

        const composition = node;
        const present = new Set(composition.config?.entries.map(entry => entry.key) ?? []);
        const missing = requiredConfigKeys(composition.operator).filter(key => !present.has(key));
        if (!missing.includes(data.missingKey)) return [];

        const uri = context.document.uri.toString();
        const actions: CodeAction[] = [{
            title: `Add required key '${data.missingKey}'`,
            kind: CodeActionKind.QuickFix,
            isPreferred: missing.length === 1,
            edit: { changes: { [uri]: [writeKeys(context, composition, [data.missingKey])] } }
        }];

        if (missing.length > 1) {
            actions.push({
                title: `Add all ${missing.length} required keys`,
                kind: CodeActionKind.QuickFix,
                isPreferred: true,
                edit: { changes: { [uri]: [writeKeys(context, composition, missing)] } }
            });
        }

        return actions;
    }
});

/** An edit adding the given keys, creating the config block if the composition has none. */
function writeKeys(
    context: JpipeActionContext,
    composition: Composition,
    keys: readonly string[]
): TextEdit {
    const existing = composition.config;

    if (existing?.$cstNode) {
        const lastEntry = existing.entries.at(-1)?.$cstNode;
        const closingLine = existing.$cstNode.range.end.line;

        // A block already spread over lines takes another line; a one-liner stays a one-liner.
        if (lastEntry && lastEntry.range.end.line < closingLine) {
            const line = lastEntry.range.end.line;
            return insertLinesEdit(line + 1, keys.map(renderEntry), indentationOf(context.document, line));
        }
        const insertAt = lastEntry ? lastEntry.range.end : shiftLeft(existing.$cstNode.range.end);
        return { range: { start: insertAt, end: insertAt }, newText: ` ${keys.map(renderEntry).join(' ')}` };
    }

    // No block at all: write it and its entries together, since `{}` would not parse. Laid out
    // over several lines, which is how every config block in the language's own examples is
    // written — a one-liner would be legal but would not look like the rest of the file.
    const end = composition.$cstNode!.range.end;
    const indent = indentationOf(context.document, end.line);
    const body = keys.map(key => `\n${indent}    ${renderEntry(key)}`).join('');
    return { range: { start: end, end }, newText: ` {${body}\n${indent}}` };
}

function renderEntry(key: string): string {
    return `${key}: ""`;
}

/** The position one character left, for inserting before a closing brace. */
function shiftLeft(position: Range['end']): Range['end'] {
    return { line: position.line, character: Math.max(0, position.character - 1) };
}
