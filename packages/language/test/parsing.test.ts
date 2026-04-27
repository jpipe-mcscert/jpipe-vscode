import { beforeAll, describe, expect, test } from "vitest";
import { EmptyFileSystem, type LangiumDocument } from "langium";
import { parseHelper } from "langium/test";
import type { Unit } from "jpipe-language";
import { createJpipeServices, isUnit, isAbstractSupport, isJustification, isTemplate } from "jpipe-language";

let services: ReturnType<typeof createJpipeServices>;
let parse: ReturnType<typeof parseHelper<Unit>>;

beforeAll(async () => {
    services = createJpipeServices(EmptyFileSystem);
    parse = parseHelper<Unit>(services.Jpipe);
});

function assertValid(document: LangiumDocument<Unit>): Unit {
    expect(document.parseResult.parserErrors).toHaveLength(0);
    expect(isUnit(document.parseResult.value)).toBe(true);
    return document.parseResult.value as Unit;
}

describe('Parsing tests', () => {

    test('parse minimal justification', async () => {
        const doc = await parse(`
            justification J {
                conclusion c is "The claim"
                strategy s is "The strategy"
                evidence e is "The evidence"
                e supports s
                s supports c
            }
        `);
        const unit = assertValid(doc);
        expect(unit.body).toHaveLength(1);
        expect(isJustification(unit.body[0])).toBe(true);
    });

    test('parse template with @support', async () => {
        const doc = await parse(`
            template T {
                conclusion c is "Claim"
                strategy s is "Strategy"
                @support abs is "Abstract leaf"
                abs supports s
                s supports c
            }
        `);
        const unit = assertValid(doc);
        expect(unit.body).toHaveLength(1);
        const t = unit.body[0];
        expect(isTemplate(t)).toBe(true);
        if (!isTemplate(t)) return;
        const abstractElems = t.contents?.body.filter(isAbstractSupport) ?? [];
        expect(abstractElems).toHaveLength(1);
        expect(abstractElems[0].id.parts).toEqual(['abs']);
    });

    test('parse justification implementing template', async () => {
        const doc = await parse(`
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
        const unit = assertValid(doc);
        expect(unit.body).toHaveLength(2);
        const j = unit.body[1];
        expect(isJustification(j)).toBe(true);
        if (!isJustification(j)) return;
        expect(j.parent?.$refText).toBe('T');
    });

    test('parse element with qualified id (override syntax)', async () => {
        const doc = await parse(`
            justification J {
                conclusion c is "Claim"
                evidence t:abs is "Override"
                t:abs supports c
            }
        `);
        const unit = assertValid(doc);
        const j = unit.body[0];
        if (!isJustification(j)) return;
        const ev = j.contents?.body[1];
        expect(ev?.id.parts).toEqual(['t', 'abs']);
        expect(ev?.name).toBe('Override');
    });

    test('parse relation with qualified id endpoints', async () => {
        const doc = await parse(`
            justification J {
                conclusion c is "Claim"
                strategy s is "Strategy"
                evidence t:abs is "Evidence"
                t:abs supports s
                s supports c
            }
        `);
        const unit = assertValid(doc);
        const j = unit.body[0];
        if (!isJustification(j)) return;
        const rel = j.contents?.rels[0];
        expect(rel?.from.$refText).toBe('t:abs');
        expect(rel?.to.$refText).toBe('s');
    });

    test('parse inline operator call', async () => {
        const doc = await parse(`
            template T {
                conclusion c is "Claim"
                @support abs is "Abstract"
                abs supports c
            }
            justification J is refine(T) {
                mapping: "abs=e"
            }
        `);
        const unit = assertValid(doc);
        const j = unit.body[1];
        expect(isJustification(j)).toBe(true);
        if (!isJustification(j)) return;
        expect(j.contents).toBeUndefined();
        expect(j.composition?.operator).toBe('refine');
        expect(j.composition?.params?.refs).toHaveLength(1);
        expect(j.composition?.config?.entries).toHaveLength(1);
        expect(j.composition?.config?.entries[0].key).toBe('mapping');
    });

    test('parse load without alias', async () => {
        const doc = await parse(`
            load "other.jd"
            justification J {
                conclusion c is "Claim"
                strategy s is "Strategy"
                evidence e is "Evidence"
                e supports s
                s supports c
            }
        `);
        const unit = assertValid(doc);
        expect(unit.imports).toHaveLength(1);
        expect(unit.imports[0].path).toBe('other.jd');
        expect(unit.imports[0].namespace).toBeUndefined();
    });

    test('parse load with namespace alias', async () => {
        const doc = await parse(`
            load "base.jd" as base
            justification J {
                conclusion c is "Claim"
                strategy s is "Strategy"
                evidence e is "Evidence"
                e supports s
                s supports c
            }
        `);
        const unit = assertValid(doc);
        expect(unit.imports[0].path).toBe('base.jd');
        expect(unit.imports[0].namespace).toBe('base');
    });

    test('parse multiple models with mixed relations', async () => {
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
                evidence abs is "Concrete"
                abs supports s
                s supports c
            }
        `);
        const unit = assertValid(doc);
        expect(unit.body).toHaveLength(2);
        const j = unit.body[1];
        if (!isJustification(j)) return;
        expect(j.contents?.body).toHaveLength(3);
        expect(j.contents?.rels).toHaveLength(2);
    });
});
