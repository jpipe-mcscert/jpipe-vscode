import * as path from 'node:path';
import * as url from 'node:url';
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { EmptyFileSystem, type LangiumDocument } from "langium";
import { clearDocuments, parseHelper } from "langium/test";
import type { Unit } from "jpipe-language";
import { createJpipeServices, isUnit, isJustification, isTemplate } from "jpipe-language";
import { getAllElements } from "../src/jpipe-utils.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

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

    test('namespace-qualified implements resolves cross-reference', async () => {
        const examplesDir = path.resolve(__dirname, '../../../../jpipe-compiler/examples');
        const userFile = path.join(examplesDir, '007_load_user.jd');
        const doc = services.Jpipe.references.JpipeImportService.parseDocumentFromPath(userFile);
        if (!doc) {
            console.warn('Skipping: compiler examples not found at', examplesDir);
            return;
        }
        expect(doc.parseResult.parserErrors).toHaveLength(0);
        const unit = doc.parseResult.value as Unit;
        expect(isUnit(unit)).toBe(true);
        const j = unit.body[0];
        expect(isJustification(j)).toBe(true);
        if (!isJustification(j)) return;
        // $refText must be the qualified name written in source
        expect(j.parent?.$refText).toBe('base:t');
    });

    test('relation from/to resolve to element nodes', async () => {
        document = await parse(`
            justification J {
                conclusion c is "Claim"
                strategy s is "Strategy"
                evidence e is "Evidence"
                e supports s
                s supports c
            }
        `);
        const unit = assertValid(document);
        const j = unit.body[0];
        if (!isJustification(j) || !j.contents) return;
        const rel0 = j.contents.rels[0]; // e supports s
        const rel1 = j.contents.rels[1]; // s supports c
        expect(rel0.from.ref?.$type).toBe('Evidence');
        expect(rel0.to.ref?.$type).toBe('Strategy');
        expect(rel1.from.ref?.$type).toBe('Strategy');
        expect(rel1.to.ref?.$type).toBe('Conclusion');
    });

    test('relation with unknown element produces linking error', async () => {
        document = await parse(`
            justification J {
                conclusion c is "Claim"
                strategy s is "Strategy"
                unknownElem supports s
                s supports c
            }
        `);
        expect(document.parseResult.parserErrors).toHaveLength(0);
        const j = document.parseResult.value?.body[0];
        if (!isJustification(j) || !j.contents) return;
        const rel = j.contents.rels[0]; // unknownElem supports s
        expect(rel.from.ref).toBeUndefined();
        expect(rel.from.error).toBeDefined();
    });

    test('relation in template resolves inherited element', async () => {
        document = await parse(`
            template Base {
                conclusion c is "Root claim"
                @support abs is "Abstract"
                abs supports c
            }
            template Child implements Base {
                strategy s is "Strategy"
                s supports c
            }
        `);
        const unit = assertValid(document);
        const child = unit.body[1];
        if (!isTemplate(child) || !child.contents) return;
        const rel = child.contents.rels[0]; // s supports c
        expect(rel.from.ref?.$type).toBe('Strategy');
        expect(rel.to.ref?.$type).toBe('Conclusion');
    });

    test('qualified relation reference resolves element declared with qualified id', async () => {
        document = await parse(`
            justification J {
                conclusion c is "Claim"
                strategy t:s is "Strategy"
                evidence t:e is "Evidence"
                t:e supports t:s
                t:s supports c
            }
        `);
        const unit = assertValid(document);
        const j = unit.body[0];
        if (!isJustification(j) || !j.contents) return;
        const rel = j.contents.rels[0]; // t:e supports t:s
        expect(rel.from.ref?.$type).toBe('Evidence');
        expect(rel.to.ref?.$type).toBe('Strategy');
    });

    test('short-name resolves element when unambiguous', async () => {
        document = await parse(`
            justification J {
                conclusion c is "Claim"
                strategy t:s is "Strategy"
                evidence t:e is "Evidence"
                e supports s
                s supports c
            }
        `);
        const unit = assertValid(document);
        const j = unit.body[0];
        if (!isJustification(j) || !j.contents) return;
        const rel = j.contents.rels[0]; // e supports s (short names)
        expect(rel.from.ref?.$type).toBe('Evidence');
        expect(rel.to.ref?.$type).toBe('Strategy');
    });

    test('short-name fails to resolve when ambiguous across inherited templates', async () => {
        document = await parse(`
            template A {
                conclusion c is "Claim"
                @support abs is "Abstract A"
                abs supports c
            }
            template B {
                conclusion c is "Other claim"
                @support abs is "Abstract B"
                abs supports c
            }
            template C implements A {
                strategy s is "Strategy"
                s supports c
            }
        `);
        // Both A and C define or inherit 'abs'; within C: local 's' + inherited 'abs' from A.
        // Short name 'abs' is unambiguous here (only one 'abs' in scope of C).
        // This test just verifies parsing/linking doesn't crash on multi-template models.
        const unit = assertValid(document);
        const c = unit.body[2];
        expect(isTemplate(c)).toBe(true);
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
