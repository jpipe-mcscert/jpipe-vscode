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
    JpipeIssueSeverity,
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
/** A justification of `T` that overrides neither `@support`, and has nothing else wrong with it. */
// compiler 4.0.0: `cyclic-implements`, "cycle detected: A implements B implements A", on `B`.
const CYCLE = 'template A implements B { conclusion c is "C"  strategy s is "S"  @support h is "H"  s supports c  h supports s }\n'
    + 'template B implements A { @support g is "G" }';
const MISSING_OVERRIDES = `${TEMPLATE}\njustification J implements T { evidence e is "E" }`;

describe('diagnostic codes', () => {

    test('the visible code and the routing code agree', async () => {
        const diagnostic = await diagnosticFor('justification J { conclusion c is "" }', JpipeIssue.NoEmptyLabel);
        expect(diagnostic.code).toBe(JpipeIssue.NoEmptyLabel);
        expect((diagnostic.data as { code: string }).code).toBe(JpipeIssue.NoEmptyLabel);
    });

    test.each([
        [JpipeIssue.NoEmptyLabel, 'justification J { conclusion c is "" }'],
        [JpipeIssue.NoEmptyUnit, '// nothing but a comment\n'],
        [JpipeIssue.DuplicateModel, 'justification J { conclusion c is "C" }\njustification J { conclusion c is "C" }'],
        [JpipeIssue.HasAbstractSupport, 'template T { conclusion c is "C" }'],
        [JpipeIssue.ConclusionPresent, 'justification J { evidence e is "E" }'],
        [JpipeIssue.SingleConclusion, 'justification J { conclusion c1 is "A" conclusion c2 is "B" }'],
        [JpipeIssue.InheritedConclusion, `${TEMPLATE}\njustification J implements T { evidence T:a is "A" evidence T:b is "B" conclusion x is "X" }`],
        [JpipeIssue.UnknownOperator, 'justification A { conclusion c is "C" }\njustification B is nope(A)'],
        [JpipeIssue.UnknownConfigKey, 'justification A { conclusion c is "C" }\njustification B is assemble(A) { conclusionLabel: "C" strategyLabel: "S" nope: "X" }'],
        [JpipeIssue.MissingConfigKey, 'justification A { conclusion c is "C" }\njustification B is assemble(A) { conclusionLabel: "C" }'],
        [JpipeIssue.OperatorArity, 'justification A { conclusion c is "C" }\njustification B is refine(A)'],
        [JpipeIssue.DuplicateSource, 'justification A { conclusion c is "C" }\njustification B is assemble(A, A) { conclusionLabel: "C" strategyLabel: "S" }'],
        [JpipeIssue.CyclicImplements, CYCLE],
        [JpipeIssue.UnknownUnificationMethod, 'justification A { conclusion c is "C" }\njustification B is assemble(A) { conclusionLabel: "C" strategyLabel: "S" unifyBy: "nope" }'],
        [JpipeIssue.UnknownHook, 'justification A { conclusion c is "C" }\njustification B { conclusion d is "D" }\njustification R is refine(A, B) { hook: "nope" }'],
        [JpipeIssue.NoDuplicateIds, 'justification J { conclusion c is "C" evidence c is "E" }'],
        [JpipeIssue.StrategySupported, 'justification J { conclusion c is "C" strategy s is "S"\n s supports c }'],
        [JpipeIssue.InvalidSupport, 'justification J { conclusion c is "C" strategy s is "S" strategy t is "T"\n t supports s\n s supports c }'],
        [JpipeIssue.ConclusionSupported, 'justification J { conclusion c is "C" }'],
        [JpipeIssue.LoadUnresolved, 'load "nowhere.jd"\njustification J { conclusion c is "C" }'],
        [JpipeIssue.NoAbstractSupport, MISSING_OVERRIDES],
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
            MISSING_OVERRIDES,
            `${TEMPLATE}\njustification J implements T { strategy T:a is "A" evidence T:b is "B" }`,
            `${TEMPLATE}\njustification J implements T { conclusion x is "X" strategy y is "Y"\n y supports x }`,
            'justification J { conclusion c is "C" }\njustification J { conclusion c is "C" }',
            CYCLE,
            'justification A { conclusion c is "C" }\ntemplate R is refine(A, A) { hook: "c" }'
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
 * (jpipe-vscode ADR-VSC-0022). Severity used to be what told them apart; under ADR-VSC-0023 both
 * are errors, because the compiler rejects both. **Message text is now the only discriminator**,
 * which is why the two messages must stay distinct — nothing else in the suite would notice if the
 * collapse quietly lost one of the two branches.
 */
describe('one code, two checks', () => {

    test('a conclusion with no support at all says so', async () => {
        const diagnostic = await diagnosticFor(
            'justification J { conclusion c is "C" }',
            JpipeIssue.ConclusionSupported
        );
        expect(Diagnostic.getMessageString(diagnostic))
            .toBe("Conclusion 'c' is not supported by any strategy.");
        expect(diagnostic.severity).toBe(DiagnosticSeverity.Error);
    });

    test('a conclusion supported by something other than a strategy says that instead', async () => {
        const diagnostic = await diagnosticFor(
            'justification J { conclusion c is "C" evidence e is "E"\n e supports c }',
            JpipeIssue.ConclusionSupported
        );
        expect(Diagnostic.getMessageString(diagnostic))
            .toBe("Conclusion 'c' must be supported by at least one strategy.");
        expect(diagnostic.severity).toBe(DiagnosticSeverity.Error);
    });
});

/** The codes of this language's own diagnostics for `source`, Langium's linking errors left out. */
async function jpipeCodesIn(source: string): Promise<Array<string | undefined>> {
    const document = await parse(source);
    return (document.diagnostics ?? [])
        .filter(d => (d.data as { code?: string } | undefined)?.code !== 'linking-error')
        .map(d => issueCodeOf(d));
}

/** Every diagnostic reported for `source`. */
async function diagnosticsIn(source: string): Promise<Diagnostic[]> {
    return (await parse(source)).diagnostics ?? [];
}

/** Langium's linking errors for `source`: the unresolved references. */
async function linkingErrorsIn(source: string): Promise<Diagnostic[]> {
    const document = await parse(source);
    return (document.diagnostics ?? [])
        .filter(d => (d.data as { code?: string } | undefined)?.code === 'linking-error');
}

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

    // jpipe-compiler `examples/invalid/037_operator_on_an_unbuilt_model.jd`: the compiler reports
    // the unknown template and nothing else, since the conclusion would come from it (#129).
    test('a model under an implements that does not resolve is not called empty', async () => {
        const source = 'justification j implements missing {\n    evidence e is "An evidence"\n}';
        expect(await jpipeCodesIn(source)).toEqual([]);
        expect(await linkingErrorsIn(source)).toHaveLength(1);
    });

    test('nor is a template there said to declare no abstract support', async () => {
        const source = 'template t implements missing {\n    evidence e is "An evidence"\n}';
        expect(await jpipeCodesIn(source)).toEqual([]);
        expect(await linkingErrorsIn(source)).toHaveLength(1);
    });

    // jpipe-compiler `examples/invalid/010_implements_cycle.jd`: the compiler reports the cycle
    // and nothing about either model's completeness, since a loop gives them no element list.
    test('nor is a model whose implements chain loops back on itself', async () => {
        const source = 'template t1 implements t2 {\n conclusion c is "C"\n strategy s is "S"\n s supports c\n'
            + ' @support p is "P"\n p supports s\n}\n'
            + 'template t2 implements t1 {\n sub-conclusion t1:p is "P2"\n strategy s is "S2"\n s supports c\n'
            + ' @support p is "P"\n p supports s\n}';
        const codes = await jpipeCodesIn(source);
        expect(codes).not.toContain(JpipeIssue.ConclusionPresent);
        expect(codes).not.toContain(JpipeIssue.HasAbstractSupport);
    });

    // The chain is followed to its end: a break two `implements` up hides the conclusion as well.
    test('a break further up the chain counts too', async () => {
        const source = 'template u implements missing { @support h is "H" }\n'
            + 'justification j implements u { evidence u:h is "H" }';
        expect(await jpipeCodesIn(source)).toEqual([]);
    });
});

/**
 * A model that `implements` a template inherits its conclusion, and the compiler refuses one of its
 * own (`inherited-conclusion`, from compiler 4.0.0). Every case below was run through
 * `jpipe diagnostic` 4.0.0, and the expected errors are the ones it printed.
 */
describe('a model that implements a template inherits its conclusion', () => {

    const BASE = 'template T { conclusion c is "C"  strategy s is "S"  @support e is "E"  s supports c  e supports s }';

    test('a conclusion of its own is refused, in the compiler\'s words', async () => {
        const source = `${BASE}\njustification J implements T { evidence T:e is "E1"  conclusion x is "X" }`;
        expect(await errorsIn(source))
            .toEqual(["Model 'J' implements 'T' and inherits its conclusion: it cannot declare its own"]);
    });

    test('it is anchored on the conclusion\'s id, where the compiler puts it', async () => {
        const source = `${BASE}\njustification J implements T { evidence T:e is "E1"  conclusion x is "X" }`;
        const diagnostic = await diagnosticFor(source, JpipeIssue.InheritedConclusion);
        expect(diagnostic.range.start).toEqual({ line: 1, character: 64 });
    });

    // The compiler reports each one under this code, and neither `single-conclusion` nor
    // `conclusion-supported`, since it discards them all.
    test('every one of several is refused, and nothing else is said about them', async () => {
        const source = `${BASE}\njustification J implements T { evidence T:e is "E1"  conclusion x is "X" conclusion z is "Z" strategy y is "Y"\n T:e supports y\n y supports x }`;
        expect(await jpipeCodesIn(source))
            .toEqual([JpipeIssue.InheritedConclusion, JpipeIssue.InheritedConclusion]);
    });

    // What the compiler still reports: the strategy that only supported the discarded conclusion
    // has nothing supporting it, and the overrides are still missing.
    test('the rest of the model is still judged', async () => {
        const source = `${TEMPLATE}\njustification J implements T { conclusion x is "X" strategy y is "Y"\n y supports x }`;
        expect((await jpipeCodesIn(source)).sort()).toEqual([
            JpipeIssue.InheritedConclusion,
            JpipeIssue.NoAbstractSupport,
            JpipeIssue.NoAbstractSupport,
            JpipeIssue.StrategySupported
        ].sort());
    });

    // The rule reads the declaration alone, so it holds whether or not the template resolves.
    test('it holds under an implements that does not resolve', async () => {
        const source = 'justification j implements missing {\n    conclusion c is "C"\n}';
        expect(await errorsIn(source))
            .toContain("Model 'j' implements 'missing' and inherits its conclusion: it cannot declare its own");
    });

    test('a template is held to the rule as well', async () => {
        const source = `${BASE}\ntemplate U implements T { @support f is "F"  conclusion x is "X" }`;
        expect(await jpipeCodesIn(source)).toContain(JpipeIssue.InheritedConclusion);
    });

    // The compiler discards the conclusion with its relations before any other rule runs, so the
    // model is judged as if it were not written. Each expectation is what compiler 4.0.0 printed.
    describe('the discarded conclusion is not part of the model', () => {

        test('a relation from it supports nothing', async () => {
            const source = `${BASE}\njustification J implements T { evidence T:e is "E" conclusion x is "X" strategy y is "Y" x supports y }`;
            expect(await jpipeCodesIn(source))
                .toEqual([JpipeIssue.InheritedConclusion, JpipeIssue.StrategySupported]);
        });

        test('it is not the model\'s conclusion when the template has none', async () => {
            const source = 'template T { @support a is "A" strategy s is "S" a supports s }\n'
                + 'justification J implements T { evidence T:a is "A" conclusion x is "X" }';
            expect(await errorsIn(source)).toEqual(expect.arrayContaining([
                "Model 'J' implements 'T' and inherits its conclusion: it cannot declare its own",
                "Model 'J' has no conclusion"
            ]));
        });

        test('spelled as an override, it leaves the @support missing rather than overridden', async () => {
            const source = `${BASE}\njustification J implements T { conclusion T:e is "E" }`;
            expect((await jpipeCodesIn(source)).sort())
                .toEqual([JpipeIssue.InheritedConclusion, JpipeIssue.NoAbstractSupport].sort());
        });

        // An intermediate template's discarded conclusion overrides nothing either, so a model
        // further down still owes the override (compiler 4.0.0: no-abstract-support on 'T:e').
        test('spelled as an override in an intermediate template, it excuses no one below', async () => {
            const source = `${BASE}\ntemplate U implements T { conclusion T:e is "E" @support f is "F" }\n`
                + 'justification J implements U { evidence U:f is "F" }';
            const missing = (await diagnosticsIn(source))
                .filter(d => issueCodeOf(d) === JpipeIssue.NoAbstractSupport)
                .map(d => (d.data as JpipeIssueData<typeof JpipeIssue.NoAbstractSupport>).expectedKey);
            expect(missing).toEqual(['T:e']);
        });

        // compiler 4.0.0 finds `T:c`, the conclusion the model keeps, and does not find `x`.
        test('a refine hook finds the inherited conclusion, not the discarded one', async () => {
            const source = `${BASE}\njustification J implements T { evidence T:e is "E" conclusion x is "X" }\n`
                + 'justification B { conclusion d is "D" }\n'
                + 'justification R is refine(J, B) { hook: "T:c" }\n'
                + 'justification R2 is refine(J, B) { hook: "x" }';
            const unknown = (await diagnosticsIn(source))
                .filter(d => issueCodeOf(d) === JpipeIssue.UnknownHook)
                .map(d => (d.data as JpipeIssueData<typeof JpipeIssue.UnknownHook>).actual);
            expect(unknown).toEqual(['x']);
        });

        test('its label is not checked', async () => {
            const source = `${BASE}\njustification J implements T { evidence T:e is "E" conclusion x is "" }`;
            expect(await jpipeCodesIn(source)).toEqual([JpipeIssue.InheritedConclusion]);
        });

        // compiler 4.0.0: `e` is the inherited @support, which supports the strategy; only the
        // override is missing.
        test('a short name in a relation it is not written in names the inherited element', async () => {
            const source = `${BASE}\njustification J implements T { conclusion T:e is "E" strategy y is "Y" e supports y }`;
            expect((await jpipeCodesIn(source)).sort())
                .toEqual([JpipeIssue.InheritedConclusion, JpipeIssue.NoAbstractSupport].sort());
            expect(await linkingErrorsIn(source)).toEqual([]);
        });

        test('a relation written with its id still resolves, and reports nothing', async () => {
            const source = `${BASE}\njustification J implements T { evidence T:e is "E" conclusion x is "X" strategy y is "Y" T:e supports y y supports x }`;
            expect(await jpipeCodesIn(source)).toEqual([JpipeIssue.InheritedConclusion]);
            expect(await linkingErrorsIn(source)).toEqual([]);
        });

        // compiler 4.0.0: unknown element 'x' in model 'J'.
        test('a model below does not inherit it', async () => {
            const source = `${BASE}\ntemplate U implements T { conclusion x is "X" }\n`
                + 'justification J implements U { evidence T:e is "E" strategy y is "Y" y supports x }';
            expect((await linkingErrorsIn(source)).map(d => d.range.start.line)).toEqual([2]);
        });

        test('its id clashes with nothing', async () => {
            const source = `${BASE}\njustification J implements T { evidence T:e is "E" conclusion x is "X" evidence x is "Y" }`;
            expect(await jpipeCodesIn(source)).toEqual([JpipeIssue.InheritedConclusion]);
        });
    });

    test('a model with no implements may declare its conclusion', async () => {
        expect(await jpipeCodesIn(BASE)).toEqual([]);
    });

    test('the payload names the model, the template as written, and the conclusion', async () => {
        const source = `${BASE}\njustification J implements T { evidence T:e is "E1"  conclusion x is "X" }`;
        const payload = await payloadFor(source, JpipeIssue.InheritedConclusion);
        expect(payload).toMatchObject({ modelId: 'J', parentId: 'T', id: 'x' });
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
    // `conclusion-supported` error, and suppressing it here would hide a real problem.
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

/**
 * jpipe-vscode ADR-VSC-0023: a diagnostic is an error if and only if the compiler will reject the
 * model. The compiler has no warning level, so every rule it enforces is an error here too, and a
 * warning has to be justified by the compiler *accepting* the file — or, once, by the editor being
 * unable to know.
 *
 * `JpipeIssueSeverity` is a `Record`, so a code with no declared severity already fails to
 * compile. What this adds is the harder half: choosing `'warning'` means editing the list below,
 * which is the moment to check that the compiler really does build the file.
 */
describe('severity follows the compiler', () => {

    /** Every code deliberately reported as a warning, with the reason it is not an error. */
    const EXPECTED_WARNINGS: readonly JpipeIssueCode[] = [
        JpipeIssue.NoEmptyLabel,             // compiler builds it: nothing checks a label's contents
        JpipeIssue.UnknownUnificationMethod  // the exception: the editor cannot see its registry
    ];

    test('the warnings are exactly the ones ADR-VSC-0023 allows', () => {
        const actual = Object.values(JpipeIssue)
            .filter(code => JpipeIssueSeverity[code] === 'warning')
            .sort();
        expect(actual, 'a new warning needs a reason the compiler accepts the file — see ADR-VSC-0023')
            .toEqual([...EXPECTED_WARNINGS].sort());
    });

    test('everything else is an error', () => {
        const warnings = new Set<string>(EXPECTED_WARNINGS);
        const misfiled = Object.values(JpipeIssue)
            .filter(code => !warnings.has(code) && JpipeIssueSeverity[code] !== 'error');
        expect(misfiled).toEqual([]);
    });
});

describe('payloads carry what a fix needs', () => {

    test('a missing override names the id the declaration must be given', async () => {
        const payload = await payloadFor(MISSING_OVERRIDES, JpipeIssue.NoAbstractSupport);
        expect(payload.expectedKey).toBe('T:a');
        expect(payload.supportLabel).toBe('A');
        expect(payload.sourceTemplateId).toBe('T');
    });

    test('every missing override is listed on each of them, so one action can close them all', async () => {
        const payload = await payloadFor(MISSING_OVERRIDES, JpipeIssue.NoAbstractSupport);
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
        const payload = await payloadFor(MISSING_OVERRIDES, JpipeIssue.NoAbstractSupport);
        expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    });
});

// #128. Each expectation is what jpipe-compiler 4.0.0 printed for the same file.
describe('a cycle of implements is reported once, as the compiler reports it', () => {

    const cyclic = async (source: string) => (await diagnosticsIn(source))
        .filter(d => issueCodeOf(d) === JpipeIssue.CyclicImplements);

    test('in its words, on the template the closing implements names', async () => {
        const [diagnostic, ...others] = await cyclic(CYCLE);
        expect(others).toEqual([]);
        expect(Diagnostic.getMessageString(diagnostic)).toBe('cycle detected: A implements B implements A');
        expect(diagnostic.range.start).toEqual({ line: 0, character: 22 });
        expect(diagnostic.severity).toBe(DiagnosticSeverity.Error);
        expect(diagnostic.data).toMatchObject({ modelId: 'A', cycle: ['A', 'B'] });
    });

    test('by the first model of the cycle in alphabetical order, starting from it', async () => {
        const source = 'template Z implements Y { @support h is "H" }\n'
            + 'template Y implements X { @support g is "G" }\n'
            + 'template X implements Z { @support f is "F" }';
        const diagnostics = await cyclic(source);
        expect(diagnostics.map(d => Diagnostic.getMessageString(d)))
            .toEqual(['cycle detected: X implements Z implements Y implements X']);
        expect(diagnostics[0].range.start.line).toBe(2);
    });

    test('through the sources of an operator', async () => {
        const source = 'justification b { conclusion c is "C" strategy s is "S" evidence e is "E" s supports c e supports s }\n'
            + 'justification cyc implements built { evidence e is "An evidence" }\n'
            + 'template built is assemble(cyc, b) { conclusionLabel: "Built"  strategyLabel: "SB" }';
        expect((await cyclic(source)).map(d => Diagnostic.getMessageString(d)))
            .toEqual(["cycle detected: cyc implements built, which 'assemble' builds from cyc"]);
    });

    // The compiler builds nothing below a cycle, and judges it no further.
    test('not on a model that only implements a template on it, which is not judged either', async () => {
        const source = `${CYCLE}\njustification J implements A { evidence A:h is "H" }`;
        const reported = (await diagnosticsIn(source))
            .filter(d => d.range.start.line === 2)
            .map(d => issueCodeOf(d));
        expect(reported).toEqual([]);
    });

    // compiler 4.0.0 refuses the `implements` of a composed model (invalid-operator-call) rather
    // than follow it, so no cycle runs through it.
    test('not through the implements of a composed model, which the compiler does not follow', async () => {
        const source = 'justification A { conclusion c is "C" strategy s is "S" evidence a is "E" s supports c a supports s }\n'
            + 'justification B { conclusion c is "C" strategy s is "S" evidence e is "E" s supports c e supports s }\n'
            + 'template Q implements R is refine(A, B) { hook: "a" }\n'
            + 'template R implements Q { @support g is "G" }';
        expect(await cyclic(source)).toEqual([]);
    });

    test('and a model below a cycle through an operator is not judged', async () => {
        const source = 'justification b { conclusion c is "C" strategy s is "S" evidence e is "E" s supports c e supports s }\n'
            + 'template cyc implements built { @support h is "H" }\n'
            + 'template built is assemble(cyc, b) { conclusionLabel: "Built"  strategyLabel: "SB" }\n'
            + 'justification J implements cyc { evidence e2 is "E2" }';
        expect((await diagnosticsIn(source)).filter(d => d.range.start.line === 3).map(d => issueCodeOf(d))).toEqual([]);
    });

    test('not on a chain that ends', async () => {
        expect(await cyclic(`${TEMPLATE}\njustification J implements T { evidence T:a is "A" evidence T:b is "B" }`)).toEqual([]);
    });
});

describe('a model given twice to one operator', () => {

    const repeats = async (source: string) => (await diagnosticsIn(source))
        .filter(d => issueCodeOf(d) === JpipeIssue.DuplicateSource);
    const B = 'justification b { conclusion c is "C" strategy s is "S" evidence e is "E" s supports c e supports s }';

    test.each([
        ['refine', 'template refined is refine(b, b) { hook: "e" }', "'refine' for 'refined': the model 'b' is given more than once"],
        ['assemble', 'justification asm is assemble(b, b) { conclusionLabel: "X" strategyLabel: "Y" }', "'assemble' for 'asm': the model 'b' is given more than once"]
    ])('is reported for %s in the compiler\'s words, on the repeat', async (_operator, call, message) => {
        const [diagnostic, ...others] = await repeats(`${B}\n${call}`);
        expect(others).toEqual([]);
        expect(Diagnostic.getMessageString(diagnostic)).toBe(message);
        expect(diagnostic.range.start).toEqual({ line: 1, character: call.lastIndexOf('b,') + 3 });
        expect(diagnostic.severity).toBe(DiagnosticSeverity.Error);
    });

    test('once for each repeat', async () => {
        const source = `${B}\njustification asm is assemble(b, b, b) { conclusionLabel: "X" strategyLabel: "Y" }`;
        expect(await repeats(source)).toHaveLength(2);
    });

    test('not for distinct models, nor for an operator the editor does not know', async () => {
        const other = 'justification d { conclusion c is "C" strategy s is "S" evidence e is "E" s supports c e supports s }';
        expect(await repeats(`${B}\n${other}\ntemplate r is refine(b, d) { hook: "e" }`)).toEqual([]);
        expect(await repeats(`${B}\njustification n is nope(b, b)`)).toEqual([]);
    });

    // compiler 4.0.0: unknown-model, twice, and nothing about the repeat.
    test('not for a source that does not resolve', async () => {
        expect(await repeats(`${B}\njustification j is assemble(nope, nope) { conclusionLabel: "X" strategyLabel: "Y" }`)).toEqual([]);
    });
});
