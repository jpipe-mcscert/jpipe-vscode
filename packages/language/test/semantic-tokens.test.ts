/**
 * Semantic highlighting had no tests at all, and it is the kind of feature that fails quietly.
 *
 * Nothing throws when a keyword is given the wrong token type or stops being highlighted: the
 * word simply comes back in a different colour, in an editor nobody is looking at while the
 * change is being made. The grammar is where that breaks — rename a keyword in `jpipe.langium`
 * and `highlightElement` still compiles, still runs, and silently emits nothing for it, because
 * `acceptor({ keyword })` matches by text.
 *
 * So every case here asserts the *type* a keyword is given, and asserts first that the keyword
 * produced a token at all — which is the half a keyword rename breaks.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { highlightHelper } from 'langium/test';
import type { Unit } from 'jpipe-language';
import {
    TOKEN_ABSTRACT,
    TOKEN_ELEMENT,
    TOKEN_LOAD,
    TOKEN_RELATION,
    TOKEN_STRUCTURE,
    createJpipeServices
} from 'jpipe-language';

let highlight: ReturnType<typeof highlightHelper<Unit>>;
let tokenTypes: Record<string, number>;

beforeAll(async () => {
    const services = createJpipeServices(EmptyFileSystem);
    highlight = highlightHelper<Unit>(services.Jpipe);
    tokenTypes = services.Jpipe.lsp.SemanticTokenProvider!.tokenTypes;
});

/**
 * Asserts that `keyword`, wherever it appears in `source`, is highlighted as `type`.
 *
 * Langium's `expectSemanticToken` wants the range marked up in the fixture, which would put a
 * `<|…|>` around every keyword under test and make the models harder to read than the assertion.
 * The decoded tokens carry their own text, so they can simply be looked up by it.
 */
async function expectKeyword(source: string, keyword: string, type: string): Promise<void> {
    const { tokens } = await highlight(source);
    const found = tokens.filter(token => token.text === keyword);
    expect(found.map(token => token.tokenType), `no token for '${keyword}'`).not.toEqual([]);
    expect(new Set(found.map(token => token.tokenType))).toEqual(new Set([type]));
}

const MODEL = `template T implements Base {
    @support a is "A"
    strategy s is "S"
    conclusion c is "C"
    a supports s
    s supports c
}`;

describe('semantic tokens', () => {

    test.each([
        ['load',           'load "other.jd"\ntemplate Base { conclusion c is "C" }', TOKEN_LOAD],
        ['template',       MODEL,                                                   TOKEN_STRUCTURE],
        ['justification',  'justification J { conclusion c is "C" }',                TOKEN_STRUCTURE],
        ['implements',     MODEL,                                                   TOKEN_STRUCTURE],
        ['supports',       MODEL,                                                   TOKEN_RELATION],
        ['@support',       MODEL,                                                   TOKEN_ABSTRACT],
        ['strategy',       MODEL,                                                   TOKEN_ELEMENT],
        ['conclusion',     MODEL,                                                   TOKEN_ELEMENT],
        ['evidence',       'justification J { evidence e is "E" }',                  TOKEN_ELEMENT],
        ['sub-conclusion', 'justification J { sub-conclusion sc is "SC" }',          TOKEN_ELEMENT]
    ])('%s is highlighted as its own kind', async (keyword, source, type) => {
        await expectKeyword(source, keyword, type);
    });

    // `implements` is emitted for both, from two separate branches, and only one of them was
    // reachable from a template.
    test('a justification is structure, and so is the template it implements', async () => {
        const source = 'template T { conclusion c is "C" }\njustification J implements T { conclusion c is "C" }';
        await expectKeyword(source, 'justification', TOKEN_STRUCTURE);
        await expectKeyword(source, 'implements', TOKEN_STRUCTURE);
    });

    /**
     * The custom types have to be *declared* as well as emitted. A token whose type is missing
     * from `tokenTypes` cannot be encoded into the LSP's integer stream, so the whole feature
     * would be broken by an addition that only touched `highlightElement`.
     */
    test('every custom type is declared, and none collides with a standard one', () => {
        const custom = [TOKEN_LOAD, TOKEN_STRUCTURE, TOKEN_RELATION, TOKEN_ABSTRACT, TOKEN_ELEMENT];
        for (const type of custom) {
            expect(tokenTypes[type], `${type} is not declared`).toBeTypeOf('number');
        }
        const indices = Object.values(tokenTypes);
        expect(new Set(indices).size, 'two token types share an index').toBe(indices.length);
    });
});
