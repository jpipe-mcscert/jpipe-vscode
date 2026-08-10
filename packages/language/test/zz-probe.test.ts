import { describe, expect, test } from 'vitest';
import { CodeActionKind } from 'vscode-languageserver';
import { CONVERT_MODEL_KIND, EXTRACT_TEMPLATE_KIND, SORT_ELEMENTS_KIND, providedCodeActionKinds } from 'jpipe-language';
import { actionTitles, CURSOR } from './code-action-helper.js';
const SRC = `justification ${CURSOR}J {
    conclusion c is "C"
    strategy s is "S"
    evidence e is "E"
    e supports s
    s supports c
}`;
describe('probe', () => {
    test('channels and per-action kinds', async () => {
        console.log('advertised:', JSON.stringify(providedCodeActionKinds()));
        for (const [label, only] of [
            ['lightbulb (no filter)', undefined],
            ['Refactor…', CodeActionKind.Refactor],
            ['refactor.rewrite', CodeActionKind.RefactorRewrite],
            ['command: convert', CONVERT_MODEL_KIND],
            ['command: sort', SORT_ELEMENTS_KIND],
            ['command: extract', EXTRACT_TEMPLATE_KIND],
        ] as const) {
            console.log(`${label}: ${(await actionTitles(SRC, only)).join(' | ') || '(none)'}`);
        }
        expect(true).toBe(true);
    });
});
