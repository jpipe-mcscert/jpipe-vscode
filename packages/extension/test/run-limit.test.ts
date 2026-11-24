import { describe, expect, test } from 'vitest';
import { RunLimit } from '../src/extension/compiler/run-limit.js';

describe('a run limit', () => {

    test('runs no more than its limit at a time, and the others in the order they came', async () => {
        const limit = new RunLimit(2);
        let running = 0;
        let most = 0;
        const started: number[] = [];
        const releases: Array<() => void> = [];
        const runs = [0, 1, 2, 3].map(i => limit.run(async () => {
            started.push(i);
            running++;
            most = Math.max(most, running);
            await new Promise<void>(resolve => releases.push(resolve));
            running--;
            return i;
        }));
        while (started.length < 4) {
            await new Promise(resolve => setTimeout(resolve, 0));
            releases.shift()?.();
        }
        releases.forEach(release => release());
        expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
        expect(most).toBe(2);
        expect(started).toEqual([0, 1, 2, 3]);
    });

    test('lets the next run start when one fails', async () => {
        const limit = new RunLimit(1);
        await expect(limit.run(async () => { throw new Error('failed'); })).rejects.toThrow('failed');
        expect(await limit.run(async () => 'next')).toBe('next');
    });
});
