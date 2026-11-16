/**
 * What follows a node in a Graphviz drawing: everything its arrows lead to, read from the SVG.
 *
 * Graphviz writes each node's name in its `<title>`, and each edge's as `tail->head`, with the
 * same names. That is enough to walk the drawing without the model: in the run panel's dataflow,
 * what follows a file is the evidence that observes it and everything that evidence supports, and
 * what follows a variable is the steps that consume it and what they support (jpipe-vscode
 * ADR-VSC-0031).
 */

/** The name Graphviz gave a node or an edge: its `<title>`, entities decoded. */
export function nameOf(group: Element): string {
    const title = Array.from(group.children).find(child => child.tagName.toLowerCase() === 'title');
    return title?.textContent?.trim() ?? '';
}

/** The node named `name`, if the drawing has one. */
export function nodeNamed(svg: SVGSVGElement, name: string): SVGGElement | null {
    return Array.from(svg.querySelectorAll<SVGGElement>('g.node')).find(node => nameOf(node) === name) ?? null;
}

/**
 * `start`, every node its arrows lead to, directly or not, and the edges between them. A cycle,
 * which validation reports but the drawing still shows, is walked once.
 */
export function downstream(svg: SVGSVGElement, start: SVGGElement): Set<SVGGElement> {
    const nodes = new Map(Array.from(svg.querySelectorAll<SVGGElement>('g.node')).map(node => [nameOf(node), node]));
    const out = new Map<string, { head: string; edge: SVGGElement }[]>();
    for (const edge of Array.from(svg.querySelectorAll<SVGGElement>('g.edge'))) {
        const name = nameOf(edge);
        const cut = name.indexOf('->');
        if (cut < 0) continue;
        const tail = name.slice(0, cut);
        const edges = out.get(tail) ?? [];
        edges.push({ head: name.slice(cut + 2), edge });
        out.set(tail, edges);
    }
    const reached = new Set<SVGGElement>([start]);
    const seen = new Set<string>([nameOf(start)]);
    const queue = [nameOf(start)];
    while (queue.length > 0) {
        for (const { head, edge } of out.get(queue.shift()!) ?? []) {
            reached.add(edge);
            if (seen.has(head)) continue;
            seen.add(head);
            queue.push(head);
            const node = nodes.get(head);
            if (node) reached.add(node);
        }
    }
    return reached;
}

/**
 * Dim every node and edge but those in `focus`, and outline `origin`; with no focus, dim nothing.
 * Dimming the rest rather than colouring the focus keeps the run's own colours, which are what the
 * reader is looking at.
 */
export function applyFocus(svg: SVGSVGElement, focus: ReadonlySet<Element> | null, origin: Element | null): void {
    svg.querySelectorAll('g.node, g.edge').forEach(g => {
        g.classList.toggle('jpipe-dimmed', focus !== null && !focus.has(g));
        g.classList.toggle('jpipe-origin', g === origin);
    });
}
