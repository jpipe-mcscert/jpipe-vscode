import { describe, expect, test } from 'vitest';
import { applyCodeAction, CURSOR } from './code-action-helper.js';
const JUMBLED = `justification ${CURSOR}J {
    evidence e2 is "Second ground"
    strategy s1 is "First strategy"
    conclusion c is "The claim"
    evidence e1 is "First ground"
    strategy s2 is "Second strategy"
    sub-conclusion mid is "An intermediate claim"
    e1 supports s1
    s1 supports mid
    mid supports s2
    e2 supports s2
    s2 supports c
}`;
describe('probe', () => {
    test('layout', async () => {
        console.log('\n' + await applyCodeAction(JUMBLED, { title: 'Sort elements' }));
    expect(true).toBe(true);
    });
});
