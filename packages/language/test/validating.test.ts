import { beforeAll, describe, expect, test } from "vitest";
import { EmptyFileSystem, type LangiumDocument } from "langium";
import { parseHelper } from "langium/test";
import type { Diagnostic } from "vscode-languageserver-types";
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
    return (document.diagnostics ?? []).map((d: Diagnostic) => d.message);
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

    test('template with no @support triggers warning', async () => {
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
        expect(messages.some(m => m.includes('has no @support elements'))).toBe(true);
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
});
