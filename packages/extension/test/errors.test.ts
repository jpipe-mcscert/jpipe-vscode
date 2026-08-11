import { describe, expect, test } from 'vitest';
import { asProcessFailure, detailOf, displayMessageOf, messageOf } from '../src/shared/errors.js';

/**
 * The narrowing that replaced ten `catch (e: any)` blocks.
 *
 * Those blocks live in `image-generator.ts` and `preview-provider.ts`, neither of which can be
 * loaded here (jpipe-vscode ADR-VSC-0004), so this is where the rules they relied on get
 * checked. The cases below are the actual error shapes those files see, not invented ones:
 * `execFile` rejects with `code`, and `image-generator` re-throws a synthesised error carrying
 * `exitCode`, so both spellings reach a caller and have to mean the same thing.
 */

describe('messageOf', () => {
    test('takes the message off an Error', () => {
        expect(messageOf(new Error('compiler exploded'))).toBe('compiler exploded');
    });

    test.each([
        ['a string', 'plain string', 'plain string'],
        ['a number', 42, '42'],
        ['null', null, 'null'],
        ['undefined', undefined, 'undefined']
    ])('stringifies %s', (_label, input, expected) => {
        expect(messageOf(input)).toBe(expected);
    });

    test('keeps the old behaviour for a thrown object literal', () => {
        // Not pretty, but it is what the fifteen hand-written ternaries did, and this replaced
        // them without changing what a user sees.
        expect(messageOf({ message: 'ignored' })).toBe('[object Object]');
    });
});

describe('displayMessageOf', () => {
    test('prefers an Error message', () => {
        expect(displayMessageOf(new Error('boom'))).toBe('boom');
    });

    test('passes a thrown string through', () => {
        expect(displayMessageOf('just a string')).toBe('just a string');
    });

    test.each([[{}], [null], [undefined], [7]])('falls back for %j rather than stringifying', (input) => {
        // The difference from messageOf, and the reason both exist: this feeds notifications,
        // where "[object Object]" reads as a bug in the extension.
        expect(displayMessageOf(input)).toBe('[unknown error]');
    });
});

describe('asProcessFailure', () => {
    test('reads an execFile rejection, which carries `code` and no `exitCode`', () => {
        const err = Object.assign(new Error('Command failed'), {
            code: 1, stdout: '<svg/>', stderr: 'model has errors'
        });
        expect(asProcessFailure(err)).toEqual({
            stdout: '<svg/>', stderr: 'model has errors', exitCode: 1, cancelled: false
        });
    });

    test('reads the synthesised error image-generator re-throws, which carries `exitCode`', () => {
        const err = Object.assign(new Error('Failed to generate svg'), {
            exitCode: 42, stdout: '', stderr: 'crash'
        });
        expect(asProcessFailure(err).exitCode).toBe(42);
    });

    test('prefers exitCode when both are present', () => {
        const err = Object.assign(new Error('x'), { exitCode: 42, code: 1 });
        expect(asProcessFailure(err).exitCode).toBe(42);
    });

    test('keeps a zero exit code, which is falsy but meaningful', () => {
        // The fallback from exitCode to code uses `??`, not `||`: with `||` a zero here would
        // fall through to `code` and report the wrong status.
        expect(asProcessFailure({ exitCode: 0, code: 1 }).exitCode).toBe(0);
    });

    test('ignores a non-numeric code, which is a spawn failure not an exit status', () => {
        // ENOENT means the compiler was never started; reporting it as an exit code would say
        // the model failed to compile, which is a different and wrong thing to tell a user.
        const err = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
        expect(asProcessFailure(err).exitCode).toBeUndefined();
    });

    test.each([['a string', 'nope'], ['null', null], ['undefined', undefined], ['a bare Error', new Error('x')]])(
        'yields everything-absent for %s', (_label, input) => {
            expect(asProcessFailure(input)).toEqual({
                stdout: undefined, stderr: undefined, exitCode: undefined, cancelled: false
            });
        });

    test('reports cancellation only for a literal true', () => {
        expect(asProcessFailure({ cancelled: true }).cancelled).toBe(true);
        expect(asProcessFailure({ cancelled: 'yes' }).cancelled).toBe(false);
        expect(asProcessFailure({}).cancelled).toBe(false);
    });

    test('ignores fields of the wrong type rather than passing them through', () => {
        expect(asProcessFailure({ stdout: 123, stderr: [] })).toEqual({
            stdout: undefined, stderr: undefined, exitCode: undefined, cancelled: false
        });
    });
});

describe('detailOf', () => {
    test('prefers stderr, where a compiler explains itself', () => {
        const err = Object.assign(new Error('Command failed'), {
            stdout: 'some output', stderr: '  model has errors\n'
        });
        expect(detailOf(err)).toBe('model has errors');
    });

    test('falls back to stdout when stderr is empty', () => {
        const err = Object.assign(new Error('Command failed'), { stdout: ' out ' });
        expect(detailOf(err)).toBe('out');
    });

    test('falls back to the message when the process never produced output', () => {
        expect(detailOf(new Error('  spawn ENOENT  '))).toBe('spawn ENOENT');
    });

    test('an empty stderr still wins, because the process did run and said nothing', () => {
        const err = Object.assign(new Error('ignored'), { stderr: '', stdout: 'out' });
        expect(detailOf(err)).toBe('');
    });
});
