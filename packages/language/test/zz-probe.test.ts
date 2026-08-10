import { describe, expect, test } from 'vitest';
import { applyCodeAction, parseValidated } from './code-action-helper.js';
const CASES: Array<[string, string, string]> = [
  ['normal', 'justification J {\n    conclusion c is "C"\n    strategy s is "S"\n    s supports c\n}', "Add some evidence supporting 's'"],
  ['relation with brace', 'justification J {\n    conclusion c is "C"\n    strategy s is "S"\n    s supports c }', "Add some evidence supporting 's'"],
  ['one line', 'justification J { conclusion c is "C" strategy s is "S" s supports c }', "Add some evidence supporting 's'"],
  ['no relations', 'justification J {\n    conclusion c is "C"\n}', "Add a strategy supporting 'c'"],
];
describe('probe', () => {
  test.each(CASES)('%s', async (label, src, title) => {
    const after = await applyCodeAction(src, { title });
    const re = await parseValidated(after);
    console.log(`\n--- ${label} — parse errors: ${re.parseResult.parserErrors.length} ---\n${after}`);
    expect(true).toBe(true);
  });
});
