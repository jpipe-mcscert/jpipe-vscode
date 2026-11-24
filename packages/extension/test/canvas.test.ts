/**
 * @vitest-environment happy-dom
 */

import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { DiagramCanvas, installSvg, resolveContent } from '../src/webview/canvas.js';
import { type Box, fitToWindowBox, formatViewBox, initialBox, parseViewBox } from '../src/webview/viewbox.js';

/**
 * The canvas the preview and the run panel share, exercised against a real document.
 *
 * Its arithmetic lives in `viewbox.ts` and is tested there. What this covers is the adapter: the
 * SVG it installs and how, the viewBox it writes back, the controls and keys it answers, and how
 * it tells a click on a node from a pan. happy-dom does no layout, so the boxes the canvas measures
 * are stubbed; everything else is the real DOM.
 *
 * What is still manual: how a pan or a zoom feels.
 */

const PANEL = { width: 800, height: 600 };

/** A Graphviz-shaped SVG: a caption, a white sheet, a node with an id, an edge. */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400pt" height="300pt" viewBox="0.00 0.00 400.00 300.00">
<g id="graph0" class="graph">
<title>release</title>
<polygon fill="white" stroke="none" points="0,0 400,0 400,300 0,300"/>
<text>/work/release.jd</text>
<g id="release:c" class="node"><title>release:c</title><polygon fill="lightgrey" stroke="black" points="0,0 1,1"/><text>Conclusion</text></g>
<g id="edge1" class="edge"><title>release:s&#45;&gt;release:c</title><path stroke="black" d="M0,0"/></g>
</g>
</svg>`;

interface Page {
    container: HTMLElement;
    wrapper: HTMLElement;
    zoomValue: HTMLElement;
    zoomIn: HTMLElement;
    zoomOut: HTMLElement;
    zoomFit: HTMLElement;
    toolbar: HTMLElement;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

/** The markup both shells build for the canvas. */
function mountPage(): Page {
    document.body.replaceChildren();
    document.body.className = '';
    const make = (tag: string, id: string, parent: HTMLElement = document.body): HTMLElement => {
        const el = document.createElement(tag);
        el.id = id;
        parent.append(el);
        return el;
    };
    const toolbar = make('div', 'toolbar');
    const page: Page = {
        toolbar,
        zoomIn: make('button', 'zoom-in', toolbar),
        zoomOut: make('button', 'zoom-out', toolbar),
        zoomFit: make('button', 'zoom-fit', toolbar),
        zoomValue: make('button', 'zoom-value', toolbar),
        container: make('div', 'container'),
        wrapper: document.createElement('div')
    };
    page.wrapper.id = 'svg-wrapper';
    page.container.append(page.wrapper);
    const minimap = make('div', 'minimap');
    minimap.hidden = true;
    make('img', 'minimap-img', minimap);
    make('div', 'minimap-rect', minimap);
    vi.spyOn(page.container, 'getBoundingClientRect').mockReturnValue(rect(0, 0, PANEL.width, PANEL.height));
    return page;
}

let page: Page;
let hooks: {
    isShowing: Mock<() => boolean>;
    isChrome: Mock<(target: EventTarget | null) => boolean>;
    onViewChange: Mock<() => void>;
    onPress: Mock<() => void>;
    onRebuilt: Mock<() => void>;
    onNodeClick: Mock<(node: SVGGElement, twice: boolean) => void>;
};
let showing: boolean;

function newCanvas(): DiagramCanvas {
    return new DiagramCanvas(
        {
            container: page.container,
            wrapper: page.wrapper,
            zoomValue: page.zoomValue,
            minimap: document.getElementById('minimap') as HTMLElement,
            zoomIn: page.zoomIn,
            zoomOut: page.zoomOut,
            zoomFit: page.zoomFit
        },
        hooks
    );
}

const viewBoxOf = (canvas: DiagramCanvas) => parseViewBox(canvas.svg?.getAttribute('viewBox') ?? null);

/** Boxes are computed in floating point: equal to within rounding is equal. */
function expectBox(actual: Box | null, expected: Box | null): void {
    expect(actual).not.toBeNull();
    for (const key of ['x', 'y', 'w', 'h'] as const) expect(actual![key]).toBeCloseTo(expected![key], 6);
}
const CONTENT = { x: 0, y: 0, w: 400, h: 300 };
const FRAME = { content: CONTENT, viewport: PANEL, baseScale: 4 / 3 };

function pointer(target: EventTarget, type: string, clientX: number, clientY: number): void {
    target.dispatchEvent(new PointerEvent(type, { clientX, clientY, pointerId: 1, button: 0, bubbles: true, cancelable: true }));
}

beforeEach(() => {
    page = mountPage();
    showing = true;
    hooks = {
        isShowing: vi.fn(() => showing),
        isChrome: vi.fn((target: EventTarget | null) => target instanceof Element && target.closest('#toolbar') !== null),
        onViewChange: vi.fn<() => void>(),
        onPress: vi.fn<() => void>(),
        onRebuilt: vi.fn<() => void>(),
        onNodeClick: vi.fn<(node: SVGGElement, twice: boolean) => void>()
    };
    // happy-dom has no pointer capture.
    page.container.setPointerCapture = vi.fn();
    page.container.releasePointerCapture = vi.fn();
    URL.createObjectURL = vi.fn(() => 'blob:minimap');
    URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('showing a diagram', () => {

    test('installs the SVG, strips its caption, and opens on the initial view', () => {
        const canvas = newCanvas();
        expect(canvas.show(SVG, { documentPath: '/work/release.jd', diagramName: 'release' })).toBe(true);
        expect(page.wrapper.querySelector('svg')).toBe(canvas.svg);
        expect(page.wrapper.textContent).not.toContain('/work/release.jd');
        expect(canvas.svg?.querySelector('title')?.textContent).not.toBe('release');
        expectBox(viewBoxOf(canvas), initialBox(FRAME));
        expectBox(canvas.view, initialBox(FRAME));
        expect(page.zoomValue.textContent).toMatch(/^\d+%$/);
        expect(hooks.onViewChange).toHaveBeenCalled();
    });

    test('keeps the reader\'s framing when the same diagram is shown again, and opens another on its own', () => {
        const canvas = newCanvas();
        const release = { documentPath: '/w/release.jd', diagramName: 'release' };
        canvas.show(SVG, release);
        canvas.zoomStep('in');
        const framed = canvas.view;
        canvas.show(SVG, release);
        expectBox(canvas.view, framed);
        canvas.show(SVG, { documentPath: '/w/release.jd', diagramName: 'other' });
        expectBox(canvas.view, initialBox(FRAME));
    });

    test('tells diagrams by the identity it is given, when the page gives one', () => {
        const canvas = newCanvas();
        const caption = { documentPath: null, diagramName: 'release' };
        canvas.show(SVG, caption, 'file:///w/a.jd');
        canvas.zoomStep('in');
        canvas.show(SVG, caption, 'file:///w/b.jd');
        expectBox(canvas.view, initialBox(FRAME));
    });

    test('keeps the framing across a clear, for the same diagram drawn again', () => {
        const canvas = newCanvas();
        const caption = { documentPath: null, diagramName: 'release (dataflow)' };
        canvas.show(SVG, caption);
        canvas.zoomStep('in');
        const framed = canvas.view;
        canvas.clear();
        canvas.show(SVG, caption);
        expectBox(canvas.view, framed);
    });

    test('a restored framing is kept by the replay of its diagram, and only of its diagram', () => {
        const caption = { documentPath: '/w/release.jd', diagramName: 'release' };
        const shown = newCanvas();
        shown.show(SVG, caption);
        shown.zoomStep('in');
        const saved = shown.framing!;
        expect(saved.on).toBeTruthy();

        const reloaded = newCanvas();
        reloaded.restoreFraming(saved);
        reloaded.show(SVG, caption);
        expectBox(reloaded.view, saved.vb);

        const other = newCanvas();
        other.restoreFraming(saved);
        other.show(SVG, { ...caption, diagramName: 'other' });
        expectBox(other.view, initialBox(FRAME));
    });

    test('text that is not an SVG leaves the canvas empty', () => {
        const canvas = newCanvas();
        canvas.show(SVG, { documentPath: null, diagramName: null });
        expect(canvas.show('<html>not a diagram', { documentPath: null, diagramName: null })).toBe(false);
        expect(canvas.svg).toBeNull();
        expect(page.wrapper.childElementCount).toBe(0);
    });

    test('clear takes the diagram away', () => {
        const canvas = newCanvas();
        canvas.show(SVG, { documentPath: null, diagramName: null });
        canvas.clear();
        expect(canvas.svg).toBeNull();
        expect(page.wrapper.childElementCount).toBe(0);
        // Nothing to navigate: the controls do nothing.
        canvas.zoomStep('in');
        canvas.fit();
        canvas.actualSize();
        expect(page.wrapper.childElementCount).toBe(0);
    });

    test('on a dark theme the white sheet goes, and a theme switch rebuilds the diagram', async () => {
        document.body.classList.add('vscode-dark');
        const canvas = newCanvas();
        canvas.show(SVG, { documentPath: null, diagramName: null });
        expect(canvas.svg?.querySelector('polygon[fill="white"]')).toBeNull();

        document.body.classList.remove('vscode-dark');
        document.body.classList.add('vscode-light');
        await vi.waitFor(() => expect(hooks.onRebuilt).toHaveBeenCalled());
        expect(canvas.svg?.querySelector('polygon[fill="white"]')).not.toBeNull();
    });

    test('the minimap follows the canvas, and hides on request', () => {
        const canvas = newCanvas();
        const minimap = document.getElementById('minimap') as HTMLElement;
        canvas.show(SVG, { documentPath: null, diagramName: null });
        for (let i = 0; i < 6; i++) canvas.zoomStep('in');
        expect(minimap.hidden).toBe(false);
        canvas.hideMinimap();
        expect(minimap.hidden).toBe(true);
        canvas.refreshMinimap();
        expect(minimap.hidden).toBe(false);
    });
});

describe('the controls', () => {

    test('zoom in and out, fit, and 100%', () => {
        const canvas = newCanvas();
        canvas.show(SVG, { documentPath: null, diagramName: null });
        const opening = canvas.view!;

        page.zoomIn.click();
        expect(canvas.view!.w).toBeLessThan(opening.w);
        page.zoomOut.click();
        page.zoomOut.click();
        expect(canvas.view!.w).toBeGreaterThan(opening.w);

        page.zoomFit.click();
        expectBox(canvas.view, fitToWindowBox(FRAME));

        page.zoomValue.click();
        expect(page.zoomValue.textContent).toBe('100%');
    });

    test('keys zoom and pan while the canvas is on show, and only then', () => {
        const canvas = newCanvas();
        canvas.show(SVG, { documentPath: null, diagramName: null });
        const key = (k: string, init: KeyboardEventInit = {}) =>
            document.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true, ...init }));

        key('0');
        expectBox(canvas.view, fitToWindowBox(FRAME));
        key('+');
        const zoomed = canvas.view!;
        expect(zoomed.w).toBeLessThan(fitToWindowBox(FRAME).w);
        key('ArrowRight');
        expect(canvas.view!.x).toBeGreaterThan(zoomed.x);
        key('ArrowLeft', { shiftKey: true });
        expect(canvas.view!.x).toBeLessThan(zoomed.x);
        key('1');
        expect(page.zoomValue.textContent).toBe('100%');
        key('-');
        expect(page.zoomValue.textContent).not.toBe('100%');

        const before = canvas.view;
        key('+', { ctrlKey: true });
        key('Enter');
        showing = false;
        key('+');
        expect(canvas.view).toEqual(before);
    });

    test('the wheel zooms, and leaves the chrome alone', () => {
        const canvas = newCanvas();
        canvas.show(SVG, { documentPath: null, diagramName: null });
        vi.spyOn(canvas.svg!, 'getBoundingClientRect').mockReturnValue(rect(0, 0, PANEL.width, PANEL.height));
        const opening = canvas.view!;

        page.toolbar.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
        expect(canvas.view).toEqual(opening);

        page.container.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
        expect(canvas.view!.w).toBeLessThan(opening.w);
    });
});

describe('the pointer', () => {

    test('a press closes the page\'s menus, and a drag pans', () => {
        const canvas = newCanvas();
        canvas.show(SVG, { documentPath: null, diagramName: null });
        vi.spyOn(canvas.svg!, 'getBoundingClientRect').mockReturnValue(rect(0, 0, PANEL.width, PANEL.height));
        canvas.zoomStep('in');
        canvas.zoomStep('in');
        const before = canvas.view!;

        pointer(page.container, 'pointerdown', 100, 100);
        expect(hooks.onPress).toHaveBeenCalled();
        expect(page.container.classList.contains('dragging')).toBe(true);
        pointer(page.container, 'pointermove', 140, 100);
        expect(canvas.view!.x).toBeLessThan(before.x);
        pointer(page.container, 'pointerup', 140, 100);
        expect(page.container.classList.contains('dragging')).toBe(false);
    });

    test('a click on a node reaches the page, once or twice; a drag from a node does not', () => {
        const canvas = newCanvas();
        canvas.show(SVG, { documentPath: null, diagramName: null });
        const node = canvas.svg!.querySelector('g.node text')!;

        pointer(node, 'pointerdown', 10, 10);
        pointer(page.container, 'pointerup', 10, 10);
        page.container.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
        expect(hooks.onNodeClick).toHaveBeenLastCalledWith(canvas.svg!.querySelector('g.node'), false);

        pointer(node, 'pointerdown', 10, 10);
        page.container.dispatchEvent(new MouseEvent('click', { detail: 2, bubbles: true }));
        expect(hooks.onNodeClick).toHaveBeenLastCalledWith(canvas.svg!.querySelector('g.node'), true);

        hooks.onNodeClick.mockClear();
        pointer(node, 'pointerdown', 10, 10);
        pointer(page.container, 'pointermove', 60, 10);
        page.container.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
        expect(hooks.onNodeClick).not.toHaveBeenCalled();
    });

    test('a click on the background is no node click, and says so', () => {
        const onBackgroundClick = vi.fn<() => void>();
        const canvas = new DiagramCanvas(
            { container: page.container, wrapper: page.wrapper, zoomValue: page.zoomValue, minimap: document.getElementById('minimap') as HTMLElement },
            { ...hooks, onBackgroundClick });
        canvas.show(SVG, { documentPath: null, diagramName: null });
        pointer(page.container, 'pointerdown', 10, 10);
        page.container.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
        expect(hooks.onNodeClick).not.toHaveBeenCalled();
        expect(onBackgroundClick).toHaveBeenCalledOnce();
    });

    test('a press on the chrome is left alone', () => {
        const canvas = newCanvas();
        canvas.show(SVG, { documentPath: null, diagramName: null });
        pointer(page.toolbar, 'pointerdown', 10, 10);
        expect(hooks.onPress).not.toHaveBeenCalled();
    });
});

describe('revealing an element', () => {

    test('pans to an element off screen, and leaves one on screen where it is', () => {
        // Reduced motion, so the view moves at once rather than over frames. Read when the canvas
        // is made, as the page does.
        vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
        const canvas = newCanvas();
        canvas.show(SVG, { documentPath: null, diagramName: null });
        vi.spyOn(canvas.svg!, 'getBoundingClientRect').mockReturnValue(rect(0, 0, PANEL.width, PANEL.height));
        const node = canvas.svg!.querySelector('g.node')!;

        vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(rect(300, 250, 50, 30));
        const before = canvas.view;
        canvas.reveal(node);
        expect(canvas.view).toEqual(before);

        canvas.zoomStep('in');
        canvas.zoomStep('in');
        canvas.zoomStep('in');
        vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(rect(2000, 1500, 50, 30));
        const zoomed = canvas.view;
        canvas.reveal(node);
        expect(canvas.view).not.toEqual(zoomed);
    });

    test('an element with no size is not revealed', () => {
        const canvas = newCanvas();
        canvas.show(SVG, { documentPath: null, diagramName: null });
        const before = canvas.view;
        canvas.reveal(canvas.svg!.querySelector('g.node')!);
        expect(canvas.view).toEqual(before);
    });
});

describe('the diagram\'s extent', () => {

    const svgOf = (attributes: string): SVGSVGElement =>
        installSvg(document.createElement('div'), `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}></svg>`)!;

    test('is its viewBox when it has one', () => {
        expect(resolveContent(svgOf('viewBox="0 0 10 20"'))).toEqual({ x: 0, y: 0, w: 10, h: 20 });
    });

    test('is its width and height otherwise, written back as a viewBox', () => {
        const svg = svgOf('width="30" height="40"');
        expect(resolveContent(svg)).toEqual({ x: 0, y: 0, w: 30, h: 40 });
        expect(svg.getAttribute('viewBox')).toBe(formatViewBox({ x: 0, y: 0, w: 30, h: 40 }));
    });

    test('is unknown when it has neither and cannot be measured', () => {
        expect(resolveContent(svgOf(''))).toBeNull();
    });
});
