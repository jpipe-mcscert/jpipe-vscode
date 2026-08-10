import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ajvModule, { type ValidateFunction } from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, test } from 'vitest';

/**
 * The fixtures are the contract's only enforcement.
 *
 * Nothing emits this format yet, so these documents were transcribed by hand from the text
 * reports the shipped compiler produces. Validating them against the schema is what stops the
 * transcription, the hand-written types and the schema itself from drifting apart — and, once a
 * JSON-capable compiler exists, re-capturing them is the check that the contract survived
 * contact.
 *
 * Full schema validation lives here and *only* here. The extension does not validate at run
 * time: a strict gate would turn a benign additive compiler change into a blank panel, which is
 * the opposite of what the fallback design is for. See `isRenderableReport` for what actually
 * runs in production.
 */

/**
 * ajv ships CommonJS, and this project compiles without `esModuleInterop`, so a default import
 * types as the module namespace while at run time it is the class itself (or sits on `.default`,
 * depending on the loader). Unwrap and name the shape once, here, rather than at the call site.
 */
type Ajv2020Ctor = new (opts: { strict: boolean; allErrors: boolean }) => {
    compile(schema: unknown): ValidateFunction;
};
const Ajv2020 = ((ajvModule as { default?: unknown }).default ?? ajvModule) as Ajv2020Ctor;

const SCHEMA_PATH = join(__dirname, '..', 'schema', 'diagnostic-report.v1.schema.json');
const FIXTURE_DIR = join(__dirname, 'fixtures', 'diagnostic');

const fixtureNames = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json')).sort();

function readFixture(name: string): unknown {
    return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

describe('diagnostic report fixtures', () => {
    let validate: ValidateFunction;

    beforeAll(() => {
        const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
        // `strict: false` because the schema is authored for humans and other consumers, not for
        // ajv's preferences; its `if`/`then` keywords beside `additionalProperties: false` are
        // deliberate and would otherwise be reported as strict-mode violations.
        validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
    });

    test('the fixture set is not silently empty', () => {
        // A rename or a moved directory would otherwise turn this whole file into a no-op that
        // still passes.
        expect(fixtureNames.length).toBeGreaterThanOrEqual(5);
    });

    test.each(fixtureNames)('%s conforms to the schema', name => {
        const valid = validate(readFixture(name));
        expect(validate.errors ?? [], JSON.stringify(validate.errors, null, 2)).toEqual([]);
        expect(valid).toBe(true);
    });
});
