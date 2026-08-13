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
        // The canvas is the first painted shape, and the only polygon `dot` puts directly under
        // `g.graph` — everything else it draws is nested in a `g.cluster`, `g.node` or `g.edge`.
        // That structure is what identifies it here, because the attributes are not stable: it
        // was `stroke="transparent"` until Graphviz 5.0.1 (2022) dropped a keyword SVG 1.1 does
        // not define, and `stroke="none"` since. Matching the newer spelling alone left the white
        // sheet in place on every distribution still packaging 2.42 — which, in 2026, is Debian
        // stable and every Ubuntu LTS before 26.04.
        if (el.tagName === 'polygon' && hasNoStroke(el)) {
            el.remove();
            break;
        }
    }

    thinClusterBackdrops(svg);

    svg.querySelectorAll('g.edge [stroke="black"], g.edge [fill="black"]').forEach(el => {
        if (el.getAttribute('stroke') === 'black') el.setAttribute('stroke', 'currentColor');
        if (el.getAttribute('fill') === 'black') el.setAttribute('fill', 'currentColor');
    });

    // Text defaults to black, which is readable on a filled node and invisible on anything
    // else — a sub-conclusion, whose whole visual identity is being an *unfilled* box, and any
    // label drawn straight onto the canvas. So the rule is by backdrop, not by element type:
    // keep black only where the compiler painted something light to sit on.
    //
    // Giving the unfilled box a fill instead would read as simpler, and would erase exactly the
    // distinction the compiler is drawing between a sub-conclusion and everything around it.
    svg.querySelectorAll('text').forEach(text => {
        if (text.getAttribute('fill')) return;
        const node = text.closest('g.node');
        if (node && isFilled(node)) return;
        text.setAttribute('fill', 'currentColor');
    });

    // An outline is black for the same reason a label is, and answers to the same rule. On a
    // filled node the outline traces the edge of something light and reads against it, so it
    // stays. On an unfilled one it lies directly on the editor background, which cost an
    // `@support` everything it has: a dotted rectangle and nothing else, drawn in black on black.
    //
    // Only *black* is redirected. A sub-conclusion is outlined in the compiler's own blue, which
    // it chose as a colour rather than as a default, and which reads on either ground.
    svg.querySelectorAll('g.node').forEach(node => {
        if (isFilled(node)) return;
        node.querySelectorAll('[stroke="black"]').forEach(shape => {
            shape.setAttribute('stroke', 'currentColor');
        });
    });
}

/**
 * How much of a cluster's own colour survives on a dark ground. Enough to read as a tinted
 * region, little enough that light text and arrowheads keep their contrast against it.
 */
const CLUSTER_WASH = 0.1;

/**
 * Turn the pale panel behind an inherited region into a wash.
 *
 * A model that implements a template is drawn with the inherited part inside a Graphviz cluster,
 * which `dot` fills `lightyellow` — a colour chosen for a white page. Everything else here assumes
 * the opposite: edges and arrowheads have just been re-pointed at the editor foreground, and the
 * label of any unfilled node is about to be. On a dark theme all of that is light, and all of it
 * is drawn *over* this panel, so the region ended up as light-on-pale-yellow — the sub-conclusions
 * inside a template being the case anyone notices first, since an unfilled box is exactly what
 * they are.
 *
 * Made translucent rather than repainted, so the tint stays the compiler's own colour and
 * composites onto whatever ground the theme provides instead of a value invented here. The stroke
 * and the cluster's caption are left alone: both read once the panel behind them is dark.
 */
function thinClusterBackdrops(svg: SVGSVGElement): void {
    svg.querySelectorAll('g.cluster').forEach(cluster => {
        cluster.querySelectorAll(FILLABLE).forEach(shape => {
            const fill = shape.getAttribute('fill');
            if (fill === null || fill === 'none') return;
            shape.setAttribute('fill-opacity', String(CLUSTER_WASH));
        });
    });
}

/**
 * Whether a shape draws no outline — however the Graphviz that produced it spells that.
 *
 * `none` is what 5.0.1 and later emit, `transparent` what everything before it did, and an
 * absent attribute is the SVG default of no paint. All three mean the same thing, so the guard
 * accepts all three rather than tracking which release drew the file.
 */
function hasNoStroke(el: Element): boolean {
    const stroke = el.getAttribute('stroke');
    return stroke === null || stroke === 'none' || stroke === 'transparent';
}

/** Shapes that can carry a background; `polyline` is excluded, being decoration on a corner. */
const FILLABLE = 'polygon, path, ellipse, rect, circle';

/** Whether anything in this node paints a backdrop for its label to sit on. */
function isFilled(node: Element): boolean {
    return Array.from(node.querySelectorAll(FILLABLE)).some(shape => {
        const fill = shape.getAttribute('fill');
        return fill !== null && fill !== 'none';
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
