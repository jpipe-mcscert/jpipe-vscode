/**
 * What the server tells the client it can do.
 *
 * Langium advertises code actions as a bare `codeActionProvider: true`, which says there are
 * actions without saying what sort. The lightbulb copes — it asks about everything anyway — but
 * the menus built around one kind do not: `Source Action…` exists to list `source.*` actions, and
 * a provider that never claims to have any is easy to leave out of that list.
 *
 * The kinds are derived from the registry, so the case that matters is the one asserting they
 * stay in step with it: an action registered under a new kind must be advertised by having been
 * registered, not by someone remembering to update a list.
 */
import { describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { CodeActionKind } from 'vscode-languageserver';
import {
    CONVERT_MODEL_KIND,
    EXTRACT_TEMPLATE_KIND,
    JPIPE_REFACTORINGS,
    ORGANIZE_LOADS_KIND,
    SORT_ELEMENTS_KIND,
    createJpipeServices,
    providedCodeActionKinds
} from 'jpipe-language';

/** The capabilities the server would return from `initialize`. */
async function capabilities() {
    const services = createJpipeServices(EmptyFileSystem);
    const result = await services.shared.lsp.LanguageServer.initialize({
        processId: null,
        rootUri: null,
        capabilities: {},
        workspaceFolders: null
    });
    return result.capabilities;
}

describe('the code action capability', () => {

    test('arrives with its kinds rather than as a bare boolean', async () => {
        const provider = (await capabilities()).codeActionProvider;
        expect(typeof provider).toBe('object');
        expect((provider as { codeActionKinds?: string[] }).codeActionKinds).toBeDefined();
    });

    test('claims quick fixes, since the registry has them', async () => {
        expect(providedCodeActionKinds()).toContain(CodeActionKind.QuickFix);
    });

    // The one `Source Action…` needs to see.
    test('claims the organize-loads source kind', async () => {
        expect(providedCodeActionKinds()).toContain(ORGANIZE_LOADS_KIND);
    });

    // Kinds match by prefix, and a great many people carry a global
    // `source.organizeImports` on-save setting for other languages. Taking that name would let it
    // rewrite the top of every `.jd` file they save without their ever asking for it here.
    test('claims nothing inside the well-known organize-imports subtree', async () => {
        for (const kind of providedCodeActionKinds()) {
            expect(kind === 'source.organizeImports' || kind.startsWith('source.organizeImports.'),
                `'${kind}' would be swept up by a global organize-imports-on-save setting`).toBe(false);
        }
    });

    test('claims every kind the registered refactorings use', async () => {
        const advertised = providedCodeActionKinds();
        for (const refactoring of JPIPE_REFACTORINGS) {
            expect(advertised, `'${refactoring.id}' provides an unadvertised kind`)
                .toContain(refactoring.actionKind);
        }
    });

    // Each refactoring has its own sub-kind so a command can ask for exactly one of them. That
    // only works while they stay *inside* the generic kinds, which is what keeps them in the
    // lightbulb and under Refactor…
    test.each([
        [CONVERT_MODEL_KIND, CodeActionKind.RefactorRewrite],
        [SORT_ELEMENTS_KIND, CodeActionKind.RefactorRewrite],
        [EXTRACT_TEMPLATE_KIND, CodeActionKind.Refactor]
    ])('%s still answers to %s', (kind, generic) => {
        expect(kind === generic || kind.startsWith(`${generic}.`)).toBe(true);
    });

    test('each refactoring has a kind of its own', () => {
        const kinds = JPIPE_REFACTORINGS.map(r => r.actionKind);
        expect(new Set(kinds).size, 'two refactorings share a kind, so a command cannot target one')
            .toBe(kinds.length);
    });

    test('claims nothing it cannot produce', async () => {
        const producible = new Set<string>([
            CodeActionKind.QuickFix,
            ...JPIPE_REFACTORINGS.map(r => r.actionKind)
        ]);
        for (const kind of providedCodeActionKinds()) {
            expect(producible, `advertises '${kind}' but nothing produces it`).toContain(kind);
        }
    });

    // Everything else the server advertises should be untouched by the override.
    test('leaves the other capabilities alone', async () => {
        const caps = await capabilities();
        expect(caps.documentSymbolProvider).toBe(true);
        expect(caps.definitionProvider).toBe(true);
        expect(caps.hoverProvider).toBe(true);
        expect(caps.completionProvider).toBeDefined();
        expect(caps.renameProvider).toBeDefined();
    });
});
