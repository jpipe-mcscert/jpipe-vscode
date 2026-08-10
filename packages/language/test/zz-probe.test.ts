import { describe, expect, test } from 'vitest';
import { CodeActionKind } from 'vscode-languageserver';
import { actionTitles, CURSOR } from './code-action-helper.js';

const t = (n: number) => `template t {
    conclusion c is "C"
    strategy s is "S"
${Array.from({length: n}, (_, i) => `    @support abs${i+1} is "Abstract #${i+1}"`).join('\n')}
    s supports c
${Array.from({length: n}, (_, i) => `    abs${i+1} supports s`).join('\n')}
}`;

describe('probe', () => {
    test.each([1, 2, 3])('%i missing override(s)', async (n) => {
        const src = `${t(n)}\njustification ${CURSOR}j implements t {\n    conclusion own is "Own"\n    strategy st is "St"\n    evidence ev is "Ev"\n    ev supports st\n    st supports own\n}`;
        const titles = await actionTitles(src, CodeActionKind.QuickFix);
        console.log(`\n--- ${n} missing ---`);
        titles.forEach((t, i) => console.log(`  ${i}. ${t}`));
        expect(true).toBe(true);
    });
});
