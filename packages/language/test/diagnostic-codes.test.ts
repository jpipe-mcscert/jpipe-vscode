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
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-types';
import type { Unit } from 'jpipe-language';
import {
    CODE_PATTERN,
    COMPILER_CODES,
    EXTENSION_ONLY_CODES,
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
        const diagnostic = await diagnosticFor('justification J { conclusion c is "" }', JpipeIssue.NoEmptyLabel);
        expect(diagnostic.code).toBe(JpipeIssue.NoEmptyLabel);
        expect((diagnostic.data as { code: string }).code).toBe(JpipeIssue.NoEmptyLabel);
    });

    test.each([
        [JpipeIssue.NoEmptyLabel, 'justification J { conclusion c is "" }'],
        [JpipeIssue.NoEmptyUnit, 'load "nowhere.jd"'],
        [JpipeIssue.NoDuplicateModelNames, 'justification J { conclusion c is "C" }\njustification J { conclusion c is "C" }'],
        [JpipeIssue.HasAbstractSupport, 'template T { conclusion c is "C" }'],
        [JpipeIssue.UnknownOperator, 'justification A { conclusion c is "C" }\njustification B is nope(A)'],
        [JpipeIssue.UnknownConfigKey, 'justification A { conclusion c is "C" }\njustification B is assemble(A) { conclusionLabel: "C" strategyLabel: "S" nope: "X" }'],
        [JpipeIssue.MissingConfigKey, 'justification A { conclusion c is "C" }\njustification B is assemble(A) { conclusionLabel: "C" }'],
        [JpipeIssue.OperatorArity, 'justification A { conclusion c is "C" }\njustification B is refine(A)'],
        [JpipeIssue.UnknownUnificationMethod, 'justification A { conclusion c is "C" }\njustification B is assemble(A) { conclusionLabel: "C" strategyLabel: "S" unifyBy: "nope" }'],
        [JpipeIssue.NoDuplicateIds, 'justification J { conclusion c is "C" evidence c is "E" }'],
        [JpipeIssue.StrategySupported, 'justification J { conclusion c is "C" strategy s is "S"\n s supports c }'],
        [JpipeIssue.InvalidSupport, 'justification J { conclusion c is "C" strategy s is "S" strategy t is "T"\n t supports s\n s supports c }'],
        [JpipeIssue.ConclusionSupported, 'justification J { conclusion c is "C" }'],
        [JpipeIssue.LoadUnresolved, 'load "nowhere.jd"\njustification J { conclusion c is "C" }'],
        [JpipeIssue.NoAbstractSupport, `${TEMPLATE}\njustification J implements T { conclusion x is "X" strategy y is "Y"\n y supports x }`],
        [JpipeIssue.SupportOverrideType, `${TEMPLATE}\njustification J implements T { strategy T:a is "A" evidence T:b is "B" }`]
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

/**
 * `conclusion-supported` is one code over two checks, because it is one rule to the compiler
 * (jpipe-vscode ADR-VSC-0022). Severity is what still tells them apart, and nothing else in the
 * suite would notice if the collapse quietly lost one of the two branches.
 */
describe('one code, two severities', () => {

    test('a conclusion with no support at all is a warning', async () => {
        const diagnostic = await diagnosticFor(
            'justification J { conclusion c is "C" }',
            JpipeIssue.ConclusionSupported
        );
        expect(diagnostic.severity).toBe(DiagnosticSeverity.Warning);
    });

    test('a conclusion supported by something other than a strategy is an error', async () => {
        const diagnostic = await diagnosticFor(
            'justification J { conclusion c is "C" evidence e is "E"\n e supports c }',
            JpipeIssue.ConclusionSupported
        );
        expect(diagnostic.severity).toBe(DiagnosticSeverity.Error);
    });
});

/**
 * The codes are shared with the compiler, which lives in another repository with no shared build
 * (jpipe-vscode ADR-VSC-0022). Nothing here can tell whether the vendored `COMPILER_CODES` list is
 * current — that is what `npm run check:codes` is for. What these cases *can* do is refuse a new
 * code that has not been placed in one family or the other, which forces the question "does the
 * compiler already name this rule?" to be answered before a second name ships.
 */
describe('the vocabulary is shared with the compiler', () => {

    const codes = Object.values(JpipeIssue);

    test('every code is either the compiler\'s or declared extension-only', () => {
        const compiler = new Set<string>(COMPILER_CODES);
        const ours = new Set<string>(EXTENSION_ONLY_CODES);
        const unplaced = codes.filter(code => !compiler.has(code) && !ours.has(code));
        expect(unplaced, 'add it to COMPILER_CODES or EXTENSION_ONLY_CODES in jpipe-compiler-codes.ts').toEqual([]);
    });

    test('every extension-only code is a code we actually report', () => {
        const reported = new Set<string>(codes);
        expect(EXTENSION_ONLY_CODES.filter(code => !reported.has(code))).toEqual([]);
    });

    test('no code claims to be both the compiler\'s and ours', () => {
        const compiler = new Set<string>(COMPILER_CODES);
        expect(EXTENSION_ONLY_CODES.filter(code => compiler.has(code))).toEqual([]);
    });

    // The compiler's report schema constrains `code` to exactly this, and would have rejected the
    // `jpipe.`-prefixed names used before ADR-VSC-0022 — a dot is not in the class.
    test('every code has the shape the compiler\'s report schema allows', () => {
        expect(codes.filter(code => !CODE_PATTERN.test(code))).toEqual([]);
    });
});

describe('payloads carry what a fix needs', () => {

    test('a missing override names the id the declaration must be given', async () => {
        const payload = await payloadFor(`${TEMPLATE}\njustification J implements T { conclusion x is "X" strategy y is "Y"\n y supports x }`, JpipeIssue.NoAbstractSupport);
        expect(payload.expectedKey).toBe('T:a');
        expect(payload.supportLabel).toBe('A');
        expect(payload.sourceTemplateId).toBe('T');
    });

    test('every missing override is listed on each of them, so one action can close them all', async () => {
        const payload = await payloadFor(`${TEMPLATE}\njustification J implements T { conclusion x is "X" strategy y is "Y"\n y supports x }`, JpipeIssue.NoAbstractSupport);
        expect(payload.allMissing.map(m => m.expectedKey)).toEqual(['T:a', 'T:b']);
    });

    test('an override that is already written is absent from the missing list', async () => {
        const payload = await payloadFor(
            `${TEMPLATE}\njustification J implements T { evidence T:a is "A" }`,
            JpipeIssue.NoAbstractSupport
        );
        expect(payload.allMissing.map(m => m.expectedKey)).toEqual(['T:b']);
    });

    test('a wrongly typed override reports the keyword written and the ones allowed', async () => {
        const payload = await payloadFor(
            `${TEMPLATE}\njustification J implements T { strategy T:a is "A" evidence T:b is "B" }`,
            JpipeIssue.SupportOverrideType
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
        const payload = await payloadFor(`${TEMPLATE}\njustification J implements T { conclusion x is "X" strategy y is "Y"\n y supports x }`, JpipeIssue.NoAbstractSupport);
        expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    });
});
