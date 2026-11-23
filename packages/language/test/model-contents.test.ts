import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import type { Justification, Template, Unit } from 'jpipe-language';
import { createJpipeServices } from 'jpipe-language';
import {
    hookTarget, listedIn, ModelContents, type Contents, type ContentsSource
} from '../src/jpipe-model-contents.js';

/**
 * The one question every rule and provider asks of a model's elements (jpipe-vscode ADR-VSC-0034,
 * #131): which implementation answers it, and what a consumer may conclude from each answer.
 */

const here = path.dirname(url.fileURLToPath(import.meta.url));

let parse: (input: string) => Promise<Unit>;

beforeAll(() => {
    const services = createJpipeServices(EmptyFileSystem);
    const doParse = parseHelper<Unit>(services.Jpipe);
    parse = async (input: string) => (await doParse(input)).parseResult.value;
});

const modelNamed = (unit: Unit, name: string): Justification | Template =>
    unit.body.find(model => model.id === name)!;

const ids = (contents: Contents): string[] => listedIn(contents).map(entry => entry.id);

const TEMPLATE = `template T {
    conclusion c is "C"
    strategy s is "S"
    @support a is "A"
    a supports s
    s supports c
}`;

/** A compiled source that records what it was asked, and answers with whole contents. */
class Recording implements ContentsSource {
    readonly asked: string[] = [];
    async contentsOf(model: Justification | Template): Promise<Contents> {
        this.asked.push(model.id);
        return { kind: 'elements', elements: [] };
    }
}

describe('the contents of a model', () => {

    test('of a plain chain are its declared elements, under the ids the compiler gives them', async () => {
        const unit = await parse(`${TEMPLATE}
justification J implements T { evidence T:a is "Done" }`);
        const contents = await new ModelContents().contentsOf(modelNamed(unit, 'J'));
        expect(contents.kind).toBe('elements');
        expect(ids(contents)).toEqual(['T:c', 'T:s', 'T:a']);
        // The override replaces the @support it overrides.
        expect(listedIn(contents).find(entry => entry.id === 'T:a')!.element.$type).toBe('Evidence');
    });

    test('of a chain reaching a composition are asked of the compiled implementation, and of no other', async () => {
        const unit = await parse(`${TEMPLATE}
justification P { conclusion c is "C" strategy s is "S" evidence e is "E" e supports s s supports c }
template R is refine(T, P) { hook: "a" }
justification K implements R { evidence extra is "X" }`);
        const declared = new Recording();
        const compiled = new Recording();
        const contents = new ModelContents(declared, compiled);
        await contents.contentsOf(modelNamed(unit, 'K'));
        await contents.contentsOf(modelNamed(unit, 'R'));
        await contents.contentsOf(modelNamed(unit, 'T'));
        expect(compiled.asked).toEqual(['K', 'R']);
        expect(declared.asked).toEqual(['T']);
    });

    // Until the compiler is asked (#132), compiled contents cannot tell, and show what the bodies do.
    test('of a chain reaching a composition cannot tell, for now, and list what the bodies show', async () => {
        const unit = await parse(`${TEMPLATE}
justification P { conclusion c is "C" strategy s is "S" evidence e is "E" e supports s s supports c }
template R is refine(T, P) { hook: "a" }
justification K implements R { evidence extra is "X" }`);
        const contents = await new ModelContents().contentsOf(modelNamed(unit, 'K'));
        expect(contents.kind).toBe('cannot-tell');
        expect(ids(contents)).toEqual(['extra']);
    });

    test('of a chain that does not resolve cannot tell', async () => {
        const unit = await parse('justification J implements Missing { evidence e is "E" }');
        const contents = await new ModelContents(new Recording(), new Recording()).contentsOf(modelNamed(unit, 'J'));
        expect(contents.kind).toBe('cannot-tell');
        expect(ids(contents)).toEqual(['e']);
    });

    test('of a chain that loops cannot tell, and is asked of neither implementation', async () => {
        const unit = await parse(`template A implements B { @support a is "A" }
template B implements A { @support b is "B" }`);
        const declared = new Recording();
        const compiled = new Recording();
        const contents = await new ModelContents(declared, compiled).contentsOf(modelNamed(unit, 'A'));
        expect(contents.kind).toBe('cannot-tell');
        expect([...declared.asked, ...compiled.asked]).toEqual([]);
    });
});

describe('a refine hook, read on contents', () => {

    const element = (id: string) => ({ $type: 'Evidence', id: { parts: id.split(':') } }) as never;
    const whole = (...list: string[]): Contents =>
        ({ kind: 'elements', elements: list.map(id => ({ id, element: element(id) })) });
    const partial = (...list: string[]): Contents =>
        ({ kind: 'cannot-tell', visible: list.map(id => ({ id, element: element(id) })) });

    test('names an element by its exact id, or by its last segments when the contents are whole', () => {
        expect(hookTarget(whole('T:a', 'e'), 'T:a')).toBeDefined();
        expect(hookTarget(whole('T:a', 'e'), 'a')).toBeDefined();
        expect(hookTarget(whole('T:a', 'e'), 'b')).toBeUndefined();
    });

    // A hidden element may end the same way, and the compiler scans those first.
    test('names one only by its exact id when the contents cannot tell', () => {
        expect(hookTarget(partial('T:a'), 'T:a')).toBeDefined();
        expect(hookTarget(partial('T:a'), 'a')).toBeUndefined();
    });
});

/**
 * No rule or provider reads a model's element list around the contents API: that is the bypass
 * jpipe-vscode ADR-VSC-0034 forbids, and the one that let rules judge composed models they could
 * not see (#126). The helpers stay for the declared implementation, and for linking, which
 * Langium runs synchronously while it builds documents, before any answer could be awaited.
 */
describe('the element helpers', () => {

    const HELPERS = /\b(getAllElements|expandedElements|cannotSeeAllElements)\b/;
    const ALLOWED: Record<string, string> = {
        'jpipe-utils.ts': 'defines them',
        'jpipe-model-contents.ts': 'is the declared implementation',
        'jpipe-scope.ts': 'links references, synchronously',
        'jpipe-import.ts': 'gives the scope its inherited elements, synchronously'
    };

    function sources(dir: string): string[] {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) return entry.name === 'generated' ? [] : sources(full);
            return entry.name.endsWith('.ts') ? [full] : [];
        });
    }

    test('are imported by no rule or provider', () => {
        const src = path.join(here, '..', 'src');
        const importing = sources(src)
            .filter(file => !(path.basename(file) in ALLOWED))
            .filter(file => [...fs.readFileSync(file, 'utf8').matchAll(/^import\s*\{([^}]*)\}\s*from\s+['"][^'"]*jpipe-utils\.js['"]/gm)]
                .some(match => HELPERS.test(match[1])))
            .map(file => path.relative(src, file));
        expect(importing, 'read the model through ModelContents instead').toEqual([]);
    });
});
