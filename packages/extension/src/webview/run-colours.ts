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
 * - a source an element observed (a file, a glob, a value, a variable of the environment) is marked
 *   ✔ once it was reached, and ⚠ in vermillion, 2 points wide, when it could not be: as soon as
 *   the runner observes it, before the step that observes it is called;
 * - each element's tooltip gives its status and reason.
 *
 * It colours the drawing's text, before the canvas installs it, rather than the drawing on show:
 * the canvas adapts a drawing to a dark theme from its colours, so a drawing coloured here is
 * adapted as the runner's final one is. `test/run-colours.test.ts` holds the result to drawings the
 * runner made.
 */
import type { LiveStatus, ObservedSource } from '../shared/run-protocol.js';
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
/** A source's marks, and where they sit from its label: in a 22-point cell, at 14 points. */
const SOURCE_MARK = { size: '14.00', x: -17.13, y: 2.25 };
const OBSERVED = '✔';
const WARNING = '⚠';
/**
 * The marks of a run under way, each a symbol drawn in the cell its element's status will take, so
 * that they read without colour, as the statuses do. They are the Results view's icons for the
 * same rows, drawn as shapes since the drawing has no icon font: a circle with a gap, which spins,
 * for an element whose step runs (`loading~spin`), and a clock for one waiting for its turn
 * (`clock`). Not the runner's: it never draws a run under way.
 */
const MARKS = { underway: 'jpipe-underway', pending: 'jpipe-pending' } as const;
/**
 * The middle of a status's cell, from its label: the cell, 28 points wide, ends 2 points before
 * the label's leftmost line, and is centred on the label's lines, whose middle lies about 4.5
 * points above the middle of their baselines.
 */
const CELL_CENTRE = { x: -16, y: -4.5 };
/** How big a mark is drawn, in points: about the size of a status's symbol. */
const MARK_RADIUS = 7;

const SHAPES = 'polygon, polyline, path, ellipse';

/** Graphviz's elements, by the class it gives them. */
const groups = (root: ParentNode, kind: 'node' | 'edge'): Element[] =>
    Array.from(root.querySelectorAll(`g[class~="${kind}"]`));

/** A number as Graphviz writes one: at most two decimals, none when they are zeros. */
const points = (value: number): string => String(Math.round(value * 100) / 100);

/**
 * `svgText`, the runner's drawing of a run before its first step, with `statuses` drawn over it,
 * and the sources it `observed` so far marked. Text that is no drawing is given back as it is.
 */
export function colourRun(svgText: string, statuses: readonly LiveStatus[], observed: readonly ObservedSource[] = []): string {
    if (statuses.length === 0 && observed.length === 0) return svgText;
    const doc = parsed(svgText);
    if (!doc) return svgText;
    const byId = new Map(statuses.map(status => [status.id, status]));
    const elements = elementNames(doc);
    const reached = sourcesReached(statuses, observed);
    for (const node of groups(doc, 'node')) {
        const name = nameOf(node);
        const status = elements.has(name) ? byId.get(name) : undefined;
        if (status) colourNode(doc, node, status);
        else if (name.startsWith('artifact ')) colourSource(doc, node, reached.get(name.slice('artifact '.length)));
        else if (name.startsWith('variable ')) colourVariable(doc, node, byId, elements);
    }
    colourSupports(doc, byId, elements);
    return new XMLSerializer().serializeToString(doc);
}

/** The drawing in `svgText`, or null when it is none. */
function parsed(svgText: string): Document | null {
    try {
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        return doc.documentElement.nodeName === 'svg' ? doc : null;
    } catch {
        return null;
    }
}

/**
 * The names of the elements' nodes: an element's node is the one the runner gave its id. A file's
 * or a variable's is `nodeN`, and a placeholder's is named after the element that fills it.
 */
function elementNames(doc: Document): Set<string> {
    return new Set(groups(doc, 'node')
        .filter(node => node.getAttribute('id') === nameOf(node) && elementOf(nameOf(node)) === nameOf(node))
        .map(nameOf));
}

/**
 * Whether each source observed so far was reached, by the name the drawing gives it: false as soon
 * as one element could not reach it, as the runner draws it. What the events said of it as it was
 * observed, and what a decided element says it could not reach.
 */
function sourcesReached(statuses: readonly LiveStatus[], observed: readonly ObservedSource[]): Map<string, boolean> {
    const reached = new Map<string, boolean>();
    for (const { source, reachable } of observed) reached.set(source, (reached.get(source) ?? true) && reachable);
    for (const source of statuses.flatMap(status => status.unreachable)) reached.set(source, false);
    return reached;
}

/**
 * The supports a decided element starts, in its status's colour: from the element, or from the
 * placeholder of the slot it fills, to another element. Not what links it to a file it observes, a
 * variable it produces, or its own placeholder.
 */
function colourSupports(doc: Document, byId: ReadonlyMap<string, LiveStatus>, elements: ReadonlySet<string>): void {
    for (const edge of groups(doc, 'edge')) {
        const [tail, head] = nameOf(edge).split('->');
        const status = head === undefined ? undefined : byId.get(elementOf(tail));
        if (status && elements.has(head)) colourEdge(edge, status);
    }
}

/** How each status paints an element's shapes and label, given the outline a fill goes to. */
const PAINTERS: Readonly<Record<LiveStatus['status'], (shapes: Element[], labels: Element[], outline: Element | undefined, status: LiveStatus) => void>> = {
    pass: shapes => {
        for (const shape of shapes) paint(shape, { stroke: GREEN, 'stroke-width': THICK });
    },
    fail: (shapes, labels, outline) => {
        outline?.setAttribute('fill', VERMILLION);
        for (const shape of shapes) shape.setAttribute('stroke-width', THICK);
        for (const label of labels) label.setAttribute('fill', 'white');
    },
    skip: (shapes, _labels, outline, status) => {
        outline?.setAttribute('fill', LIGHT_GREY);
        const width: Record<string, string> = status.rootCause ? { 'stroke-width': THICK } : {};
        for (const shape of shapes) paint(shape, { stroke: GREY, ...width, 'stroke-dasharray': DASHES });
    }
};

function colourNode(doc: Document, node: Element, status: LiveStatus): void {
    const shapes = Array.from(node.querySelectorAll(SHAPES));
    const labels = Array.from(node.querySelectorAll('text'));
    // The outline: what a filled status fills. A note's fold is drawn as polylines, never filled.
    PAINTERS[status.status](shapes, labels, shapes.find(shape => shape.tagName.toLowerCase() !== 'polyline'), status);
    const mark = { glyph: SYMBOLS[status.status], size: SYMBOL_SIZE, ...SYMBOL_OFFSET, fill: status.status === 'fail' ? 'white' : null };
    if (labels.length > 0) labels[0].before(symbolFor(doc, labels, mark));
    withTooltip(doc, node, status);
}

/**
 * A source, once observed: ✔ when it was reached, ⚠ in vermillion when it could not be. One not
 * observed yet (`reached` undefined) is drawn as before the run.
 */
function colourSource(doc: Document, node: Element, reached: boolean | undefined): void {
    if (reached === undefined) return;
    if (!reached) {
        for (const shape of Array.from(node.querySelectorAll(SHAPES))) paint(shape, { stroke: VERMILLION, 'stroke-width': THICK });
    }
    const labels = Array.from(node.querySelectorAll('text'));
    if (labels.length > 0) labels[0].before(symbolFor(doc, labels, { ...SOURCE_MARK, glyph: reached ? OBSERVED : WARNING, fill: null }));
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

/**
 * What a mark before the labels is placed from: where the leftmost of their lines starts, and the
 * middle of their baselines.
 */
function labelsOrigin(labels: readonly Element[]): { x: number; y: number } {
    const xs = labels.map(label => Number.parseFloat(label.getAttribute('x') ?? '0'));
    const ys = labels.map(label => Number.parseFloat(label.getAttribute('y') ?? '0'));
    return { x: Math.min(...xs), y: ys.reduce((sum, y) => sum + y, 0) / ys.length };
}

function symbolFor(doc: Document, labels: readonly Element[], mark: Mark): Element {
    const origin = labelsOrigin(labels);
    const symbol = doc.createElementNS(SVG, 'text');
    symbol.setAttributeNS(XML, 'xml:space', 'preserve');
    symbol.setAttribute('text-anchor', 'start');
    symbol.setAttribute('x', points(origin.x + mark.x));
    symbol.setAttribute('y', points(origin.y + mark.y));
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

/** Where a run under way is: the elements whose step runs, and those waiting for their turn. */
export interface RunMarks {
    underway: readonly string[];
    pending: readonly string[];
}

/**
 * Mark the elements of a run under way in the drawing on show, running and waiting, and unmark
 * the others: marks of the page's own, not the runner's, so they are set on the live drawing,
 * after the canvas has installed it and adapted it to the theme. Each takes the label's colour, as
 * a status's symbol does. A decided element has its status's symbol instead, in the drawing itself.
 */
export function markProgress(svg: SVGSVGElement, marks: RunMarks): void {
    const kinds = new Map<string, keyof typeof MARKS>([
        ...marks.pending.map(id => [id, 'pending'] as const),
        ...marks.underway.map(id => [id, 'underway'] as const)
    ]);
    const selector = Object.values(MARKS).map(className => `g.${className}`).join(', ');
    for (const node of groups(svg, 'node')) {
        const wanted = kinds.get(nameOf(node));
        const marked = node.querySelector(selector);
        if (marked && (!wanted || marked.getAttribute('class') !== MARKS[wanted])) marked.remove();
        if (!wanted || (marked?.isConnected ?? false)) continue;
        const labels = Array.from(node.querySelectorAll('text'));
        if (labels.length > 0) labels[0].before(markFor(svg.ownerDocument, labels, wanted));
    }
}

/** A mark, drawn in the middle of the status's cell, in the label's colour (black, SVG's default). */
function markFor(doc: Document, labels: readonly Element[], kind: keyof typeof MARKS): Element {
    const origin = labelsOrigin(labels);
    const cx = origin.x + CELL_CENTRE.x;
    const cy = origin.y + CELL_CENTRE.y;
    const colour = labels[0].getAttribute('fill') ?? 'black';
    const shape = (tag: string, attributes: Readonly<Record<string, string>>): Element => {
        const el = doc.createElementNS(SVG, tag);
        paint(el, { fill: 'none', stroke: colour, 'stroke-linecap': 'round', ...attributes });
        return el;
    };
    const group = doc.createElementNS(SVG, 'g');
    group.setAttribute('class', MARKS[kind]);
    const r = MARK_RADIUS;
    const circle = { cx: points(cx), cy: points(cy), r: String(r) };
    if (kind === 'underway') {
        // Three quarters of a circle, as the Results view's spinner.
        const quarter = (Math.PI * r) / 2;
        group.append(shape('circle', { ...circle, 'stroke-width': '2', 'stroke-dasharray': `${points(3 * quarter)} ${points(quarter)}` }));
    } else {
        // A clock face, its hands at three o'clock.
        group.append(
            shape('circle', { ...circle, 'stroke-width': '1.5' }),
            shape('path', { d: `M${points(cx)},${points(cy - r * 0.6)} V${points(cy)} H${points(cx + r * 0.5)}`, 'stroke-width': '1.5' })
        );
    }
    return group;
}
