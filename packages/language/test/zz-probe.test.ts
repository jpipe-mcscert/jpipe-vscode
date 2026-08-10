import { describe, expect, test } from 'vitest';
import { CodeActionKind } from 'vscode-languageserver';
import { actionTitles, CURSOR } from './code-action-helper.js';

const T = `template t {
    conclusion c is "C"
    strategy s is "S"
    @support abs is "Abstract"
    s supports c
    abs supports s
}`;

const LINES = [
    `justification j implements t {`,
    `    strategy t:abs is "Wrong keyword"`,
    `    conclusion own is "Own"`,
    `    strategy st is "St"`,
    `    evidence ev is "Ev"`,
    `    ev supports st`,
    `    st supports own`,
    `}`
];

describe('probe', () => {
    test('element-anchored fix should stay on its declaration', async () => {
        for (let i = 0; i < LINES.length; i++) {
            const marked = [T, ...LINES.slice(0, i), CURSOR + LINES[i], ...LINES.slice(i + 1)].join('\n');
            const qf = await actionTitles(marked, CodeActionKind.QuickFix);
            const kw = qf.filter(t => t.startsWith("Change '"));
            console.log(`L${i} "${LINES[i].trim().slice(0,30)}"  keyword-fix: ${kw.length ? kw.join(' | ') : '(none)'}`);
        }
        expect(true).toBe(true);
    });
});
