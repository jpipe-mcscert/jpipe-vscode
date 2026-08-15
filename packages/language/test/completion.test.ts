import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument } from 'langium';
import { clearDocuments, expectCompletion, parseHelper } from 'langium/test';
import type { Unit } from 'jpipe-language';
import { createJpipeServices, isUnit, isJustification, isTemplate } from 'jpipe-language';
import { InsertTextFormat } from 'vscode-languageserver';
import { getRelationCandidates, qualifiedIdText } from '../src/jpipe-utils.js';

let services: ReturnType<typeof createJpipeServices>;
let parse: ReturnType<typeof parseHelper<Unit>>;
let checkCompletion: ReturnType<typeof expectCompletion>;
let document: LangiumDocument<Unit> | undefined;

beforeAll(async () => {
    services = createJpipeServices(EmptyFileSystem);
    parse = parseHelper<Unit>(services.Jpipe);
    checkCompletion = expectCompletion(services.Jpipe);
});

afterEach(async () => {
    if (document) await clearDocuments(services.shared, [document]);
    document = undefined;
});

function assertValid(doc: LangiumDocument<Unit>): Unit {
    expect(doc.parseResult.parserErrors).toHaveLength(0);
    expect(isUnit(doc.parseResult.value)).toBe(true);
    return doc.parseResult.value as Unit;
}

// ---------------------------------------------------------------------------
// getRelationCandidates — unit tests (no completion system involved)
// ---------------------------------------------------------------------------

describe('getRelationCandidates utility', () => {

    test('returns all local elements for a standalone justification', async () => {
        document = await parse(`
            justification J {
                evidence e1 is "Evidence"
                strategy s1 is "Strategy"
                conclusion c1 is "Conclusion"
                e1 supports s1
                s1 supports c1
            }
        `);
        const unit = assertValid(document);
        const j = unit.body.find(isJustification);
        expect(j).toBeDefined();
        if (!j) return;

        const ids = getRelationCandidates(j).map(e => qualifiedIdText(e.id));
        expect(ids).toContain('e1');
        expect(ids).toContain('s1');
        expect(ids).toContain('c1');
        expect(ids).toHaveLength(3);
    });

    test('includes @support from parent template', async () => {
        document = await parse(`
            template T {
                conclusion c is "Claim"
                @support abs is "Abstract"
                abs supports c
            }
            justification J implements T {
                evidence e1 is "Evidence"
                conclusion c is "Claim"
                e1 supports c
            }
        `);
        const unit = assertValid(document);
        const j = unit.body.find(isJustification);
        expect(j).toBeDefined();
        if (!j) return;

        const ids = getRelationCandidates(j).map(e => qualifiedIdText(e.id));
        expect(ids).toContain('e1');     // local to J
        expect(ids).toContain('c');      // local to J (overriding T's conclusion)
        expect(ids).toContain('abs');    // @support from T
    });

    test('does NOT include non-abstract inherited elements from parent template', async () => {
        document = await parse(`
            template T {
                strategy s is "Strategy from template"
                conclusion c is "Claim from template"
                @support abs is "Abstract"
                abs supports s
                s supports c
            }
            justification J implements T {
                evidence e1 is "Evidence"
                conclusion c is "My Claim"
                e1 supports c
            }
        `);
        const unit = assertValid(document);
        const j = unit.body.find(isJustification);
        expect(j).toBeDefined();
        if (!j) return;

        const ids = getRelationCandidates(j).map(e => qualifiedIdText(e.id));
        expect(ids).toContain('abs');   // @support — should be included
        expect(ids).not.toContain('s'); // T's strategy — should NOT be included
        // T's 'c' is NOT in the list; only J's local 'c' is
        expect(ids.filter(id => id === 'c')).toHaveLength(1); // only J's own c
    });

    test('includes @support transitively from grandparent template', async () => {
        document = await parse(`
            template GrandParent {
                @support gp_abs is "Grand abstract"
                conclusion c is "Top claim"
                gp_abs supports c
            }
            template Parent implements GrandParent {
                @support p_abs is "Parent abstract"
                conclusion c is "Parent claim"
                p_abs supports c
            }
            justification J implements Parent {
                conclusion c is "My Claim"
            }
        `);
        const unit = assertValid(document);
        const j = unit.body.find(isJustification);
        expect(j).toBeDefined();
        if (!j) return;

        const ids = getRelationCandidates(j).map(e => qualifiedIdText(e.id));
        expect(ids).toContain('p_abs');   // @support from Parent
        expect(ids).toContain('gp_abs');  // @support from GrandParent (transitive)
    });

    test('returns only local elements for a standalone template', async () => {
        document = await parse(`
            template T {
                @support abs is "Abstract"
                conclusion c is "Claim"
                abs supports c
            }
        `);
        const unit = assertValid(document);
        const t = unit.body.find(isTemplate);
        expect(t).toBeDefined();
        if (!t) return;

        const ids = getRelationCandidates(t).map(e => qualifiedIdText(e.id));
        expect(ids).toContain('abs');
        expect(ids).toContain('c');
        expect(ids).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// Completion integration — supports relation (from / to)
// ---------------------------------------------------------------------------

describe('Relation from/to completion', () => {

    // When `from` is resolved, `to` is type-filtered. Evidence → only strategies.
    test('to-completion filters to strategy when from is evidence', async () => {
        await checkCompletion({
            text: `
                justification J {
                    evidence e1 is "Evidence"
                    strategy s1 is "Strategy"
                    conclusion c1 is "Conclusion"
                    e1 supports <|>
                }
            `,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).toContain('s1');
                expect(labels).not.toContain('c1');
                expect(labels).not.toContain('e1');
            }
        });
    });

    // @support from a parent template is a valid FROM element (supports strategy).
    test('@support from parent template can appear as from in a relation', async () => {
        await checkCompletion({
            text: `
                template T {
                    @support abs is "Abstract"
                    strategy s1 is "Strategy"
                    conclusion c is "Claim"
                    abs supports s1
                    s1 supports c
                }
                justification J implements T {
                    strategy s1 is "Strategy"
                    conclusion c is "Claim"
                    abs supports <|>
                }
            `,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                // abs is @support so to must be strategy
                expect(labels).toContain('s1');
                expect(labels).not.toContain('c');
            }
        });
    });

    // Non-abstract inherited elements (not @support) from the parent template must not
    // appear as cross-reference candidates in the child's relation body.
    test('to-completion excludes inherited non-abstract elements from parent template', async () => {
        await checkCompletion({
            text: `
                template T {
                    strategy s is "Template strategy"
                    @support abs is "Abstract"
                    conclusion c is "Claim"
                    abs supports s
                    s supports c
                }
                justification J implements T {
                    strategy s is "Strategy"
                    conclusion c is "Claim"
                    s supports <|>
                }
            `,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                // strategy → to must be sub-conclusion or conclusion; 'c' is local conclusion
                expect(labels).toContain('c');
                // T's 's' is not in J's local scope for cross-reference
                expect(labels).not.toContain('s');
                expect(labels).not.toContain('e1');
            }
        });
    });
});

// ---------------------------------------------------------------------------
// Completion integration — operator calls
// ---------------------------------------------------------------------------

describe('Operator completion', () => {

    test('suggests known operator names after "is" (not justification/template names)', async () => {
        await checkCompletion({
            text: `
                template MyTemplate {
                    conclusion c is "Claim"
                }
                justification MyJ {
                    conclusion c is "Claim"
                }
                justification Composed is <|>
            `,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).toContain('assemble');
                expect(labels).toContain('refine');
                expect(labels).not.toContain('MyTemplate');
                expect(labels).not.toContain('MyJ');
            }
        });
    });

    test('filters operator suggestions by partial input', async () => {
        await checkCompletion({
            text: `
                justification Composed is ass<|>
            `,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).toContain('assemble');
                expect(labels).not.toContain('refine');
            }
        });
    });

    test('suggests config keys for assemble operator', async () => {
        await checkCompletion({
            text: `
                justification A { conclusion c is "C" }
                justification Composed is assemble(A) { <|>
            `,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).toContain('conclusionLabel');
                expect(labels).toContain('strategyLabel');
                expect(labels).not.toContain('hook');
            }
        });
    });

    test('suggests config keys for refine operator', async () => {
        await checkCompletion({
            text: `
                template T { conclusion c is "C" }
                justification Composed is refine(T) { <|>
            `,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).toContain('hook');
                expect(labels).not.toContain('conclusionLabel');
                expect(labels).not.toContain('strategyLabel');
            }
        });
    });

    // Nothing covered this until the pattern that extracts the typed prefix was fixed. It used
    // to yield the empty string in every case — `[^}]*` was greedy and reached the end before
    // `(\w*)` was tried — so the filter below it never ran and the editor was handed the whole
    // key list to sort out client-side.
    test('filters the config keys by what has already been typed', async () => {
        await checkCompletion({
            text: `
                justification A { conclusion c is "C" }
                justification Composed is assemble(A) { conc<|>
            `,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).toContain('conclusionLabel');
                expect(labels).not.toContain('strategyLabel');
            }
        });
    });

    // The Unifier reads these from every composition's config, so they belong to no single
    // operator — and were offered by neither before the operator tables were unified.
    test('suggests the unification keys for every operator', async () => {
        for (const text of [
            `justification A { conclusion c is "C" }
             justification Composed is assemble(A) { <|>`,
            `template T { conclusion c is "C" }
             justification Composed is refine(T) { <|>`
        ]) {
            await checkCompletion({
                text,
                index: 0,
                assert: (completions) => {
                    const labels = completions.items.map(i => i.label);
                    expect(labels).toContain('unifyBy');
                    expect(labels).toContain('unifyExclude');
                }
            });
        }
    });
});

// ---------------------------------------------------------------------------
// Completion integration — type-aware relation filtering
// ---------------------------------------------------------------------------

describe('Type-aware supports relation completion', () => {

    test('evidence can only support strategy (to-completion)', async () => {
        await checkCompletion({
            text: `
                justification J {
                    evidence e1 is "Evidence"
                    strategy s1 is "Strategy"
                    conclusion c1 is "Conclusion"
                    e1 supports <|>
                }
            `,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).toContain('s1');
                expect(labels).not.toContain('c1');
                expect(labels).not.toContain('e1');
            }
        });
    });

    test('@support can only support strategy (to-completion)', async () => {
        await checkCompletion({
            text: `
                template T {
                    @support abs is "Abstract"
                    strategy s1 is "Strategy"
                    conclusion c1 is "Conclusion"
                    abs supports <|>
                }
            `,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).toContain('s1');
                expect(labels).not.toContain('c1');
                expect(labels).not.toContain('abs');
            }
        });
    });

    test('sub-conclusion can only support strategy (to-completion)', async () => {
        await checkCompletion({
            text: `
                justification J {
                    sub-conclusion sc1 is "Sub"
                    strategy s1 is "Strategy"
                    conclusion c1 is "Conclusion"
                    sc1 supports <|>
                }
            `,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).toContain('s1');
                expect(labels).not.toContain('c1');
                expect(labels).not.toContain('sc1');
            }
        });
    });

    test('strategy can only support sub-conclusion or conclusion (to-completion)', async () => {
        await checkCompletion({
            text: `
                justification J {
                    evidence e1 is "Evidence"
                    strategy s1 is "Strategy"
                    sub-conclusion sc1 is "Sub"
                    conclusion c1 is "Conclusion"
                    s1 supports <|>
                }
            `,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).toContain('sc1');
                expect(labels).toContain('c1');
                expect(labels).not.toContain('e1');
                expect(labels).not.toContain('s1');
            }
        });
    });

    // from-completion filtering (filterRelationSources) requires the parser to resolve
    // the `to` cross-reference during error recovery, which is not guaranteed in the
    // `<|> supports X` pattern. The bidirectional filter is covered implicitly through
    // to-completion: the same type rules prevent illegal from→to pairs in both directions.
    test('conclusion can only be reached from a strategy (to-completion)', async () => {
        await checkCompletion({
            text: `
                justification J {
                    evidence e1 is "Evidence"
                    strategy s1 is "Strategy"
                    conclusion c1 is "Conclusion"
                    s1 supports <|>
                }
            `,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).toContain('c1');
                expect(labels).not.toContain('e1');
                expect(labels).not.toContain('s1');
            }
        });
    });

    test('sub-conclusion can only be reached from a strategy (to-completion)', async () => {
        await checkCompletion({
            text: `
                justification J {
                    evidence e1 is "Evidence"
                    strategy s1 is "Strategy"
                    sub-conclusion sc1 is "Sub"
                    conclusion c1 is "Conclusion"
                    s1 supports <|>
                }
            `,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).toContain('sc1');
                expect(labels).toContain('c1');
                expect(labels).not.toContain('e1');
                expect(labels).not.toContain('s1');
            }
        });
    });
});

// ---------------------------------------------------------------------------
// Completion integration — load path
// ---------------------------------------------------------------------------

describe('Load path completion', () => {

    test('lists .jd files from the document directory', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'models.jd'), '');
            fs.writeFileSync(path.join(tmpDir, 'base.jd'), '');
            fs.writeFileSync(path.join(tmpDir, 'readme.txt'), '');

            await checkCompletion({
                text: `load "<|>"`,
                index: 0,
                parseOptions: { documentUri: pathToFileURL(path.join(tmpDir, 'test.jd')).toString() },
                assert: (completions) => {
                    const labels = completions.items.map(i => i.label);
                    expect(labels.some(l => l.endsWith('models.jd'))).toBe(true);
                    expect(labels.some(l => l.endsWith('base.jd'))).toBe(true);
                    expect(labels.every(l => !l.endsWith('.txt'))).toBe(true);
                }
            });
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });

    test('includes subdirectories in load path completion', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpipe-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'models.jd'), '');
            fs.mkdirSync(path.join(tmpDir, 'templates'));

            await checkCompletion({
                text: `load "<|>"`,
                index: 0,
                parseOptions: { documentUri: pathToFileURL(path.join(tmpDir, 'test.jd')).toString() },
                assert: (completions) => {
                    const labels = completions.items.map(i => i.label);
                    expect(labels.some(l => l.includes('templates'))).toBe(true);
                }
            });
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });

    test('returns no completions when cursor is not inside a load string', async () => {
        await checkCompletion({
            text: `
                justification J {
                    evidence e1 is "Evidence"
                    <|>
                }
            `,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels.every(l => !l.endsWith('.jd'))).toBe(true);
            }
        });
    });
});

describe('Operator invocation completion', () => {

    // The operator's name alone leaves three things still to look up: how many source models it
    // takes and in what order, which config keys it cannot run without, and that an empty `{}`
    // does not parse. Completing the whole invocation answers all three at once.
    test('writes the whole invocation, not just the name', async () => {
        await checkCompletion({
            text: `
                justification A { conclusion c is "C" }
                justification B is <|>
            `,
            index: 0,
            assert: (completions) => {
                const refine = completions.items.find(i => i.label === 'refine');
                expect(refine?.insertTextFormat).toBe(InsertTextFormat.Snippet);
                expect(refine?.insertText).toContain('refine(${1:base}, ${2:refinement})');
                expect(refine?.insertText).toContain('hook: "${3}"');
            }
        });
    });

    // `refine(a, b)` reads very differently from `refine(base, refinement)`, and the order is not
    // interchangeable, so the placeholders are named rather than numbered.
    test('names the source models in order', async () => {
        await checkCompletion({
            text: `
                justification A { conclusion c is "C" }
                justification B is <|>
            `,
            index: 0,
            assert: (completions) => {
                const assemble = completions.items.find(i => i.label === 'assemble');
                expect(assemble?.insertText).toContain('assemble(${1:model})');
                expect(assemble?.insertText).toContain('conclusionLabel');
                expect(assemble?.insertText).toContain('strategyLabel');
            }
        });
    });

    test('shows what will be inserted before it is accepted', async () => {
        await checkCompletion({
            text: `
                justification A { conclusion c is "C" }
                justification B is <|>
            `,
            index: 0,
            assert: (completions) => {
                const refine = completions.items.find(i => i.label === 'refine');
                const documentation = refine?.documentation as { value?: string } | undefined;
                expect(documentation?.value).toContain('refine(base, refinement)');
                expect(documentation?.value).toContain('hook: ""');
            }
        });
    });

    // An invocation written into an indented model has to line up with it.
    test('follows the indentation of the line it is written on', async () => {
        await checkCompletion({
            text: `
                justification A { conclusion c is "C" }
                    justification B is <|>
            `,
            index: 0,
            assert: (completions) => {
                const refine = completions.items.find(i => i.label === 'refine');
                // The fixture indents by twenty spaces, plus four more for the model itself.
                expect(refine?.insertText).toContain('\n                        hook:');
            }
        });
    });
});

describe('Composition source completion', () => {

    const MODELS = `justification alpha { conclusion c is "C" }
justification beta { conclusion c is "C" }
justification gamma { conclusion c is "C" }`;

    // Composing `x` out of `x` is circular, and `x` is the one name guaranteed to be on the tip
    // of the author's fingers — so without this it sits near the top of the list.
    test('does not offer the model being defined', async () => {
        await checkCompletion({
            text: `${MODELS}\njustification composed is assemble(<|>)`,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).not.toContain('composed');
                expect(labels).toContain('alpha');
            }
        });
    });

    test('does not offer a model already named in the same call', async () => {
        await checkCompletion({
            text: `${MODELS}\njustification composed is assemble(alpha, <|>)`,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).not.toContain('alpha');
                expect(labels).toContain('beta');
                expect(labels).toContain('gamma');
            }
        });
    });

    test('drops every model already used, not just the last', async () => {
        await checkCompletion({
            text: `${MODELS}\njustification composed is assemble(alpha, beta, <|>)`,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).not.toContain('alpha');
                expect(labels).not.toContain('beta');
                expect(labels).toContain('gamma');
            }
        });
    });

    // The slot being completed holds partial text of its own; treating that as "already used"
    // would remove the very candidate being typed towards.
    test('still offers a model matching what is being typed in this slot', async () => {
        await checkCompletion({
            text: `${MODELS}\njustification composed is assemble(al<|>)`,
            index: 0,
            assert: (completions) => {
                expect(completions.items.map(i => i.label)).toContain('alpha');
            }
        });
    });

    test('a template is still offered as a source', async () => {
        await checkCompletion({
            text: `template t { @support a is "A" conclusion c is "C" a supports c }\njustification composed is assemble(<|>)`,
            index: 0,
            assert: (completions) => {
                expect(completions.items.map(i => i.label)).toContain('t');
            }
        });
    });
});

describe('Hook value completion', () => {

    // `hook` is a plain string in the grammar: nothing links it, nothing validates it, and until
    // now nothing offered it, so the only way to find a legal value was to read the model.
    // `refine` replaces the hooked element with a sub-conclusion carrying the refinement's whole
    // argument. That makes sense done to a leaf and not to anything else, so only evidence is
    // offered — the compiler resolves the hook by id and does not check its type, so this narrows
    // the suggestion rather than the rule.
    test('offers the evidence of the first source model, and nothing else', async () => {
        await checkCompletion({
            text: `
                justification Base {
                    conclusion c is "C"
                    strategy s is "S"
                    evidence e is "E"
                    sub-conclusion sc is "SC"
                    e supports s
                    s supports c
                }
                justification Ref { conclusion rc is "RC" }
                justification Composed is refine(Base, Ref) { hook: "<|>" }
            `,
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).toContain('e');
                expect(labels).not.toContain('c');
                expect(labels).not.toContain('s');
                expect(labels).not.toContain('sc');
                // The hook names an element of the first source, not the second.
                expect(labels).not.toContain('rc');
            }
        });
    });

    // An id like `e` says nothing on its own; the label is what tells them apart.
    test('shows each candidate label beside its id', async () => {
        await checkCompletion({
            text: `
                justification Base {
                    conclusion c is "C"
                    strategy s is "S"
                    evidence tests is "The suite is green"
                    tests supports s
                    s supports c
                }
                justification Ref { conclusion rc is "RC" }
                justification Composed is refine(Base, Ref) { hook: "<|>" }
            `,
            index: 0,
            assert: (completions) => {
                const item = completions.items.find(i => i.label === 'tests');
                expect(item).toBeDefined();
                expect(item?.labelDetails?.detail).toContain('The suite is green');
                // The id is still what gets inserted.
                expect((item?.textEdit as { newText?: string })?.newText).toBe('tests');
            }
        });
    });

    // The scan between `{` and the key must not stop at an earlier quoted value, or a key written
    // after any other key is never completed.
    test('still offers hooks when another config key comes first', async () => {
        await checkCompletion({
            text: `
                justification Base {
                    conclusion c is "C"
                    strategy s is "S"
                    evidence e is "E"
                    e supports s
                    s supports c
                }
                justification Ref { conclusion rc is "RC" }
                justification Composed is refine(Base, Ref) { unifyBy: "sameLabel" hook: "<|>" }
            `,
            index: 0,
            assert: (completions) => {
                expect(completions.items.map(i => i.label)).toContain('e');
            }
        });
    });

    test('offers nothing for assemble, which has no hook', async () => {
        await checkCompletion({
            text: `
                justification Base { conclusion c is "C" }
                justification Composed is assemble(Base) { conclusionLabel: "<|>" }
            `,
            index: 0,
            assert: (completions) => {
                expect(completions.items.map(i => i.label)).not.toContain('c');
            }
        });
    });
});

describe('Unification method completion', () => {

    const composed = (partial: string) => `
        justification A { conclusion c is "C" }
        justification B { conclusion c is "C" }
        justification Composed is refine(A, B) { hook: "c" unifyBy: "${partial}<|>" }
    `;

    test('offers what jPipe ships, marked as core', async () => {
        await checkCompletion({
            text: composed(''),
            index: 0,
            assert: (completions) => {
                const item = completions.items.find(i => i.label === 'sameLabel');
                expect(item).toBeDefined();
                expect(item?.detail).toBe('jPipe core');
            }
        });
    });

    // The two halves mean different things: one is what jPipe ships, the other is what this
    // workspace has been told its build registers.
    test('offers declared relations, marked as declared', async () => {
        services.Jpipe.unification.setAdditionalMethods(['similarLabel']);
        try {
            await checkCompletion({
                text: composed(''),
                index: 0,
                assert: (completions) => {
                    const item = completions.items.find(i => i.label === 'similarLabel');
                    expect(item).toBeDefined();
                    expect(item?.detail).toBe('declared in settings');
                }
            });
        } finally {
            services.Jpipe.unification.setAdditionalMethods([]);
        }
    });

    test('puts the core relations first', async () => {
        services.Jpipe.unification.setAdditionalMethods(['aaaCustom']);
        try {
            await checkCompletion({
                text: composed(''),
                index: 0,
                assert: (completions) => {
                    const sorted = [...completions.items]
                        .sort((a, b) => String(a.sortText).localeCompare(String(b.sortText)))
                        .map(i => i.label);
                    expect(sorted[0]).toBe('sameLabel');
                }
            });
        } finally {
            services.Jpipe.unification.setAdditionalMethods([]);
        }
    });

    test('says which one applies when unifyBy is left out', async () => {
        await checkCompletion({
            text: composed(''),
            index: 0,
            assert: (completions) => {
                const item = completions.items.find(i => i.label === 'sameLabel');
                expect(String(item?.documentation)).toContain('sets no unifyBy');
            }
        });
    });

    test('is not offered for another config value', async () => {
        await checkCompletion({
            text: `
                justification A { conclusion c is "C" }
                justification B { conclusion c is "C" }
                justification Composed is refine(A, B) { hook: "<|>" }
            `,
            index: 0,
            assert: (completions) => {
                expect(completions.items.map(i => i.label)).not.toContain('sameLabel');
            }
        });
    });
});

/**
 * What the provider *suppresses*, which is most of what makes it feel like it understands jPipe.
 *
 * Every case here is a branch that had no test: offering `is` where a label cannot go, offering
 * ordinary keywords after `@`, or offering the wrong side of a relation. None of them throws when
 * it regresses — the list simply fills up with things that do not belong, which is exactly the
 * state the provider exists to prevent, and exactly the state nothing was checking for.
 */
describe('Keyword filtering', () => {

    test('`is` is offered once an element has been named', async () => {
        await checkCompletion({
            text: 'justification J {\n evidence e <|>\n}',
            index: 0,
            assert: (completions) => {
                expect(completions.items.map(i => i.label)).toContain('is');
            }
        });
    });

    // A qualified override is named the same way, and the regex has to allow the colon.
    test('`is` is offered after a qualified override id', async () => {
        await checkCompletion({
            text: 'template T {\n @support a is "A"\n}\njustification J implements T {\n evidence T:a <|>\n}',
            index: 0,
            assert: (completions) => {
                expect(completions.items.map(i => i.label)).toContain('is');
            }
        });
    });

    // A relation takes an element, never a label, so `is` on that line is always wrong.
    test('`is` is withheld after `supports`', async () => {
        await checkCompletion({
            text: 'justification J {\n evidence e is "E"\n strategy s is "S"\n e supports <|>\n}',
            index: 0,
            assert: (completions) => {
                expect(completions.items.map(i => i.label)).not.toContain('is');
            }
        });
    });

    test('`is` is withheld before an element has a name', async () => {
        await checkCompletion({
            text: 'justification J {\n evidence <|>\n}',
            index: 0,
            assert: (completions) => {
                expect(completions.items.map(i => i.label)).not.toContain('is');
            }
        });
    });
});

/**
 * Typing `@` is an unambiguous statement of intent: the only thing in the grammar that starts
 * with it is `@support`. Everything else is withheld, and the insertion has to replace the `@`
 * already typed rather than append to it — which is what `buildCompletionTextEdit` is for, and
 * what the second case pins.
 */
describe('The @ prefix', () => {

    test('offers @support and nothing else', async () => {
        await checkCompletion({
            text: 'template T {\n @<|>\n}',
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label);
                expect(labels).toContain('@support');
                expect(labels.filter(label => !label.startsWith('@'))).toEqual([]);
            }
        });
    });

    // The bug this pins: `@support` is a keyword, so a lone `@` matches no token and the default
    // edit inserted beside it, giving `@@support` from the one keystroke that could not have been
    // clearer about what was meant.
    test.each([
        ['a lone @', 'template T {\n @<|>\n}', 1],
        ['a partly typed @su', 'template T {\n @su<|>\n}', 1]
    ])('replaces %s instead of inserting beside it', async (_name, text, startCharacter) => {
        await checkCompletion({
            text,
            index: 0,
            assert: (completions) => {
                const item = completions.items.find(i => i.label === '@support');
                expect(item?.textEdit, '@support is not offered').toBeDefined();
                const edit = item!.textEdit as { range: { start: { character: number } }; newText: string };
                expect(edit.newText.startsWith('@support')).toBe(true);
                expect(edit.range.start.character, 'the edit must open on the @').toBe(startCharacter);
            }
        });
    });

    /**
     * Two mechanisms can produce this item: the keyword pipeline, and the hand-built fallback in
     * `tryAtSupportKeywordCompletion` that fills in when the pipeline offers nothing. They must
     * agree, because which one answers depends on how much has been typed — and the fallback was
     * *shadowed* by the pipeline's broken edit, so the one case that looked right in the code was
     * the one the user never got.
     */
    test.each([
        ['@<|>', 1],
        ['@s<|>', 1],
        ['@zzz<|>', 1]
    ])('whichever mechanism answers %s, the edit opens on the @', async (typed, startCharacter) => {
        await checkCompletion({
            text: `template T {\n ${typed}\n}`,
            index: 0,
            assert: (completions) => {
                const item = completions.items.find(i => i.label === '@support');
                expect(item?.textEdit, '@support is not offered').toBeDefined();
                const edit = item!.textEdit as { range: { start: { character: number } } };
                expect(edit.range.start.character).toBe(startCharacter);
            }
        });
    });
});

/**
 * `implements` is the one place this provider deliberately consults the workspace index rather
 * than staying inside what the file loads, so a template can be offered before the `load` that
 * would make it resolve exists. Local templates come first, then loaded ones, and a name is
 * offered once however many times it is reachable.
 */
describe('implements completion', () => {

    test('offers a template declared in the same file', async () => {
        await checkCompletion({
            text: 'template T { conclusion c is "C" }\njustification J implements <|>',
            index: 0,
            assert: (completions) => {
                expect(completions.items.map(i => i.label)).toContain('T');
            }
        });
    });

    test('offers each name once, however many ways it is reachable', async () => {
        await checkCompletion({
            text: 'template T { conclusion c is "C" }\njustification J implements <|>',
            index: 0,
            assert: (completions) => {
                const labels = completions.items.map(i => i.label).filter(label => label === 'T');
                expect(labels).toHaveLength(1);
            }
        });
    });
});
