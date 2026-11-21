/**
 * A run's drawing, coloured as the run goes (jpipe-vscode ADR-VSC-0033).
 *
 * Before the first step, jpipe-runner draws the run's dataflow with no status on it, and a status
 * never moves a node: every element's label keeps an empty cell of fixed size for its symbol
 * (jpipe-runner ADR-0032). So the drawing the run ends with is this one, with each element's status
 * drawn over it, and the page draws those statuses itself as the events decide them, by the
 * runner's own rules (its `diagram.py`):
 *
 * - **pass**: a green border, 2 points wide, and ✔;
 * - **fail**: filled vermillion, the border 2 points wide, the text white, and ✘;
 * - **skip**: filled light grey, the border grey and dashed, 2 points wide when the element is a
 *   root cause, and ◌;
 * - a support edge from a decided element, or from the placeholder of a template's slot it fills,
 *   takes the colour of its status, thicker from a failure, dashed from a skip;
 * - a variable its decided producer did not produce is dashed and grey, unless it is drawn as a
 *   problem already;
 * - a file a decided element could not reach is drawn in vermillion, 2 points wide, and marked ⚠;
 * - each element's tooltip gives its status and reason.
 *
 * It colours the drawing's text, before the canvas installs it, rather than the drawing on show:
 * the canvas adapts a drawing to a dark theme from its colours, so a drawing coloured here is
 * adapted as the runner's final one is. `test/run-colours.test.ts` holds the result to drawings the
 * runner made.
 */
import type { LiveStatus } from '../shared/run-protocol.js';
import { elementOf, nameOf } from './flow.js';

const SVG = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';
const XML = 'http://www.w3.org/XML/1998/namespace';

/** The runner's palette, the compiler's Okabe-Ito colours. */
const GREEN = '#009e73';
const VERMILLION = '#d55e00';
const GREY = '#999999';
const LIGHT_GREY = '#eeeeee';
const DASHES = '5,2';
const THICK = '2';

const SYMBOLS: Readonly<Record<LiveStatus['status'], string>> = { pass: '✔', fail: '✘', skip: '◌' };
/** What a symbol is drawn at, in points. */
const SYMBOL_SIZE = '20.00';
/**
 * Where the runner's symbol sits, from its element's label, in points: its cell, 28 points wide,
 * ends just before the label's leftmost line starts, and centres the symbol, which puts it 22
 * points before that line, 2.25 points below the middle of the label's lines.
 */
const SYMBOL_OFFSET = { x: -22, y: 2.25 };
/** The mark of a file or a variable that is a problem, and where it sits from the label: in a 22-point cell. */
const WARNING = { glyph: '⚠', size: '14.00', x: -17.13, y: 2.25 };
/**
 * The mark of an element whose step runs: a symbol, in the cell its status's symbol will take, so
 * that it reads without colour, as the statuses do. Not the runner's: it never draws a run under
 * way.
 */
const UNDERWAY = { glyph: '⟳', size: SYMBOL_SIZE, ...SYMBOL_OFFSET };
const UNDERWAY_CLASS = 'jpipe-underway';

const SHAPES = 'polygon, polyline, path, ellipse';

/** Graphviz's elements, by the class it gives them. */
const groups = (root: ParentNode, kind: 'node' | 'edge'): Element[] =>
    Array.from(root.querySelectorAll(`g[class~="${kind}"]`));

/** A number as Graphviz writes one: at most two decimals, none when they are zeros. */
const points = (value: number): string => String(Math.round(value * 100) / 100);

/**
 * `svgText`, the runner's drawing of a run before its first step, with `statuses` drawn over it.
 * Text that is no drawing is given back as it is.
 */
export function colourRun(svgText: string, statuses: readonly LiveStatus[]): string {
    if (statuses.length === 0) return svgText;
    let doc: Document;
    try {
        doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    } catch {
        return svgText;
    }
    if (doc.documentElement.nodeName !== 'svg') return svgText;
    const byId = new Map(statuses.map(status => [status.id, status]));
    // An element's node is the one the runner gave its id: a file's or a variable's is `nodeN`,
    // a placeholder's is named after the element that fills it.
    const elements = new Set(groups(doc, 'node')
        .filter(node => node.getAttribute('id') === nameOf(node) && elementOf(nameOf(node)) === nameOf(node))
        .map(nameOf));
    const decided = [...byId.values()];
    for (const node of groups(doc, 'node')) {
        const name = nameOf(node);
        const status = elements.has(name) ? byId.get(name) : undefined;
        if (status) colourNode(doc, node, status);
        else if (name.startsWith('artifact ')) colourFile(doc, node, name.slice('artifact '.length), decided);
        else if (name.startsWith('variable ')) colourVariable(doc, node, byId, elements);
    }
    for (const edge of groups(doc, 'edge')) {
        const name = nameOf(edge);
        const cut = name.indexOf('->');
        if (cut < 0) continue;
        const head = name.slice(cut + 2);
        const status = byId.get(elementOf(name.slice(0, cut)));
        // A support: what an element, or the placeholder of the slot it fills, supports. Not a
        // file it observes, a variable it produces, or the link to its own placeholder.
        if (status && elements.has(head)) colourEdge(edge, status);
    }
    return new XMLSerializer().serializeToString(doc);
}

function colourNode(doc: Document, node: Element, status: LiveStatus): void {
    const shapes = Array.from(node.querySelectorAll(SHAPES));
    const labels = Array.from(node.querySelectorAll('text'));
    // The outline: what a filled status fills. A note's fold is drawn as polylines, never filled.
    const outline = shapes.find(shape => shape.tagName.toLowerCase() !== 'polyline');
    switch (status.status) {
        case 'pass':
            for (const shape of shapes) paint(shape, { stroke: GREEN, 'stroke-width': THICK });
            break;
        case 'fail':
            if (outline) outline.setAttribute('fill', VERMILLION);
            for (const shape of shapes) shape.setAttribute('stroke-width', THICK);
            for (const label of labels) label.setAttribute('fill', 'white');
            break;
        case 'skip':
            if (outline) outline.setAttribute('fill', LIGHT_GREY);
            for (const shape of shapes) {
                paint(shape, { stroke: GREY, ...(status.rootCause ? { 'stroke-width': THICK } : {}), 'stroke-dasharray': DASHES });
            }
            break;
    }
    const mark = { glyph: SYMBOLS[status.status], size: SYMBOL_SIZE, ...SYMBOL_OFFSET, fill: status.status === 'fail' ? 'white' : null };
    if (labels.length > 0) labels[0].before(symbolFor(doc, labels, mark));
    withTooltip(doc, node, status);
}

/** A file: in vermillion and marked ⚠ once an element that observes it could not reach it. */
function colourFile(doc: Document, node: Element, declared: string, decided: readonly LiveStatus[]): void {
    if (!decided.some(status => status.unreachable.includes(declared))) return;
    for (const shape of Array.from(node.querySelectorAll(SHAPES))) paint(shape, { stroke: VERMILLION, 'stroke-width': THICK });
    const labels = Array.from(node.querySelectorAll('text'));
    if (labels.length > 0) labels[0].before(symbolFor(doc, labels, { ...WARNING, fill: null }));
}

/**
 * A variable: dashed and grey once the element that produces it is decided without producing it.
 * Its producer is the element its `produces` edge comes from. A variable drawn as a problem
 * already, in vermillion, stays so: it has no single producer, or no consumer.
 */
function colourVariable(doc: Document, node: Element, byId: ReadonlyMap<string, LiveStatus>, elements: ReadonlySet<string>): void {
    const name = nameOf(node);
    const variable = name.slice('variable '.length).split(' from ')[0];
    const producers = groups(doc, 'edge')
        .map(edge => nameOf(edge).split('->'))
        .filter(([tail, head]) => head === name && elements.has(tail))
        .map(([tail]) => byId.get(tail));
    const unproduced = producers.some(status => status && !status.produced.includes(variable));
    const shapes = Array.from(node.querySelectorAll(SHAPES));
    if (!unproduced || shapes.some(shape => shape.getAttribute('stroke') === VERMILLION)) return;
    for (const shape of shapes) paint(shape, { stroke: GREY, 'stroke-dasharray': DASHES });
}

/** A mark, in its cell before the label: at its offset from the label, in the label's font. */
interface Mark {
    glyph: string;
    size: string;
    x: number;
    y: number;
    fill: string | null;
}

function symbolFor(doc: Document, labels: readonly Element[], mark: Mark): Element {
    const xs = labels.map(label => Number.parseFloat(label.getAttribute('x') ?? '0'));
    const ys = labels.map(label => Number.parseFloat(label.getAttribute('y') ?? '0'));
    const symbol = doc.createElementNS(SVG, 'text');
    symbol.setAttributeNS(XML, 'xml:space', 'preserve');
    symbol.setAttribute('text-anchor', 'start');
    symbol.setAttribute('x', points(Math.min(...xs) + mark.x));
    symbol.setAttribute('y', points(ys.reduce((sum, y) => sum + y, 0) / ys.length + mark.y));
    const family = labels[0].getAttribute('font-family');
    if (family) symbol.setAttribute('font-family', family);
    symbol.setAttribute('font-size', mark.size);
    if (mark.fill) symbol.setAttribute('fill', mark.fill);
    symbol.textContent = mark.glyph;
    return symbol;
}

/**
 * The status and its reason as the node's tooltip, the way Graphviz writes one: what the node
 * draws, in a link titled with it. The node's own `<title>`, its name, stays first.
 */
function withTooltip(doc: Document, node: Element, status: LiveStatus): void {
    const group = doc.createElementNS(SVG, 'g');
    group.setAttribute('id', `a_${nameOf(node)}`);
    const link = doc.createElementNS(SVG, 'a');
    link.setAttributeNS(XLINK, 'xlink:title', status.reason ? `${status.status}: ${status.reason}` : status.status);
    for (const child of Array.from(node.children)) {
        if (child.tagName.toLowerCase() !== 'title') link.append(child);
    }
    group.append(link);
    node.append(group);
}

function colourEdge(edge: Element, status: LiveStatus): void {
    const colour = { pass: GREEN, fail: VERMILLION, skip: GREY }[status.status];
    for (const shape of Array.from(edge.querySelectorAll(SHAPES))) {
        const line = shape.tagName.toLowerCase() === 'path';
        paint(shape, {
            stroke: colour,
            // The arrowhead is filled with the line's colour.
            ...(line ? {} : { fill: colour }),
            ...(status.status === 'fail' ? { 'stroke-width': THICK } : {}),
            ...(status.status === 'skip' && line ? { 'stroke-dasharray': DASHES } : {})
        });
    }
}

function paint(shape: Element, attributes: Readonly<Record<string, string>>): void {
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
}

/**
 * Mark the elements whose step runs with ⟳ in the drawing on show, and unmark the others: a mark of
 * the page's own, not the runner's, so it is set on the live drawing, after the canvas has
 * installed it and adapted it to the theme. It takes the label's colour, as a status's symbol does.
 */
export function markUnderway(svg: SVGSVGElement, ids: readonly string[]): void {
    const underway = new Set(ids);
    for (const node of groups(svg, 'node')) {
        const marked = node.querySelector(`text.${UNDERWAY_CLASS}`);
        if (!underway.has(nameOf(node))) {
            marked?.remove();
            continue;
        }
        const labels = Array.from(node.querySelectorAll('text'));
        if (marked || labels.length === 0) continue;
        const symbol = symbolFor(svg.ownerDocument, labels, { ...UNDERWAY, fill: labels[0].getAttribute('fill') });
        symbol.setAttribute('class', UNDERWAY_CLASS);
        labels[0].before(symbol);
    }
}
