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
        [JpipeIssue.ConclusionPresent, 'justification J { evidence e is "E" }'],
        [JpipeIssue.SingleConclusion, 'justification J { conclusion c1 is "A" conclusion c2 is "B" }'],
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

/** The messages of the errors reported for `source`. */
async function errorsIn(source: string): Promise<string[]> {
    const document = await parse(source);
    return (document.diagnostics ?? [])
        .filter(d => d.severity === DiagnosticSeverity.Error)
        .map(d => Diagnostic.getMessageString(d));
}

/**
 * `conclusion-present` is the compiler's rule, and the editor is only useful here if it agrees
 * with it on all three of the awkward cases: an inherited conclusion satisfies it, a composed
 * model is not judged on source text it does not have, and a template is held to it too.
 */
describe('a model must have a conclusion', () => {

    test('a justification with elements but no conclusion is an error', async () => {
        expect(await errorsIn('justification J { evidence e is "E" }'))
            .toContain("Model 'J' has no conclusion");
    });

    test('a template is held to the rule as well', async () => {
        expect(await errorsIn('template T { @support a is "A" }'))
            .toContain("Model 'T' has no conclusion");
    });

    // The compiler checks completeness after `implements` has inlined the parent's elements, so a
    // conclusion inherited from the template satisfies it there and must here.
    test('a conclusion inherited from the template satisfies it', async () => {
        const source = `${TEMPLATE}\njustification J implements T { evidence T:a is "A" evidence T:b is "B" }`;
        expect(await errorsIn(source)).not.toContain("Model 'J' has no conclusion");
    });

    // `assemble` synthesises a conclusion from `conclusionLabel`, so the compiler is satisfied by
    // the built result. Judging the source text would report an error on a model that builds.
    test('a composed model is not judged on a body it does not have', async () => {
        const source = 'justification A { conclusion c is "C" }\n'
            + 'justification B is assemble(A) { conclusionLabel: "All of it" strategyLabel: "Together" }';
        expect(await errorsIn(source)).not.toContain("Model 'B' has no conclusion");
    });
});

/**
 * A model claims one thing. The compiler keeps the first conclusion and discards every later one,
 * so the interesting half of this rule is what it *stops* the editor saying: a second conclusion
 * is usually written with nothing supporting it, and answering "there are two conclusions" with
 * "the second has no strategy" describes an element that will not exist.
 *
 * The fixture is the compiler's own `examples/invalid/005_multiple_conclusion.jd`.
 */
describe('a model may claim only one conclusion', () => {

    const TWO_CONCLUSIONS = `justification j {
    conclusion c1 is "First conclusion"
    conclusion c2 is "Second conclusion"
    strategy   s  is "A strategy"
    evidence   e  is "An evidence"

    s supports c1
    e supports s
}`;

    test('the second conclusion is an error, in the compiler\'s words', async () => {
        expect(await errorsIn(TWO_CONCLUSIONS)).toEqual(["Model 'j' declares multiple conclusions"]);
    });

    test('it is anchored on the extra conclusion, leaving the first unmarked', async () => {
        const diagnostic = await diagnosticFor(TWO_CONCLUSIONS, JpipeIssue.SingleConclusion);
        expect(diagnostic.range.start.line).toBe(2);
        expect(diagnostic.range.start.character).toBe(15);
    });

    // The point of the rule: the extra conclusion is discarded by the compiler, so it never asks
    // whether that one is supported, and neither may we.
    test('the discarded conclusion is not also reported as unsupported', async () => {
        const document = await parse(TWO_CONCLUSIONS);
        const codes = (document.diagnostics ?? []).map(d => issueCodeOf(d));
        expect(codes).not.toContain(JpipeIssue.ConclusionSupported);
    });

    // Only the extras are discarded. A lone conclusion with no strategy is still the ordinary
    // `conclusion-supported` warning, and suppressing it here would hide a real problem.
    test('a single unsupported conclusion is still reported', async () => {
        const document = await parse('justification J { conclusion c is "C" evidence e is "E"\n e supports c }');
        const codes = (document.diagnostics ?? []).map(d => issueCodeOf(d));
        expect(codes).toContain(JpipeIssue.ConclusionSupported);
    });

    test('a template is held to the rule as well', async () => {
        const source = 'template t {\n conclusion c1 is "First"\n conclusion c2 is "Second"\n'
            + ' strategy s is "S"\n @support abs is "A"\n s supports c1\n abs supports s\n}';
        expect(await errorsIn(source)).toEqual(["Model 't' declares multiple conclusions"]);
    });

    test('a third conclusion is reported too, so fixing one does not hide the next', async () => {
        const source = 'justification J {\n conclusion c1 is "A"\n conclusion c2 is "B"\n conclusion c3 is "C"\n'
            + ' strategy s is "S"\n evidence e is "E"\n s supports c1\n e supports s\n}';
        expect(await errorsIn(source)).toHaveLength(2);
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
