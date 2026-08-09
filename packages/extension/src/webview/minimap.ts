import { type Box, type Size, minimapRect, minimapToViewBox, shouldShowMinimap } from './viewbox.js';

/** Largest the minimap gets, and the most of the panel it is allowed to take. */
const MAX_WIDTH = 200;
const WIDTH_FRACTION = 0.28;
const MAX_HEIGHT_FRACTION = 0.35;

/**
 * The overview map: the whole diagram, with a box showing which part is on screen.
 *
 * The diagram is drawn into an `<img>` from a Blob URL rather than a second copy of the SVG in
 * the page. Every Graphviz node carries an id, and the cursor-highlight matcher looks elements
 * up with a document-scoped `getElementById` — a second live copy would duplicate every one of
 * those ids and make the highlight land on whichever came first in tree order. An `<img>` is a
 * separate document, so the collision cannot happen at all. It is also cheaper: the browser
 * decodes it once and every repaint while the box is dragged is a cached blit.
 */
export class Minimap {
    private readonly root: HTMLElement;
    private readonly img: HTMLImageElement;
    private readonly rect: HTMLElement;
    private url: string | null = null;
    private grab: { dx: number; dy: number } | null = null;
    private pointerId: number | null = null;

    constructor(root: HTMLElement, private readonly onNavigate: (left: number, top: number, mm: Size) => void) {
        this.root = root;
        this.img = root.querySelector('#minimap-img') as HTMLImageElement;
        this.rect = root.querySelector('#minimap-rect') as HTMLElement;
        this.bindDrag();
    }

    /**
     * Point the map at a newly rendered diagram.
     *
     * Takes the compiler's SVG text, not the element in the page: the live one has its viewBox
     * rewritten on every pan, so a copy taken from it would show the current view as though it
     * were the whole diagram.
     */
    setSource(svgText: string): void {
        this.release();
        this.url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
        this.img.src = this.url;
    }

    /** Revoke the current Blob URL. The page outlives many renders, so this is not optional. */
    release(): void {
        if (this.url) {
            URL.revokeObjectURL(this.url);
            this.url = null;
        }
    }

    /** Take the map off screen, for the modes that have no diagram to overview. */
    hide(): void {
        this.root.hidden = true;
    }

    /** Resize the map to the diagram's shape and move the viewport box. */
    update(vb: Box, content: Box, panel: Size): void {
        if (!shouldShowMinimap(vb, content)) {
            this.root.hidden = true;
            return;
        }
        this.root.hidden = false;

        let width = Math.min(MAX_WIDTH, panel.width * WIDTH_FRACTION);
        let height = width * content.h / content.w;
        const maxHeight = panel.height * MAX_HEIGHT_FRACTION;
        if (height > maxHeight) {
            height = maxHeight;
            width = height * content.w / content.h;
        }
        this.root.style.width = `${width}px`;
        this.root.style.height = `${height}px`;

        const r = minimapRect(vb, content, { width, height });
        this.rect.style.left = `${r.left}px`;
        this.rect.style.top = `${r.top}px`;
        this.rect.style.width = `${r.width}px`;
        this.rect.style.height = `${r.height}px`;
    }

    /** Where the current view sits, so the caller can convert a drag into a new viewBox. */
    toViewBox(vb: Box, left: number, top: number, content: Box, mm: Size): Box {
        return minimapToViewBox(vb, left, top, content, mm);
    }

    private bindDrag(): void {
        this.root.addEventListener('pointerdown', event => {
            const box = this.root.getBoundingClientRect();
            const px = event.clientX - box.left;
            const py = event.clientY - box.top;
            const r = this.rect.getBoundingClientRect();
            const inside = event.clientX >= r.left && event.clientX <= r.right
                && event.clientY >= r.top && event.clientY <= r.bottom;
            // Grabbing the box keeps it under the pointer; clicking elsewhere jumps there.
            this.grab = inside
                ? { dx: event.clientX - r.left, dy: event.clientY - r.top }
                : { dx: r.width / 2, dy: r.height / 2 };
            this.pointerId = event.pointerId;
            this.root.setPointerCapture(event.pointerId);
            event.preventDefault();
            this.navigate(px, py, box);
        });

        this.root.addEventListener('pointermove', event => {
            if (this.pointerId !== event.pointerId || !this.grab) return;
            const box = this.root.getBoundingClientRect();
            this.navigate(event.clientX - box.left, event.clientY - box.top, box);
        });

        const end = (event: PointerEvent) => {
            if (this.pointerId !== event.pointerId) return;
            this.root.releasePointerCapture(event.pointerId);
            this.pointerId = null;
            this.grab = null;
        };
        this.root.addEventListener('pointerup', end);
        this.root.addEventListener('pointercancel', end);
    }

    private navigate(px: number, py: number, box: DOMRect): void {
        if (!this.grab) return;
        this.onNavigate(px - this.grab.dx, py - this.grab.dy, { width: box.width, height: box.height });
    }
}
