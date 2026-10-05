/**
 * @vitest-environment happy-dom
 */

import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { Minimap } from '../src/webview/minimap.js';
import { type Box, type Size, minimapToViewBox } from '../src/webview/viewbox.js';

/**
 * The minimap widget, exercised against a real document.
 *
 * Its arithmetic lives in `viewbox.ts` and is tested there. What this covers is the widget's own
 * part: the Blob URL lifecycle, sizing the map to the diagram's shape within the panel, and
 * turning pointer gestures into navigation. happy-dom does no layout, so the two bounding boxes
 * the drag reads are stubbed; everything else is the real DOM.
 *
 * What is still manual: how it looks, and how a drag feels.
 */

interface Shell {
    root: HTMLElement;
    img: HTMLImageElement;
    rect: HTMLElement;
}

/** The markup `preview-shell.ts` builds for the minimap. */
function mountShell(): Shell {
    document.body.replaceChildren();
    const root = document.createElement('div');
    root.id = 'minimap';
    root.hidden = true;
    const img = document.createElement('img');
    img.id = 'minimap-img';
    const rect = document.createElement('div');
    rect.id = 'minimap-rect';
    root.append(img, rect);
    document.body.append(root);
    return { root, img, rect };
}

/** A `DOMRect` for an element happy-dom cannot lay out. */
function placeAt(element: HTMLElement, left: number, top: number, width: number, height: number): void {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        left, top, width, height,
        right: left + width, bottom: top + height,
        x: left, y: top,
        toJSON: () => ({})
    } as DOMRect);
}

function pointer(target: HTMLElement, type: string, clientX: number, clientY: number, pointerId = 1): PointerEvent {
    const event = new PointerEvent(type, { clientX, clientY, pointerId, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
}

let shell: Shell;
let onNavigate: Mock<(left: number, top: number, mm: Size) => void>;
let minimap: Minimap;

beforeEach(() => {
    shell = mountShell();
    // Pointer capture is a browser behaviour happy-dom does not implement; the widget's
    // obligation is only to ask for it and give it back.
    shell.root.setPointerCapture = vi.fn();
    shell.root.releasePointerCapture = vi.fn();
    onNavigate = vi.fn();
    minimap = new Minimap(shell.root, onNavigate);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('the diagram source', () => {
    beforeEach(() => {
        vi.spyOn(URL, 'createObjectURL')
            .mockReturnValueOnce('blob:first')
            .mockReturnValueOnce('blob:second');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    });

    test('draws the SVG text through a Blob URL, not a second copy in the page', () => {
        minimap.setSource('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

        const blob = (URL.createObjectURL as Mock).mock.calls[0][0] as Blob;
        expect(blob.type).toBe('image/svg+xml');
        expect(shell.img.getAttribute('src')).toBe('blob:first');
        expect(shell.root.querySelector('svg')).toBeNull();
    });

    test('revokes the previous URL when a new diagram arrives', () => {
        minimap.setSource('<svg/>');
        minimap.setSource('<svg/>');

        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first');
        expect(shell.img.getAttribute('src')).toBe('blob:second');
    });

    test('release revokes the current URL once, and is safe to repeat', () => {
        minimap.setSource('<svg/>');
        minimap.release();
        minimap.release();

        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first');
    });

    test('release with no diagram does nothing', () => {
        minimap.release();
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    });
});

describe('sizing and the viewport box', () => {
    const content: Box = { x: 0, y: 0, w: 1000, h: 500 };

    test('stays hidden while the whole diagram is on screen', () => {
        shell.root.hidden = false;
        minimap.update(content, content, { width: 1000, height: 800 });
        expect(shell.root.hidden).toBe(true);
    });

    test('appears once part of the diagram is off screen', () => {
        minimap.update({ x: 100, y: 50, w: 400, h: 200 }, content, { width: 1000, height: 800 });
        expect(shell.root.hidden).toBe(false);
    });

    test('takes the diagram\'s shape at its maximum width, and places the viewport box', () => {
        // 28% of a 1000px panel is 280px, over the 200px cap; the 2:1 diagram is then 100px tall.
        minimap.update({ x: 100, y: 50, w: 400, h: 200 }, content, { width: 1000, height: 800 });

        expect(shell.root.style.width).toBe('200px');
        expect(shell.root.style.height).toBe('100px');
        // One map pixel is five diagram units.
        expect(shell.rect.style.left).toBe('20px');
        expect(shell.rect.style.top).toBe('10px');
        expect(shell.rect.style.width).toBe('80px');
        expect(shell.rect.style.height).toBe('40px');
    });

    test('a narrow panel shrinks the map below its cap', () => {
        // 28% of 500px is 140px.
        minimap.update({ x: 0, y: 0, w: 400, h: 200 }, content, { width: 500, height: 800 });
        expect(shell.root.style.width).toBe('140px');
        expect(shell.root.style.height).toBe('70px');
    });

    test('a tall diagram is capped by height, and narrows to keep its shape', () => {
        // At 200px wide a 1:4 diagram would be 800px tall; 35% of a 400px panel allows 140px.
        const tall: Box = { x: 0, y: 0, w: 500, h: 2000 };
        minimap.update({ x: 0, y: 0, w: 250, h: 500 }, tall, { width: 1000, height: 400 });

        expect(shell.root.style.height).toBe('140px');
        expect(shell.root.style.width).toBe('35px');
    });

    test('hide takes the map off screen', () => {
        shell.root.hidden = false;
        minimap.hide();
        expect(shell.root.hidden).toBe(true);
    });

    test('toViewBox is the viewbox maths, unchanged', () => {
        const vb: Box = { x: 100, y: 50, w: 400, h: 200 };
        const mm: Size = { width: 200, height: 100 };
        expect(minimap.toViewBox(vb, 30, 15, content, mm)).toEqual(minimapToViewBox(vb, 30, 15, content, mm));
    });
});

describe('dragging', () => {
    // The map sits at (10, 20) and is 200×100; the viewport box inside it at (30, 30), 40×20.
    beforeEach(() => {
        placeAt(shell.root, 10, 20, 200, 100);
        placeAt(shell.rect, 30, 30, 40, 20);
    });

    test('clicking outside the box jumps there, centring the box on the pointer', () => {
        const event = pointer(shell.root, 'pointerdown', 150, 70, 7);

        // Map-local (140, 50), less half the box (20, 10).
        expect(onNavigate).toHaveBeenCalledWith(120, 40, { width: 200, height: 100 });
        expect(shell.root.setPointerCapture).toHaveBeenCalledWith(7);
        expect(event.defaultPrevented).toBe(true);
    });

    test('grabbing the box keeps the grabbed point under the pointer', () => {
        // 10px right of and 5px below the box's corner.
        pointer(shell.root, 'pointerdown', 40, 35);
        expect(onNavigate).toHaveBeenLastCalledWith(20, 10, { width: 200, height: 100 });

        pointer(shell.root, 'pointermove', 60, 45);
        expect(onNavigate).toHaveBeenLastCalledWith(40, 20, { width: 200, height: 100 });
    });

    test('moving without a press does nothing', () => {
        pointer(shell.root, 'pointermove', 60, 45);
        expect(onNavigate).not.toHaveBeenCalled();
    });

    test('a second pointer does not steer a drag it did not start', () => {
        pointer(shell.root, 'pointerdown', 40, 35, 1);
        onNavigate.mockClear();

        pointer(shell.root, 'pointermove', 60, 45, 2);
        pointer(shell.root, 'pointerup', 60, 45, 2);

        expect(onNavigate).not.toHaveBeenCalled();
        expect(shell.root.releasePointerCapture).not.toHaveBeenCalled();
    });

    test.each(['pointerup', 'pointercancel'])('%s ends the drag and gives the pointer back', type => {
        pointer(shell.root, 'pointerdown', 40, 35, 3);
        pointer(shell.root, type, 40, 35, 3);
        onNavigate.mockClear();

        pointer(shell.root, 'pointermove', 60, 45, 3);

        expect(shell.root.releasePointerCapture).toHaveBeenCalledWith(3);
        expect(onNavigate).not.toHaveBeenCalled();
    });
});
