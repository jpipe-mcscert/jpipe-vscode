/**
 * A diagnostic without a code is invisible to the quick fixes: dispatch reads `data.code`, so a
 * check that forgets one produces a problem nothing can offer to repair, and nothing fails to say
 * so. That is the failure this file is here to catch — the last case walks a corpus that trips
 * every rule and insists each diagnostic it finds is one the codes account for.
 *
 * The payload cases assert the facts a fix will rely on, because a payload is only worth carrying
 * if it is right: `expectedKey` is the id an override must literally be given, `allMissing` is
 * every gap and not just this one, and `hasConfigBlock` decides whether a fix writes a `{ … }` or
 * writes inside one.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument } from 'langium';
import { parseHelper } from 'langium/test';
import { Diagnostic } from 'vscode-languageserver-types';
import type { Unit } from 'jpipe-language';
import {
    JpipeIssue,
    createJpipeServices,
    isJpipeIssueCode,
    issueCodeOf,
    type JpipeIssueCode,
    type JpipeIssueData
} from 'jpipe-language';

let parse: (input: string) => Promise<LangiumDocument<Unit>>;

beforeAll(async () => {
    const services = createJpipeServices(EmptyFileSystem);
    const doParse = parseHelper<Unit>(services.Jpipe);
    parse = (input: string) => doParse(input, { validation: true });
});

/** The diagnostic carrying `code`, failing with what was actually reported if there is none. */
async function diagnosticFor<C extends JpipeIssueCode>(source: string, code: C): Promise<Diagnostic> {
    const document = await parse(source);
    const all = document.diagnostics ?? [];
    const match = all.find(d => issueCodeOf(d) === code);
    if (!match) {
        expect.fail(`no diagnostic with code '${code}'; got: ${all.map(d => issueCodeOf(d) ?? '(none)').join(', ') || '(nothing)'}`);
    }
    return match;
}

/** The typed payload of a diagnostic known to carry `code`. */
async function payloadFor<C extends JpipeIssueCode>(source: string, code: C): Promise<JpipeIssueData<C>> {
    return (await diagnosticFor(source, code)).data as JpipeIssueData<C>;
}

const TEMPLATE = 'template T { @support a is "A" @support b is "B" conclusion c is "C" strategy s is "S"\n a supports s\n b supports s\n s supports c }';

describe('diagnostic codes', () => {

    test('the visible code and the routing code agree', async () => {
        const diagnostic = await diagnosticFor('justification J { conclusion c is "" }', JpipeIssue.EmptyLabel);
        expect(diagnostic.code).toBe(JpipeIssue.EmptyLabel);
        expect((diagnostic.data as { code: string }).code).toBe(JpipeIssue.EmptyLabel);
    });

    test.each([
        [JpipeIssue.EmptyLabel, 'justification J { conclusion c is "" }'],
        [JpipeIssue.EmptyUnit, 'load "nowhere.jd"'],
        [JpipeIssue.DuplicateModelName, 'justification J { conclusion c is "C" }\njustification J { conclusion c is "C" }'],
        [JpipeIssue.TemplateWithoutSupport, 'template T { conclusion c is "C" }'],
        [JpipeIssue.UnknownOperator, 'justification A { conclusion c is "C" }\njustification B is nope(A)'],
        [JpipeIssue.UnknownConfigKey, 'justification A { conclusion c is "C" }\njustification B is assemble(A) { conclusionLabel: "C" strategyLabel: "S" nope: "X" }'],
        [JpipeIssue.MissingConfigKey, 'justification A { conclusion c is "C" }\njustification B is assemble(A) { conclusionLabel: "C" }'],
        [JpipeIssue.StrategyUnsupported, 'justification J { conclusion c is "C" strategy s is "S"\n s supports c }'],
        [JpipeIssue.ConclusionUnsupported, 'justification J { conclusion c is "C" }'],
        [JpipeIssue.LoadUnresolved, 'load "nowhere.jd"\njustification J { conclusion c is "C" }'],
        [JpipeIssue.MissingSupportOverride, `${TEMPLATE}\njustification J implements T { conclusion x is "X" strategy y is "Y"\n y supports x }`],
        [JpipeIssue.BadSupportOverrideType, `${TEMPLATE}\njustification J implements T { strategy T:a is "A" evidence T:b is "B" }`]
    ])('%s is reported with its code', async (code, source) => {
        await expect(diagnosticFor(source, code)).resolves.toBeDefined();
    });

    // Nothing else in the suite would notice a rule added without a code.
    test('every diagnostic a mixed corpus produces carries a known code', async () => {
        const corpus = [
            'justification J { conclusion c is "" }',
            'template T { conclusion c is "C" }',
            'load "nowhere.jd"\njustification J { conclusion c is "C" }',
            'justification A { conclusion c is "C" }\njustification B is nope(A)',
            'justification A { conclusion c is "C" }\njustification B is assemble(A) { conclusionLabel: "C" wrong: "X" }',
            'justification J { conclusion c is "C" strategy s is "S"\n s supports c }',
            `${TEMPLATE}\njustification J implements T { conclusion x is "X" strategy y is "Y"\n y supports x }`,
            `${TEMPLATE}\njustification J implements T { strategy T:a is "A" evidence T:b is "B" }`,
            'justification J { conclusion c is "C" }\njustification J { conclusion c is "C" }'
        ];
        const uncoded: string[] = [];
        for (const source of corpus) {
            const document = await parse(source);
            // Otherwise a fixture that fails to parse quietly contributes parser errors here and
            // reads as a missing code.
            expect(document.parseResult.parserErrors, `fixture does not parse: ${source}`).toHaveLength(0);
            for (const diagnostic of document.diagnostics ?? []) {
                // Langium's own linking errors are not ours to code.
                if (diagnostic.data && (diagnostic.data as { code?: string }).code === 'linking-error') continue;
                if (!isJpipeIssueCode(issueCodeOf(diagnostic))) uncoded.push(Diagnostic.getMessageString(diagnostic));
            }
        }
        expect(uncoded).toEqual([]);
    });
});

describe('payloads carry what a fix needs', () => {

    test('a missing override names the id the declaration must be given', async () => {
        const payload = await payloadFor(`${TEMPLATE}\njustification J implements T { conclusion x is "X" strategy y is "Y"\n y supports x }`, JpipeIssue.MissingSupportOverride);
        expect(payload.expectedKey).toBe('T:a');
        expect(payload.supportLabel).toBe('A');
        expect(payload.sourceTemplateId).toBe('T');
    });

    test('every missing override is listed on each of them, so one action can close them all', async () => {
        const payload = await payloadFor(`${TEMPLATE}\njustification J implements T { conclusion x is "X" strategy y is "Y"\n y supports x }`, JpipeIssue.MissingSupportOverride);
        expect(payload.allMissing.map(m => m.expectedKey)).toEqual(['T:a', 'T:b']);
    });

    test('an override that is already written is absent from the missing list', async () => {
        const payload = await payloadFor(
            `${TEMPLATE}\njustification J implements T { evidence T:a is "A" }`,
            JpipeIssue.MissingSupportOverride
        );
        expect(payload.allMissing.map(m => m.expectedKey)).toEqual(['T:b']);
    });

    test('a wrongly typed override reports the keyword written and the ones allowed', async () => {
        const payload = await payloadFor(
            `${TEMPLATE}\njustification J implements T { strategy T:a is "A" evidence T:b is "B" }`,
            JpipeIssue.BadSupportOverrideType
        );
        expect(payload.actualKeyword).toBe('strategy');
        expect(payload.allowedKeywords).toEqual(['evidence', 'sub-conclusion']);
    });

    test('an unknown operator reports the alternatives', async () => {
        const payload = await payloadFor(
            'justification A { conclusion c is "C" }\njustification B is nope(A)',
            JpipeIssue.UnknownOperator
        );
        expect(payload.actual).toBe('nope');
        expect(payload.known).toEqual(['assemble', 'refine']);
    });

    // The grammar forbids an empty `{}`, so a fix must know whether it is adding an entry to a
    // block or writing the block itself.
    test('a missing config key records whether a config block exists', async () => {
        const withBlock = await payloadFor(
            'justification A { conclusion c is "C" }\njustification B is assemble(A) { conclusionLabel: "C" }',
            JpipeIssue.MissingConfigKey
        );
        expect(withBlock.hasConfigBlock).toBe(true);
        expect(withBlock.allMissing).toEqual(['strategyLabel']);

        const withoutBlock = await payloadFor(
            'justification A { conclusion c is "C" }\njustification B is assemble(A)',
            JpipeIssue.MissingConfigKey
        );
        expect(withoutBlock.hasConfigBlock).toBe(false);
        expect(withoutBlock.allMissing).toEqual(['conclusionLabel', 'strategyLabel']);
    });

    test('an unknown config key reports what was allowed instead', async () => {
        const payload = await payloadFor(
            'justification A { conclusion c is "C" }\njustification B is assemble(A) { conclusionLabel: "C" strategyLabel: "S" nope: "X" }',
            JpipeIssue.UnknownConfigKey
        );
        expect(payload.actual).toBe('nope');
        expect(payload.allowed).toContain('conclusionLabel');
        expect(payload.allowed).toContain('unifyBy');
    });

    // The payload rides in a diagnostic's `data`, out to the client and back.
    test('payloads survive a JSON round trip unchanged', async () => {
        const payload = await payloadFor(`${TEMPLATE}\njustification J implements T { conclusion x is "X" strategy y is "Y"\n y supports x }`, JpipeIssue.MissingSupportOverride);
        expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    });
});
