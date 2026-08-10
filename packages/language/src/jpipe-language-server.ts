/**
 * Declares which kinds of code action this server provides.
 *
 * Langium advertises the capability as a bare `codeActionProvider: true`, which says "there are
 * actions" without saying what sort. A client that cannot see the kinds has to ask the server
 * about every request and take whatever comes back — workable for the lightbulb, which asks about
 * everything anyway, but not for the menus built around a *specific* kind. `Source Action…` is the
 * one that matters here: it exists to list `source.*` actions, and a provider that never says it
 * has any is easy to leave out of that list.
 *
 * The kinds are derived from the registry rather than written out, so an action added with a new
 * kind is advertised by having been registered — not by someone remembering to come back here.
 */
import { CodeActionKind, type InitializeParams, type InitializeResult } from 'vscode-languageserver';
import { DefaultLanguageServer } from 'langium/lsp';
import { JPIPE_QUICK_FIXES, JPIPE_REFACTORINGS } from './code-actions/index.js';

/** Every action kind the registry can produce, de-duplicated and stable in order. */
export function providedCodeActionKinds(): string[] {
    const kinds = new Set<string>();
    if (JPIPE_QUICK_FIXES.length > 0) kinds.add(CodeActionKind.QuickFix);
    for (const refactoring of JPIPE_REFACTORINGS) kinds.add(refactoring.actionKind);
    return [...kinds].sort();
}

export class JpipeLanguageServer extends DefaultLanguageServer {

    protected override buildInitializeResult(params: InitializeParams): InitializeResult {
        const result = super.buildInitializeResult(params);
        // Only ever narrows a `true` into the same capability with detail attached; if a future
        // Langium stops advertising code actions at all, this leaves that decision alone.
        if (result.capabilities.codeActionProvider) {
            result.capabilities.codeActionProvider = {
                codeActionKinds: providedCodeActionKinds()
            };
        }
        return result;
    }
}
