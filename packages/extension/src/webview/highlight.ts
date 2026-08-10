/**
 * Caption stripping and cursor-to-element matching, against the Graphviz SVG.
 *
 * Both depend on the SVG being live, queryable DOM in the main document — the matcher's first
 * tier is a document-scoped `getElementById`. That is the constraint that rules out rendering
 * the preview as an <img>, a canvas or an iframe.
 */

/**
 * Remove the graph caption Graphviz draws for us.
 *
 * `dot` renders the graph's label — the source path and the model name — as a `<text>` inside
 * `g#graph0`, which is noise in a panel that already knows which file it is showing.
 *
 * Only one pass, over `<text>` and `<title>` directly. An earlier version followed up by
 * removing any `<g>` whose sole direct `<text>` matched, but that could never fire: the first
 * pass has already detached those elements. It was also a hazard — `g#graph0` has exactly one
 * direct `<text>`, so had the passes run in the other order it would have deleted the entire
 * graph.
 */
export function stripCaptions(svg: SVGSVGElement, documentPath: string | null, diagramName: string | null): void {
    const shouldRemove = (el: Element): boolean => {
        const text = el.textContent ?? '';
        if (documentPath && text.includes(documentPath)) return true;
        if (diagramName && text.trim() === diagramName) return true;
        return false;
    };
    svg.querySelectorAll('text, title').forEach(el => {
        if (shouldRemove(el)) el.remove();
    });
}

/**
 * Make the diagram sit on the editor's background instead of on a white sheet.
 *
 * `dot` paints an opaque white rectangle across the whole canvas. Against a dark theme that
 * reads as a page being shoved around rather than a canvas being panned, because the thing
 * moving under the pointer has a visible edge.
 *
 * Dropping it is not enough on its own: edges and arrowheads are drawn in literal black, which
 * on a dark background is very nearly invisible. So they are re-pointed at `currentColor`,
 * which the stylesheet ties to the editor foreground. Node fills are left exactly as the
 * compiler chose them — they carry meaning (evidence, strategy, conclusion), they are light
 * enough to read black labels against, and repainting them would be inventing a colour scheme
 * the model did not ask for.
 *
 * Only called for dark themes; in a light one the compiler's own output is already right.
 */
export function adaptToDarkTheme(svg: SVGSVGElement): void {
    const graph = svg.querySelector('g.graph') ?? svg;
    for (const el of Array.from(graph.children)) {
        // The canvas is the first painted shape and the only one with no stroke.
        if (el.tagName === 'polygon' && el.getAttribute('stroke') === 'none') {
            el.remove();
            break;
        }
    }

    svg.querySelectorAll('g.edge [stroke="black"], g.edge [fill="black"]').forEach(el => {
        if (el.getAttribute('stroke') === 'black') el.setAttribute('stroke', 'currentColor');
        if (el.getAttribute('fill') === 'black') el.setAttribute('fill', 'currentColor');
    });
}

/**
 * Find the `<g>` that draws `name`.
 *
 * Three tiers, because the compiler's own element ids are the reliable route but not one we
 * can count on across compiler versions:
 *
 *  1. The id `dot` copies from the exporter, `"<diagram>:<element>"`. Exact, when present.
 *  2. The `<title>` Graphviz writes for every node and edge, qualified or bare.
 *  3. The visible label text.
 *
 * Returns null when the cursor is on something with no counterpart in the diagram.
 */
export function findElement(svg: SVGSVGElement, diagramName: string | null, symbolName: string): SVGGraphicsElement | null {
    const name = symbolName.trim();
    if (!name) return null;

    const enclosing = (el: Element): SVGGraphicsElement | null =>
        (el.closest('g.node') ?? el.closest('g.edge') ?? el.closest('g')) as SVGGraphicsElement | null;

    if (diagramName) {
        // Document-scoped, so guard that the hit is actually inside *our* SVG.
        const byId = document.getElementById(`${diagramName}:${name}`);
        if (byId && svg.contains(byId)) {
            return enclosing(byId) ?? (byId as unknown as SVGGraphicsElement);
        }
    }

    const qualified = diagramName ? `${diagramName}:${name}` : name;
    for (const title of Array.from(svg.querySelectorAll('title'))) {
        const text = (title.textContent ?? '').trim();
        if (text === qualified || text === name) {
            const found = enclosing(title);
            if (found) return found;
        }
    }

    for (const text of Array.from(svg.querySelectorAll('g.node text, g.edge text'))) {
        if ((text.textContent ?? '').trim() === name) {
            const found = enclosing(text);
            if (found) return found;
        }
    }

    return null;
}

/**
 * Emphasise one element by dimming every other node and edge.
 *
 * Dimming the rest rather than colouring the match keeps the diagram's own styling intact, so
 * the highlight reads the same whatever the model looks like.
 */
export function applyDimming(svg: SVGSVGElement, matched: SVGGraphicsElement | null): void {
    svg.querySelectorAll('g.node, g.edge').forEach(g => {
        g.classList.toggle('jpipe-dimmed', matched !== null && g !== matched);
    });
}
