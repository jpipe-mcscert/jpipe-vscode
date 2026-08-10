import { describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { Diagnostic } from 'vscode-languageserver-types';
import { createJpipeServices, type Unit } from 'jpipe-language';
const services = createJpipeServices(EmptyFileSystem);
const parse = (i: string) => parseHelper<Unit>(services.Jpipe)(i, { validation: true });
const CASES: Array<[string, string]> = [
  ['evidence, nothing after', 'justification J {\n    evidence\n    conclusion c is "C"\n    strategy s is "S"\n    s supports c\n}'],
  ['evidence with a name, no is', 'justification J {\n    evidence e\n    conclusion c is "C"\n}'],
  ['evidence at the end', 'justification J {\n    conclusion c is "C"\n    evidence\n}'],
  ['empty model', 'justification J {\n}'],
  ['empty config block', 'justification A { conclusion c is "C" }\njustification B is assemble(A) {}'],
];
describe('probe', () => {
    test.each(CASES)('%s', async (label, src) => {
        const doc = await parse(src);
        const lines = src.split('\n');
        console.log(`\n--- ${label} ---`);
        for (const d of (doc.diagnostics ?? []).filter(x => x.severity === 1)) {
            const l = d.range.start.line;
            console.log(`  L${l + 1}:${d.range.start.character} on "${lines[l]}"`);
            console.log(`    ${Diagnostic.getMessageString(d).replace(/\n/g, ' ')}`);
        }
        expect(true).toBe(true);
    });
});
