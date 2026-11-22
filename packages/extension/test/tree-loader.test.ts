import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { REFRESH_DELAY_MS, TreeLoader } from '../src/extension/models-view/tree-loader.js';

/**
 * When the Models view and its Outline ask the language server again: now if the view shows,
 * when it is next shown or asked for otherwise, and after a pause in typing.
 */

let visible: boolean;
let loads: number;
let started: number;
let loader: TreeLoader;

beforeEach(() => {
    vi.useFakeTimers();
    visible = true;
    loads = 0;
    started = 0;
    loader = new TreeLoader(async () => { loads++; }, () => visible, () => { started++; });
});

afterEach(() => {
    loader.dispose();
    vi.useRealTimers();
});

describe('a refresh', () => {

    test('starts out stale, and loads once when the rows are first asked for', async () => {
        expect(loader.isStale).toBe(true);
        await loader.loaded();
        await loader.loaded();
        expect(loads).toBe(1);
        expect(loader.isStale).toBe(false);
    });

    test('of a view on show loads at once, and says so', async () => {
        await loader.loaded();
        loader.refresh();
        expect([loads, started]).toEqual([2, 1]);
    });

    test('of a hidden view waits until its rows are asked for', async () => {
        await loader.loaded();
        visible = false;
        loader.refresh();
        expect([loads, started, loader.isStale]).toEqual([1, 0, true]);
        await loader.loaded();
        expect(loads).toBe(2);
    });
});

describe('a refresh caused by typing', () => {

    test('waits for a pause, however many keystrokes came before it', async () => {
        await loader.loaded();
        for (let i = 0; i < 5; i++) {
            loader.scheduleRefresh();
            vi.advanceTimersByTime(REFRESH_DELAY_MS - 1);
        }
        expect(loads).toBe(1);
        vi.advanceTimersByTime(1);
        expect(loads).toBe(2);
    });

    test('still waiting is due at once when a command asks for the rows', async () => {
        await loader.loaded();
        loader.scheduleRefresh();
        loader.flush();
        await loader.loaded();
        expect(loads).toBe(2);
        // And it does not load a second time when the pause would have ended.
        vi.advanceTimersByTime(REFRESH_DELAY_MS);
        expect(loads).toBe(2);
    });

    test('with nothing waiting, flushing loads nothing', async () => {
        await loader.loaded();
        loader.flush();
        await loader.loaded();
        expect(loads).toBe(1);
    });

    test('is dropped when the view goes', async () => {
        await loader.loaded();
        loader.scheduleRefresh();
        loader.dispose();
        vi.advanceTimersByTime(REFRESH_DELAY_MS);
        expect(loads).toBe(1);
    });
});
