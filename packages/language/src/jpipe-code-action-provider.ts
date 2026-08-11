/**
 * Routes a code-action request to the modules that answer it.
 *
 * Written once. Adding an action touches `code-actions/index.ts` and the action's own file, never
 * this one.
 */
import { MultiMap, type AstNode, type Cancellation, type LangiumDocument } from 'langium';
import type { CodeActionProvider } from 'langium/lsp';
import { CodeActionKind, type CodeAction, type CodeActionParams, type Command, type Diagnostic, type Range } from 'vscode-languageserver';
import {
    isComposition,
    isJustification,
    isJustificationElement,
    isKeyValDecl,
    isLoad,
    isRelation,
    isTemplate,
    isUnit,
    type Unit
} from './generated/ast.js';
import { JPIPE_QUICK_FIXES, JPIPE_REFACTORINGS } from './code-actions/index.js';
import type { JpipeActionContext, RefactoringDefinition, RegisteredQuickFix } from './code-actions/types.js';
import { nodeForDiagnostic } from './jpipe-ast-context.js';
import { issueCodeOf, type JpipeIssueCode, type JpipeIssueData } from './jpipe-diagnostic-codes.js';
import type { JpipeServerLogger } from './jpipe-logger.js';
import type { JpipeServices } from './jpipe-module.js';
import { messageOf } from './jpipe-errors.js';

/** What the provider dispatches to. Overridable so the dispatcher's own guarantees — that a
 *  throwing module is contained, that kinds are filtered — can be tested against modules written
 *  to misbehave, rather than by waiting for a real one to. */
export interface CodeActionRegistry {
    readonly quickFixes: readonly RegisteredQuickFix[];
    readonly refactorings: readonly RefactoringDefinition[];
}

export class JpipeCodeActionProvider implements CodeActionProvider {
    private readonly logger: JpipeServerLogger;
    private readonly byCode = new MultiMap<JpipeIssueCode, RegisteredQuickFix>();
    private readonly refactorings: readonly RefactoringDefinition[];

    constructor(
        private readonly services: JpipeServices,
        registry: CodeActionRegistry = { quickFixes: JPIPE_QUICK_FIXES, refactorings: JPIPE_REFACTORINGS }
    ) {
        this.logger = services.logger;
        for (const fix of registry.quickFixes) {
            for (const code of fix.codes) this.byCode.add(code, fix);
        }
        this.refactorings = registry.refactorings;
    }

    async getCodeActions(
        document: LangiumDocument,
        params: CodeActionParams,
        cancelToken?: Cancellation.CancellationToken
    ): Promise<Array<Command | CodeAction> | undefined> {
        const unit = document.parseResult.value;
        if (!isUnit(unit)) return undefined;

        const textDocument = document.textDocument;
        const context: JpipeActionContext = {
            services: this.services,
            document: document as LangiumDocument<Unit>,
            unit,
            params,
            range: params.range,
            offsets: {
                start: textDocument.offsetAt(params.range.start),
                end: textDocument.offsetAt(params.range.end)
            }
        };

        const actions: CodeAction[] = [];

        const quickFixesWanted = isRequested(CodeActionKind.QuickFix, params.context.only);

        for (const diagnostic of quickFixesWanted ? diagnosticsInScope(document, params) : []) {
            if (cancelToken?.isCancellationRequested) return actions;
            const code = issueCodeOf(diagnostic);
            if (!code) continue;
            for (const fix of this.byCode.get(code)) {
                const produced = await this.safely(fix.id, () =>
                    fix.create(context, diagnostic, diagnostic.data as JpipeIssueData));
                actions.push(...produced.map(action => finalize(action, CodeActionKind.QuickFix, diagnostic)));
            }
        }

        for (const module of this.refactorings) {
            if (cancelToken?.isCancellationRequested) return actions;
            if (!isRequested(module.actionKind, params.context.only)) continue;
            const produced = await this.safely(module.id, () => module.create(context));
            actions.push(...produced.map(action => finalize(action, module.actionKind)));
        }

        return deduplicate(actions);
    }

    /**
     * Runs one module, absorbing anything it throws.
     *
     * The point of keeping actions in separate modules is that they fail separately: a fix that
     * trips over an edge case must not blank the lightbulb for everything else in the file.
     */
    private async safely(id: string, run: () => unknown): Promise<CodeAction[]> {
        try {
            return (await run()) as CodeAction[] ?? [];
        } catch (error) {
            this.logger.error(`code action '${id}' failed: ${messageOf(error)}`);
            return [];
        }
    }
}

/**
 * The diagnostics a request should be answered for: those the client sent, plus any whose
 * *subject* the request is inside.
 *
 * A client sends only the diagnostics overlapping the caret, and this language anchors its
 * diagnostics on an identifier — `Justification 'j' must override …` squiggles the single
 * character `j`. Relying on the client's set alone put the lightbulb on one character.
 *
 * The reach is the extent of the thing the diagnostic is *about*, not a fixed number of lines. A
 * missing override is a fact about a whole justification, so it is offered anywhere inside it —
 * which is also where `Convert to template` is offered, and having the two disagree was the
 * confusing part. An override declared with the wrong keyword is a fact about one declaration, so
 * it stays on that declaration and does not follow you around the model.
 */
function diagnosticsInScope(document: LangiumDocument, params: CodeActionParams): Diagnostic[] {
    const fromClient = params.context.diagnostics;
    const seen = new Set(fromClient.map(identity));

    const reachable = (document.diagnostics ?? []).filter(diagnostic => {
        if (seen.has(identity(diagnostic))) return false;
        const scope = subjectRange(document, diagnostic) ?? lineRangeOf(diagnostic);
        return scope.start.line <= params.range.end.line
            && params.range.start.line <= scope.end.line;
    });

    return [...fromClient, ...reachable];
}

/** Node kinds a diagnostic is understood to be *about*; the innermost one wins. */
function isSubject(node: AstNode): boolean {
    return isJustification(node) || isTemplate(node)
        || isJustificationElement(node)
        || isRelation(node) || isLoad(node)
        || isComposition(node) || isKeyValDecl(node);
}

/** The extent of the declaration a diagnostic concerns, found by walking out from its anchor. */
function subjectRange(document: LangiumDocument, diagnostic: Diagnostic): Range | undefined {
    let node = nodeForDiagnostic(document, diagnostic);
    while (node && !isSubject(node)) node = node.$container;
    return node?.$cstNode?.range;
}

/** Fallback reach when the anchor no longer resolves: the lines the diagnostic itself covers. */
function lineRangeOf(diagnostic: Diagnostic): Range {
    return diagnostic.range;
}

/** Identifies a diagnostic across the two sources, which hold different objects for the same one. */
function identity(diagnostic: Diagnostic): string {
    const { start, end } = diagnostic.range;
    return `${diagnostic.code ?? ''}|${start.line}:${start.character}|${end.line}:${end.character}|${typeof diagnostic.message === 'string' ? diagnostic.message : ''}`;
}

/** Fills in what the provider owns, so a module is only ever a title and an edit. */
function finalize(action: CodeAction, kind: string, diagnostic?: Diagnostic): CodeAction {
    return {
        ...action,
        kind: action.kind ?? kind,
        // Links the action to the squiggle, so the editor shows it against the right problem.
        ...(diagnostic && !action.diagnostics ? { diagnostics: [diagnostic] } : {})
    };
}

/**
 * Whether the client asked for this kind.
 *
 * LSP kinds are hierarchical and matched by prefix, so a request for `refactor` includes
 * `refactor.rewrite`. No filter means everything.
 */
function isRequested(actionKind: string, only: readonly string[] | undefined): boolean {
    if (!only || only.length === 0) return true;
    return only.some(requested => actionKind === requested || actionKind.startsWith(`${requested}.`));
}

/**
 * Drops actions that would do the same thing twice.
 *
 * A rule may report the same problem once per detail — a composition missing two required keys
 * produces two diagnostics at one range — so a fix offering to repair all of them at once is
 * reached more than once. Handled here so no module has to think about it.
 */
function deduplicate(actions: readonly CodeAction[]): CodeAction[] {
    const seen = new Set<string>();
    const unique: CodeAction[] = [];
    for (const action of actions) {
        // `\u0000` written as an escape, not as the character itself: a title cannot contain
        // one, which is what makes it an unambiguous separator, but an invisible control
        // character sitting in a source file is one an editor can silently eat.
        const key = `${action.title}\u0000${JSON.stringify(action.edit ?? null)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(action);
    }
    return unique;
}
