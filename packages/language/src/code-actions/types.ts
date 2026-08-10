/**
 * What a code action is, in this language server.
 *
 * The shape exists to keep actions apart. A module in this directory may import from `../jpipe-*`
 * and from this file, and from **nothing else in this directory** — no action imports another.
 * Shared behaviour moves up into `jpipe-edits.ts` or `jpipe-render.ts`; it never travels sideways
 * between two fixes, because that is how a change to one quietly breaks the other.
 *
 * Three consequences of that, worth stating because they constrain what an action may do:
 *
 * - An action returns `CodeAction[]` and never a `Command`. Everything is a `WorkspaceEdit`,
 *   nothing round-trips through `workspace/executeCommand`, so the whole catalogue is testable
 *   without an editor and the extension needs no command registration to make any of it work.
 * - An action builds edits and never applies them. It is a pure function of the document.
 * - An action sets neither `kind` nor `diagnostics`; the provider fills those in. A module is
 *   only ever a title and an edit.
 */
import type { LangiumDocument, MaybePromise } from 'langium';
import type { CodeAction, CodeActionParams, Diagnostic, Range } from 'vscode-languageserver';
import type { Unit } from '../generated/ast.js';
import type { JpipeIssueCode, JpipeIssueData } from '../jpipe-diagnostic-codes.js';
import type { JpipeServices } from '../jpipe-module.js';

/**
 * Everything an action is given. Built once per request and shared, so no module re-derives the
 * document or re-parses the AST for itself.
 */
export interface JpipeActionContext {
    readonly services: JpipeServices;
    readonly document: LangiumDocument<Unit>;
    readonly unit: Unit;
    readonly params: CodeActionParams;
    /** The cursor position or the selection the request was made at. */
    readonly range: Range;
    /** `range` as offsets, since most actions want them. */
    readonly offsets: { readonly start: number; readonly end: number };
}

/**
 * A fix for a reported problem.
 *
 * `create` is called once per diagnostic carrying one of `codes`. It should return `[]` — not a
 * best guess — whenever the document no longer matches what the diagnostic describes: the
 * diagnostic comes back from the client as the client last saw it, which may be several
 * keystrokes stale.
 */
export interface QuickFixDefinition<C extends JpipeIssueCode = JpipeIssueCode> {
    /** Names this module in logs when it throws. */
    readonly id: string;
    /** The diagnostics this module answers. */
    readonly codes: readonly C[];
    create(
        context: JpipeActionContext,
        diagnostic: Diagnostic,
        data: JpipeIssueData<C>
    ): MaybePromise<CodeAction[]>;
}

/**
 * An action offered for where the cursor is rather than for a problem.
 *
 * `create` is called once per request, and should return `[]` when the cursor is somewhere the
 * action does not apply — or when applying it would change nothing, so that a no-op never appears
 * in the menu.
 */
export interface RefactoringDefinition {
    readonly id: string;
    /** Advertised kind, e.g. `CodeActionKind.RefactorRewrite` or `'source.organizeImports'`. */
    readonly actionKind: string;
    create(context: JpipeActionContext): MaybePromise<CodeAction[]>;
}

/** A quick fix with its payload type erased, as the registry holds it. */
export type RegisteredQuickFix = QuickFixDefinition<JpipeIssueCode>;

/**
 * Declares a quick fix.
 *
 * Exists so a module can be written against its own payload type — `data` typed as exactly the
 * facts its code carries — while the registry still holds a uniform list.
 */
export function quickFix<C extends JpipeIssueCode>(definition: QuickFixDefinition<C>): RegisteredQuickFix {
    return definition as unknown as RegisteredQuickFix;
}

/** Declares a refactoring. Present for symmetry with `quickFix`, and to fix the type at the
 *  definition site rather than at the registry. */
export function refactoring(definition: RefactoringDefinition): RefactoringDefinition {
    return definition;
}
