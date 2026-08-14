import { beforeAll, describe, expect, test } from "vitest";
import { EmptyFileSystem, type LangiumDocument } from "langium";
import { parseHelper } from "langium/test";
import { Diagnostic, DiagnosticSeverity } from "vscode-languageserver-types";
import type { Unit } from "jpipe-language";
import { createJpipeServices, isUnit } from "jpipe-language";

let services: ReturnType<typeof createJpipeServices>;
let parse: ReturnType<typeof parseHelper<Unit>>;

beforeAll(async () => {
    services = createJpipeServices(EmptyFileSystem);
    const doParse = parseHelper<Unit>(services.Jpipe);
    parse = (input: string) => doParse(input, { validation: true });
});

function assertNoParseErrors(document: LangiumDocument<Unit>): void {
    expect(document.parseResult.parserErrors).toHaveLength(0);
    expect(isUnit(document.parseResult.value)).toBe(true);
}

function diagnosticMessages(document: LangiumDocument<Unit>): string[] {
    return (document.diagnostics ?? []).map((d: Diagnostic) => Diagnostic.getMessageString(d));
}

describe('Validation tests', () => {

    test('empty label triggers warning', async () => {
        const doc = await parse(`
            justification J {
                evidence e is ""
                conclusion c is "Claim"
                strategy s is "Strategy"
                e supports s
                s supports c
            }
        `);
        assertNoParseErrors(doc);
        const messages = diagnosticMessages(doc);
        expect(messages.some(m => m.includes('label should not be empty'))).toBe(true);
    });

    test('duplicate justification name triggers error', async () => {
        const doc = await parse(`
            justification J {
                conclusion c is "Claim"
                strategy s is "Strategy"
                evidence e is "Evidence"
                e supports s
                s supports c
            }
            justification J {
                conclusion c is "Claim"
                strategy s is "Strategy"
                evidence e is "Evidence"
                e supports s
                s supports c
            }
        `);
        assertNoParseErrors(doc);
        const messages = diagnosticMessages(doc);
        expect(messages.some(m => m.includes("Duplicate justification name 'J'"))).toBe(true);
    });

    test('duplicate template name triggers error', async () => {
        const doc = await parse(`
            template T {
                conclusion c is "Claim"
                @support abs is "Abstract"
                abs supports c
            }
            template T {
                conclusion c is "Claim"
                @support abs is "Abstract"
                abs supports c
            }
        `);
        assertNoParseErrors(doc);
        const messages = diagnosticMessages(doc);
        expect(messages.some(m => m.includes("Duplicate template name 'T'"))).toBe(true);
    });

    // An error, not a warning: the compiler refuses to build it (jpipe-vscode ADR-VSC-0023), and
    // the message is its wording — a template with no abstract supports is a justification in
    // disguise.
    test('template with no @support is an error', async () => {
        const doc = await parse(`
            template T {
                conclusion c is "Claim"
                strategy s is "Strategy"
                evidence e is "Evidence"
                e supports s
                s supports c
            }
        `);
        assertNoParseErrors(doc);
        const messages = diagnosticMessages(doc);
        expect(messages.some(m => m.includes('declares no abstract supports'))).toBe(true);
        const diagnostic = (doc.diagnostics ?? [])
            .find(d => Diagnostic.getMessageString(d).includes('declares no abstract supports'));
        expect(diagnostic?.severity).toBe(DiagnosticSeverity.Error);
    });

    test('@support not overridden triggers error', async () => {
        const doc = await parse(`
            template T {
                conclusion c is "Claim"
                strategy s is "Strategy"
                @support abs is "Abstract"
                abs supports s
                s supports c
            }
            justification J implements T {
                conclusion c is "Claim"
                strategy s is "Strategy"
                s supports c
            }
        `);
        assertNoParseErrors(doc);
        const messages = diagnosticMessages(doc);
        expect(messages.some(m => m.includes("must override '@support abs'"))).toBe(true);
    });

    test('@support overridden with wrong type triggers error', async () => {
        const doc = await parse(`
            template T {
                conclusion c is "Claim"
                strategy s is "Strategy"
                @support abs is "Abstract"
                abs supports s
                s supports c
            }
            justification J implements T {
                conclusion c is "Claim"
                strategy T:abs is "Wrong type"
                strategy s is "Strategy"
                T:abs supports s
                s supports c
            }
        `);
        assertNoParseErrors(doc);
        const messages = diagnosticMessages(doc);
        expect(messages.some(m => m.includes("Cannot override '@support abs' with type 'strategy'"))).toBe(true);
    });

    test('strategy with no incoming support triggers warning', async () => {
        const doc = await parse(`
            justification J {
                conclusion c is "Claim"
                strategy s is "Unsupported strategy"
                s supports c
            }
        `);
        assertNoParseErrors(doc);
        const messages = diagnosticMessages(doc);
        expect(messages.some(m => m.includes("not supported by any evidence"))).toBe(true);
    });

    test('conclusion with no incoming strategy triggers error', async () => {
        const doc = await parse(`
            justification J {
                conclusion c is "Claim"
                evidence e is "Evidence"
                e supports c
            }
        `);
        assertNoParseErrors(doc);
        const messages = diagnosticMessages(doc);
        expect(messages.some(m => m.includes('must be supported by at least one strategy'))).toBe(true);
    });

    test('valid justification with template override produces no errors', async () => {
        const doc = await parse(`
            template T {
                conclusion c is "Claim"
                strategy s is "Strategy"
                @support abs is "Abstract"
                abs supports s
                s supports c
            }
            justification J implements T {
                conclusion c is "Claim"
                strategy s is "Strategy"
                evidence T:abs is "Concrete evidence"
                T:abs supports s
                s supports c
            }
        `);
        assertNoParseErrors(doc);
        const errors = (doc.diagnostics ?? []).filter((d: Diagnostic) => d.severity === 1);
        expect(errors).toHaveLength(0);
    });

    test('multi-level inheritance: intermediate override not re-required', async () => {
        const doc = await parse(`
            template root {
                conclusion c is "Root conclusion"
                strategy s is "Root strategy"
                @support abs1 is "Root abstract #1"
                @support abs2 is "Root abstract #2"
                s    supports c
                abs1 supports s
                abs2 supports s
            }
            template intermediate implements root {
                sub-conclusion root:abs1 is "Intermediate sub-conclusion"
                strategy s is "Intermediate strategy"
                @support abs_i is "Intermediate abstract"
                s     supports root:abs1
                abs_i supports s
            }
            justification leaf_intermediate implements intermediate {
                evidence intermediate:abs_i is "Leaf support #3"
                evidence root:abs2 is "Leaf evidence #2"
            }
        `);
        assertNoParseErrors(doc);
        const errors = (doc.diagnostics ?? []).filter((d: Diagnostic) => d.severity === 1);
        expect(errors).toHaveLength(0);
    });

    test('unqualified override element triggers error (missing template prefix)', async () => {
        const doc = await parse(`
            template T {
                conclusion c is "Claim"
                strategy s is "Strategy"
                @support abs is "Abstract"
                abs supports s
                s supports c
            }
            justification J implements T {
                conclusion c is "Claim"
                strategy s is "Strategy"
                evidence abs is "Missing prefix"
                abs supports s
                s supports c
            }
        `);
        assertNoParseErrors(doc);
        const messages = diagnosticMessages(doc);
        expect(messages.some(m => m.includes("Expected element with id 'T:abs'"))).toBe(true);
    });

    test('unknown composition operator triggers error', async () => {
        const doc = await parse(`
            justification A { conclusion c is "C" }
            justification Composed is unknown(A) {
                conclusionLabel: "C"
                strategyLabel: "S"
            }
        `);
        assertNoParseErrors(doc);
        const messages = diagnosticMessages(doc);
        expect(messages.some(m => m.includes("Unknown operator 'unknown'"))).toBe(true);
    });

    // Only a warning: the compiler ignores config keys it does not recognise, so an error here
    // would announce a build failure that never comes.
    test('unknown config key triggers a warning, not an error', async () => {
        const doc = await parse(`
            justification A { conclusion c is "C" }
            justification Composed is assemble(A) {
                conclusionLabel: "C"
                strategyLabel: "S"
                wrongKey: "X"
            }
        `);
        assertNoParseErrors(doc);
        const unknownKey = (doc.diagnostics ?? []).filter(
            (d: Diagnostic) => Diagnostic.getMessageString(d).includes("Unknown config key 'wrongKey'")
        );
        expect(unknownKey).toHaveLength(1);
        expect(unknownKey[0].severity).toBe(DiagnosticSeverity.Warning);
    });

    // `unifyBy` and `unifyExclude` are read by the compiler's post-composition Unifier, which
    // runs over every operator's config map — so they are legal wherever a config block is.
    test.each(['assemble', 'refine'])('accepts the unification keys on %s', async (operator) => {
        const config = operator === 'assemble'
            ? 'conclusionLabel: "C"\n                strategyLabel: "S"'
            : 'hook: "c"';
        const doc = await parse(`
            justification A { conclusion c is "C" }
            justification B { conclusion c is "C" }
            justification Composed is ${operator}(A, B) {
                ${config}
                unifyBy: "sameLabel"
                unifyExclude: "c"
            }
        `);
        assertNoParseErrors(doc);
        const messages = diagnosticMessages(doc);
        expect(messages.some(m => m.includes('Unknown config key'))).toBe(false);
    });

    test('missing required config key triggers error', async () => {
        const doc = await parse(`
            justification A { conclusion c is "C" }
            justification Composed is assemble(A) {
                conclusionLabel: "C"
            }
        `);
        assertNoParseErrors(doc);
        const messages = diagnosticMessages(doc);
        expect(messages.some(m => m.includes("Missing required config key 'strategyLabel'"))).toBe(true);
    });

    test('valid assemble composition passes validation', async () => {
        const doc = await parse(`
            justification A { conclusion c is "C" }
            justification Composed is assemble(A) {
                conclusionLabel: "C"
                strategyLabel: "S"
            }
        `);
        assertNoParseErrors(doc);
        const messages = diagnosticMessages(doc);
        expect(messages.some(m => m.includes('operator') || m.includes('config key'))).toBe(false);
    });
});

describe('Operator arity', () => {

    // Nothing checked this before: `refine(a)` parsed, validated clean, and failed at build time
    // in RefineOperator, which throws on anything but two sources.
    test.each([
        ['refine(A)', 'refine requires exactly 2 source models, got 1.'],
        ['refine(A, B, A)', 'refine requires exactly 2 source models, got 3.'],
        ['refine()', 'refine requires exactly 2 source models, got 0.'],
        ['assemble()', 'assemble requires at least 1 source model, got 0.']
    ])('%s is rejected', async (call, expected) => {
        const doc = await parse(`
            justification A { conclusion c is "C" }
            justification B { conclusion c is "C" }
            justification Composed is ${call} { hook: "c" conclusionLabel: "C" strategyLabel: "S" }
        `);
        assertNoParseErrors(doc);
        expect(diagnosticMessages(doc).some(m => m.includes(expected))).toBe(true);
    });

    test.each([
        'refine(A, B)',
        'assemble(A)',
        'assemble(A, B)'
    ])('%s is accepted', async (call) => {
        const doc = await parse(`
            justification A { conclusion c is "C" }
            justification B { conclusion c is "C" }
            justification Composed is ${call} { hook: "c" conclusionLabel: "C" strategyLabel: "S" }
        `);
        assertNoParseErrors(doc);
        expect(diagnosticMessages(doc).some(m => m.includes('source models'))).toBe(false);
    });

    test('an unknown operator is not also reported for its arity', async () => {
        const doc = await parse(`
            justification A { conclusion c is "C" }
            justification Composed is nope(A)
        `);
        assertNoParseErrors(doc);
        expect(diagnosticMessages(doc).some(m => m.includes('source models'))).toBe(false);
    });
});

describe('Cyclic implements', () => {

    // The compiler reports this as `cyclic-implements`, and the model sits in that state while it
    // is being edited. Walking the chain without a guard exhausted the stack; Langium caught the
    // overflow and turned it into a diagnostic of its own, so the Problems panel filled with
    // "An error occurred during validation" beside the findings the user actually needed.
    const internalFailure = (messages: string[]) =>
        messages.filter(m => m.includes('An error occurred during validation'));

    test('a template implementing itself reports findings, not an internal failure', async () => {
        const doc = await parse(`
            template A implements B {
                @support a is ""
                conclusion c is "C"
                a supports c
            }
            template B implements A {
                @support b is "B"
                conclusion c2 is "C2"
                b supports c2
            }
        `);
        assertNoParseErrors(doc);
        const messages = diagnosticMessages(doc);
        expect(internalFailure(messages)).toEqual([]);
        // The checks that follow the cyclic walk still ran.
        expect(messages).toContain('Element label should not be empty');
    });

    test('a justification implementing a cyclic template reports findings too', async () => {
        const doc = await parse(`
            template A implements B { @support a is "A" conclusion c is "C" a supports c }
            template B implements A { @support b is "B" conclusion c2 is "C2" b supports c2 }
            justification J implements A { conclusion jc is "" strategy s is "S" s supports jc }
        `);
        assertNoParseErrors(doc);
        const messages = diagnosticMessages(doc);
        expect(internalFailure(messages)).toEqual([]);
        expect(messages).toContain('Element label should not be empty');
    });
});

describe('Duplicate element ids', () => {

    // The compiler rejects this as `no-duplicate-ids`. It matters in the editor because the model
    // still parses: a relation naming the id resolves to whichever one the scope registered, so
    // the argument quietly means something other than what it reads as.
    test('two elements sharing an id in one model is an error', async () => {
        const doc = await parse(`
            justification j {
                conclusion c is "A conclusion"
                strategy   s is "A strategy"
                evidence   e is "An evidence #1"
                evidence   e is "An evidence #2"
                s supports c
                e supports s
            }
        `);
        assertNoParseErrors(doc);
        expect(diagnosticMessages(doc).some(m => m.includes("Duplicate element id 'e' in model 'j'"))).toBe(true);
    });

    // The first declaration is the one the reader thinks of as real; the copies are the problem.
    test('only the later occurrences are marked', async () => {
        const doc = await parse(`
            justification j {
                conclusion c is "C"
                evidence   e is "One"
                evidence   e is "Two"
                evidence   e is "Three"
            }
        `);
        assertNoParseErrors(doc);
        const duplicates = diagnosticMessages(doc).filter(m => m.includes('Duplicate element id'));
        expect(duplicates).toHaveLength(2);
    });

    test('the same id in two different models is fine', async () => {
        const doc = await parse(`
            justification a { conclusion c is "C" strategy s is "S" evidence e is "E" e supports s s supports c }
            justification b { conclusion c is "C" strategy s is "S" evidence e is "E" e supports s s supports c }
        `);
        assertNoParseErrors(doc);
        expect(diagnosticMessages(doc).some(m => m.includes('Duplicate element id'))).toBe(false);
    });

    test('an override qualified by its template does not collide with a local id', async () => {
        const doc = await parse(`
            template T { @support e is "Abstract" conclusion c is "C" strategy s is "S" e supports s s supports c }
            justification J implements T {
                conclusion c is "C"
                strategy s is "S"
                evidence T:e is "Concrete"
                evidence e is "Local"
                T:e supports s
                s supports c
            }
        `);
        assertNoParseErrors(doc);
        expect(diagnosticMessages(doc).some(m => m.includes('Duplicate element id'))).toBe(false);
    });

    // A half-typed element has no id at all; it must not read as a duplicate of the last one.
    test('elements still being typed are not duplicates of each other', async () => {
        const doc = await parse('justification j {\n    conclusion c is "C"\n    evidence \n    evidence \n}');
        expect(diagnosticMessages(doc).some(m => m.includes('Duplicate element id'))).toBe(false);
    });
});

describe('Unification method', () => {

    const composed = (unifyBy: string) => `
        justification A { conclusion c is "C" }
        justification B { conclusion c is "C" }
        justification Composed is refine(A, B) { hook: "c" unifyBy: "${unifyBy}" }
    `;

    test('the one jPipe ships is accepted', async () => {
        const doc = await parse(composed('sameLabel'));
        assertNoParseErrors(doc);
        expect(diagnosticMessages(doc).some(m => m.includes('unification method'))).toBe(false);
    });

    // A build may register relations shipped with neither jPipe core nor this extension, so an
    // unrecognised name is the limit of what the editor knows — not a defect in the model.
    test('an unknown one is a warning, not an error', async () => {
        const doc = await parse(composed('nonexistent'));
        assertNoParseErrors(doc);
        const found = (doc.diagnostics ?? []).filter(
            (d: Diagnostic) => Diagnostic.getMessageString(d).includes("Unknown unification method 'nonexistent'")
        );
        expect(found).toHaveLength(1);
        expect(found[0].severity).toBe(DiagnosticSeverity.Warning);
    });

    test('the warning lists what is registered', async () => {
        const doc = await parse(composed('nonexistent'));
        expect(diagnosticMessages(doc).some(m => m.includes('registered: sameLabel'))).toBe(true);
    });

    // Silence is not the alternative: a typo'd relation fails the build with nothing having said so.
    test('a near miss is still reported', async () => {
        const doc = await parse(composed('samelabel'));
        expect(diagnosticMessages(doc).some(m => m.includes('Unknown unification method'))).toBe(true);
    });

    test('a name declared in settings is accepted', async () => {
        services.Jpipe.unification.setAdditionalMethods(['similarLabel']);
        try {
            const doc = await parse(composed('similarLabel'));
            expect(diagnosticMessages(doc).some(m => m.includes('unification method'))).toBe(false);
        } finally {
            services.Jpipe.unification.setAdditionalMethods([]);
        }
    });

    test('a declared name joins the list the warning offers', async () => {
        services.Jpipe.unification.setAdditionalMethods(['similarLabel']);
        try {
            const doc = await parse(composed('nonexistent'));
            expect(diagnosticMessages(doc).some(m => m.includes('registered: sameLabel, similarLabel'))).toBe(true);
        } finally {
            services.Jpipe.unification.setAdditionalMethods([]);
        }
    });

    test('a composition that sets no unifyBy is not asked about one', async () => {
        const doc = await parse(`
            justification A { conclusion c is "C" }
            justification B { conclusion c is "C" }
            justification Composed is refine(A, B) { hook: "c" }
        `);
        expect(diagnosticMessages(doc).some(m => m.includes('unification method'))).toBe(false);
    });
});
