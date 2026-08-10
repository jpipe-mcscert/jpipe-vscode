/**
 * Harness for the code actions.
 *
 * Not named `*.test.ts`, so vitest imports it without collecting it as a suite.
 *
 * Langium ships no `expectCodeAction`, so these call the provider directly — the same approach
 * `symbol-provider.test.ts` takes. Assertions are on the *resulting text*, because that is what a
 * user gets; an assertion on the edit's range and `newText` passes just as happily when the two
 * describe a mangled document.
 *
 * `expectFixResolves` is the one to reach for. Applying a fix and then re-parsing and
 * re-validating the result is what catches the two failures that matter most and that no
 * range-level assertion sees: text that does not parse, and a fix that leaves the very problem it
 * claimed to repair.
 */
import { expect } from 'vitest';
import { EmptyFileSystem, type LangiumDocument } from 'langium';
import { parseHelper } from 'langium/test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CodeAction, CodeActionParams } from 'vscode-languageserver';
import { Diagnostic } from 'vscode-languageserver-types';
import {
    JpipeCodeActionProvider,
    createJpipeServices,
    issueCodeOf,
    type CodeActionRegistry,
    type JpipeIssueCode,
    type Unit
} from 'jpipe-language';

const services = createJpipeServices(EmptyFileSystem);
const doParse = parseHelper<Unit>(services.Jpipe);

/** Parses with validation on, so the diagnostics a fix keys off are present. */
export function parseValidated(input: string): Promise<LangiumDocument<Unit>> {
    return doParse(input, { validation: true });
}

/** Marks the cursor in a fixture. Absent means "the whole document". */
export const CURSOR = '<|>';

interface Prepared {
    document: LangiumDocument<Unit>;
    params: CodeActionParams;
    text: string;
}

async function prepare(input: string, only?: string): Promise<Prepared> {
    const cursor = input.indexOf(CURSOR);
    const text = cursor >= 0 ? input.replace(CURSOR, '') : input;
    const document = await parseValidated(text);

    const range = cursor >= 0
        ? { start: document.textDocument.positionAt(cursor), end: document.textDocument.positionAt(cursor) }
        : {
            start: document.textDocument.positionAt(0),
            end: document.textDocument.positionAt(text.length)
        };

    // What the client would send: only the diagnostics overlapping the requested range. With a
    // cursor marker that is a single position, which is exactly the case that used to leave the
    // lightbulb unreachable, so the harness has to model it rather than hand over everything.
    const all = document.diagnostics ?? [];
    const overlapping = all.filter(d =>
        (d.range.start.line < range.end.line
            || (d.range.start.line === range.end.line && d.range.start.character <= range.end.character))
        && (range.start.line < d.range.end.line
            || (range.start.line === d.range.end.line && range.start.character <= d.range.end.character)));

    return {
        document,
        text,
        params: {
            textDocument: { uri: document.uri.toString() },
            range,
            context: {
                diagnostics: cursor >= 0 ? overlapping : all,
                ...(only ? { only: [only] } : {})
            }
        }
    };
}

/** Every action offered for the fixture, optionally filtered to one kind. */
export async function listCodeActions(input: string, only?: string): Promise<CodeAction[]> {
    const { document, params } = await prepare(input, only);
    const actions = await services.Jpipe.lsp.CodeActionProvider!.getCodeActions(document, params);
    return (actions ?? []).filter((action): action is CodeAction => 'title' in action);
}

/** The titles offered, in order — useful when an expectation is about the menu itself. */
export async function actionTitles(input: string, only?: string): Promise<string[]> {
    return (await listCodeActions(input, only)).map(action => action.title);
}

export interface ActionQuery {
    /** Exact title, or a pattern to match one. */
    title: string | RegExp;
    only?: string;
}

function matches(action: CodeAction, title: string | RegExp): boolean {
    return typeof title === 'string' ? action.title === title : title.test(action.title);
}

/**
 * Applies the one action matching the query and returns the resulting text.
 *
 * Fails with the titles that *were* offered when nothing matches: a broken action test should say
 * what the editor actually proposed, not merely that the expectation missed.
 */
export async function applyCodeAction(input: string, query: ActionQuery): Promise<string> {
    const { document, params, text } = await prepare(input, query.only);
    const produced = await services.Jpipe.lsp.CodeActionProvider!.getCodeActions(document, params);
    const actions = (produced ?? []).filter((action): action is CodeAction => 'title' in action);

    const found = actions.filter(action => matches(action, query.title));
    if (found.length === 0) {
        expect.fail(`no action titled ${String(query.title)}; offered: ${actions.map(a => `'${a.title}'`).join(', ') || '(none)'}`);
    }
    if (found.length > 1) {
        expect.fail(`${found.length} actions match ${String(query.title)}: ${found.map(a => `'${a.title}'`).join(', ')}`);
    }

    const edits = found[0].edit?.changes?.[document.uri.toString()];
    if (!edits) {
        expect.fail(`action '${found[0].title}' carries no edit for this document`);
    }
    return TextDocument.applyEdits(TextDocument.create(document.uri.toString(), 'jpipe', 0, text), edits);
}

/**
 * Runs a request against a hand-built registry, for the dispatcher's own guarantees.
 *
 * Modules written to misbehave are the only honest way to test containment: waiting for a real
 * action to throw means the guarantee is untested until the day it is needed.
 */
export async function listWithRegistry(input: string, registry: CodeActionRegistry, only?: string): Promise<CodeAction[]> {
    const { document, params } = await prepare(input, only);
    const provider = new JpipeCodeActionProvider(services.Jpipe, registry);
    const actions = await provider.getCodeActions(document, params);
    return (actions ?? []).filter((action): action is CodeAction => 'title' in action);
}

/**
 * Applies the action, then re-parses and re-validates the result and asserts that `code` is gone
 * and that the text still parses.
 */
export async function expectFixResolves(
    input: string,
    query: ActionQuery,
    code: JpipeIssueCode
): Promise<string> {
    const after = await applyCodeAction(input, query);
    const reparsed = await parseValidated(after);

    expect(
        reparsed.parseResult.parserErrors.map(e => e.message),
        `applying '${String(query.title)}' produced text that does not parse:\n${after}`
    ).toEqual([]);

    const remaining = (reparsed.diagnostics ?? []).filter(d => issueCodeOf(d) === code);
    expect(
        remaining.map(d => Diagnostic.getMessageString(d)),
        `applying '${String(query.title)}' left '${code}' unresolved:\n${after}`
    ).toEqual([]);

    return after;
}
