import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { EmptyFileSystem, type LangiumDocument } from "langium";
import { clearDocuments, parseHelper } from "langium/test";
import type { Unit } from "jpipe-language";
import { createJpipeServices, isUnit, isJustification, isTemplate } from "jpipe-language";
import { getAllElements } from "../src/jpipe-utils.js";

let services: ReturnType<typeof createJpipeServices>;
let parse: ReturnType<typeof parseHelper<Unit>>;
let document: LangiumDocument<Unit> | undefined;

beforeAll(async () => {
    services = createJpipeServices(EmptyFileSystem);
    parse = parseHelper<Unit>(services.Jpipe);
});

afterEach(async () => {
    if (document) clearDocuments(services.shared, [document]);
});

function assertValid(doc: LangiumDocument<Unit>): Unit {
    expect(doc.parseResult.parserErrors).toHaveLength(0);
    expect(isUnit(doc.parseResult.value)).toBe(true);
    return doc.parseResult.value as Unit;
}

describe('Linking tests', () => {

    test('implements resolves known template', async () => {
        document = await parse(`
            template T {
                conclusion c is "Claim"
                @support abs is "Abstract"
                abs supports c
            }
            justification J implements T {
                conclusion c is "Claim"
                evidence abs is "Concrete"
                abs supports c
            }
        `);
        const unit = assertValid(document);
        const j = unit.body[1];
        expect(isJustification(j)).toBe(true);
        if (!isJustification(j)) return;
        expect(j.parent?.ref).toBeDefined();
        expect(j.parent?.ref?.id).toBe('T');
    });

    test('implements unknown template records linking error', async () => {
        document = await parse(`
            justification J implements Unknown {
                conclusion c is "Claim"
                strategy s is "Strategy"
                evidence e is "Evidence"
                e supports s
                s supports c
            }
        `);
        expect(document.parseResult.parserErrors).toHaveLength(0);
        const j = document.parseResult.value?.body[0];
        if (!isJustification(j)) return;
        expect(j.parent?.ref).toBeUndefined();
        expect(j.parent?.error).toBeDefined();
    });

    test('getAllElements traverses inherited template chain', async () => {
        document = await parse(`
            template Base {
                conclusion c is "Claim"
                @support base_abs is "Base abstract"
                base_abs supports c
            }
            template Child implements Base {
                strategy s is "Strategy"
                @support child_abs is "Child abstract"
                child_abs supports s
            }
        `);
        const unit = assertValid(document);
        const child = unit.body[1];
        expect(isTemplate(child)).toBe(true);
        if (!isTemplate(child)) return;

        const allElems = getAllElements(child);
        const names = allElems.map(e => e.id.parts.join(':'));
        expect(names).toContain('s');
        expect(names).toContain('child_abs');
        expect(names).toContain('base_abs');
        expect(names).toContain('c');
    });

    test('template parent reference resolves transitively', async () => {
        document = await parse(`
            template A {
                conclusion c is "Root claim"
                @support abs is "Abstract"
                abs supports c
            }
            template B implements A {
                strategy s is "Strategy"
                s supports c
            }
        `);
        const unit = assertValid(document);
        const b = unit.body[1];
        expect(isTemplate(b)).toBe(true);
        if (!isTemplate(b)) return;
        expect(b.parent?.ref?.id).toBe('A');
    });
});
