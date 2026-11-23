import { describe, expect, test } from 'vitest';
import { CompilerVerdicts } from '../src/extension/compiler/compiler-verdicts.js';
import type { CompilerVerdict } from '../src/extension/requirements.js';

/**
 * What ImageGenerator keeps about each compiler (#119), one entry where there were three maps.
 * `judge` stands in for parsing the version: it counts its calls, so a test can tell an answer
 * read from the cache from one drawn afresh.
 */

const COMMAND = 'jpipe';
const SUPPORTED: CompilerVerdict = { kind: 'supported', version: '4.0.0' };
const TOO_OLD: CompilerVerdict = { kind: 'too-old', version: '2.0.0' };

function judging(verdicts: Record<string, CompilerVerdict>) {
    const calls: string[] = [];
    const judge = (output: string): CompilerVerdict => {
        calls.push(output);
        return verdicts[output] ?? { kind: 'unknown' };
    };
    return { judge, calls };
}

describe('the verdict kept for a compiler', () => {

    test('is nothing until the compiler is asked', () => {
        expect(new CompilerVerdicts().cached(COMMAND)).toBeUndefined();
    });

    test('is a usable answer, kept until it is forgotten', () => {
        const verdicts = new CompilerVerdicts();
        const { judge } = judging({ 'jPipe 4.0.0': SUPPORTED });
        expect(verdicts.answer(COMMAND, 'jPipe 4.0.0', judge)).toEqual(SUPPORTED);
        expect(verdicts.cached(COMMAND)).toEqual(SUPPORTED);
        verdicts.forget(COMMAND);
        expect(verdicts.cached(COMMAND)).toBeUndefined();
    });

    test('is kept by command: another build is asked on its own', () => {
        const verdicts = new CompilerVerdicts();
        verdicts.answer(COMMAND, 'jPipe 4.0.0', judging({ 'jPipe 4.0.0': SUPPORTED }).judge);
        expect(verdicts.cached('java -jar other.jar')).toBeUndefined();
    });

    // Output that does not read as a version is a fact about the build too.
    test('is kept when the output reads as no version', () => {
        const verdicts = new CompilerVerdicts();
        verdicts.answer(COMMAND, 'something else', judging({}).judge);
        expect(verdicts.cached(COMMAND)).toEqual({ kind: 'unknown' });
    });

    // The failure may be passing, a cold JVM over the timeout.
    test('is not kept when the compiler could not be asked, which lets it through', () => {
        const verdicts = new CompilerVerdicts();
        expect(verdicts.answer(COMMAND, undefined, judging({}).judge)).toEqual({ kind: 'unknown' });
        expect(verdicts.cached(COMMAND)).toBeUndefined();
    });
});

describe('a compiler refused as too old', () => {

    // Its user's next step is to update it, often in place, under the same command.
    test('is asked again at every use', () => {
        const verdicts = new CompilerVerdicts();
        verdicts.answer(COMMAND, 'jPipe 2.0.0', judging({ 'jPipe 2.0.0': TOO_OLD }).judge);
        expect(verdicts.cached(COMMAND)).toBeUndefined();
    });

    test('stays refused while it answers the same, and is judged afresh once updated', () => {
        const verdicts = new CompilerVerdicts();
        const { judge, calls } = judging({ 'jPipe 2.0.0': TOO_OLD, 'jPipe 4.0.0': SUPPORTED });
        verdicts.answer(COMMAND, 'jPipe 2.0.0', judge);
        expect(verdicts.answer(COMMAND, 'jPipe 2.0.0', judge)).toEqual(TOO_OLD);
        // Judged at each ask, as it always was: the same answer gives the same verdict.
        expect(calls).toEqual(['jPipe 2.0.0', 'jPipe 2.0.0']);
        expect(verdicts.answer(COMMAND, 'jPipe 4.0.0', judge)).toEqual(SUPPORTED);
        expect(verdicts.cached(COMMAND)).toEqual(SUPPORTED);
    });

    test('stays refused when it is forgotten, as Check jPipe Installation does', () => {
        const verdicts = new CompilerVerdicts();
        const { judge } = judging({ 'jPipe 2.0.0': TOO_OLD });
        verdicts.answer(COMMAND, 'jPipe 2.0.0', judge);
        verdicts.forget(COMMAND);
        expect(verdicts.answer(COMMAND, 'jPipe 2.0.0', judge)).toEqual(TOO_OLD);
    });
});

describe('a compiler that rejected diagnostic -f json', () => {

    test('is refused, without a version, though its version said it was recent enough', () => {
        const verdicts = new CompilerVerdicts();
        const { judge, calls } = judging({ 'jPipe 4.0.0': SUPPORTED });
        verdicts.answer(COMMAND, 'jPipe 4.0.0', judge);
        verdicts.rejectJson(COMMAND);
        expect(verdicts.cached(COMMAND)).toBeUndefined();
        expect(verdicts.answer(COMMAND, 'jPipe 4.0.0', judge)).toEqual({ kind: 'too-old', version: undefined });
        expect(calls).toEqual(['jPipe 4.0.0']);
    });

    test('is judged afresh once it answers differently', () => {
        const verdicts = new CompilerVerdicts();
        const { judge } = judging({ 'jPipe 4.0.0': SUPPORTED, 'jPipe 4.0.1': SUPPORTED });
        verdicts.answer(COMMAND, 'jPipe 4.0.0', judge);
        verdicts.rejectJson(COMMAND);
        expect(verdicts.answer(COMMAND, 'jPipe 4.0.1', judge)).toEqual(SUPPORTED);
    });

    // The case one reviewer of #115 asked to keep: let through, refused at `-f json`, and refused
    // from then on while its version still cannot be read.
    test('whose version cannot be read stays refused while it still cannot be', () => {
        const verdicts = new CompilerVerdicts();
        const { judge } = judging({ 'jPipe 4.0.0': SUPPORTED });
        expect(verdicts.answer(COMMAND, undefined, judge)).toEqual({ kind: 'unknown' });
        verdicts.rejectJson(COMMAND);
        expect(verdicts.answer(COMMAND, undefined, judge)).toEqual({ kind: 'too-old', version: undefined });
        expect(verdicts.answer(COMMAND, 'jPipe 4.0.0', judge)).toEqual(SUPPORTED);
    });

    test('stays refused when it is forgotten', () => {
        const verdicts = new CompilerVerdicts();
        verdicts.answer(COMMAND, 'jPipe 4.0.0', judging({ 'jPipe 4.0.0': SUPPORTED }).judge);
        verdicts.rejectJson(COMMAND);
        verdicts.forget(COMMAND);
        expect(verdicts.answer(COMMAND, 'jPipe 4.0.0', judging({}).judge)).toEqual({ kind: 'too-old', version: undefined });
    });

    // Check jPipe Installation forgets the verdict while a diagnostic that started before it
    // fails: the refusal must still be held against what the compiler last printed.
    test('is refused against what it last printed, after a forget or a failed ask', () => {
        const verdicts = new CompilerVerdicts();
        const { judge } = judging({ 'jPipe 4.0.0': SUPPORTED });
        verdicts.answer(COMMAND, 'jPipe 4.0.0', judge);
        verdicts.forget(COMMAND);
        verdicts.rejectJson(COMMAND);
        expect(verdicts.answer(COMMAND, 'jPipe 4.0.0', judge)).toEqual({ kind: 'too-old', version: undefined });

        const other = new CompilerVerdicts();
        other.answer(COMMAND, 'jPipe 4.0.0', judge);
        other.answer(COMMAND, undefined, judge);
        other.rejectJson(COMMAND);
        expect(other.answer(COMMAND, 'jPipe 4.0.0', judge)).toEqual({ kind: 'too-old', version: undefined });
    });
});
