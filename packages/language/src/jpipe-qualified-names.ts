/**
 * Where a name shows up once it is written into a qualified identifier.
 *
 * Neither a model's name nor an element's is confined to its declaration and the references that
 * point at it. Because an override is matched to its `@support` **by string**, a justification
 * implementing template `T` spells the override `evidence T:abs`, and every relation touching it
 * says `T:abs` too. Those are not cross-references to `T` — and the override is not a reference to
 * the `@support` at all, it is a second declaration that agrees with it — so nothing in the index
 * connects them, and a rename that only rewrites references leaves them behind, agreeing with a
 * name that no longer exists.
 *
 * Reading the segments off the CST rather than splitting the text keeps every range exact:
 * whitespace is hidden in this grammar, so `T : a` is a legal spelling of the same identifier and
 * only the CST knows where its three pieces actually are.
 *
 * Pure functions over an AST — no services — so the rename provider and its tests reach the same
 * answer without a workspace.
 */
import { GrammarUtils, type AstNode, type CstNode } from 'langium';
import { TextEdit } from 'vscode-languageserver-types';
import {
    isJustification,
    isTemplate,
    type Justification,
    type JustificationElement,
    type Template,
    type Unit
} from './generated/ast.js';
import { HOOK_KEY } from './jpipe-operators.js';
import { hookTarget } from './jpipe-utils.js';

/** An identifier written out segment by segment — `['lib', 'T', 'abs']` for `lib:T:abs`. */
export type NamePrefix = readonly string[];

/**
 * The identifier segments of a qualified id or reference, in source order.
 *
 * `QualifiedId` and `QualifiedRef` both parse to a composite node alternating identifier leaves
 * with `:` separators, so the segments are the children that are not a separator — a distinction
 * the `ID` terminal makes safe, since `[\w_]+` can never produce a colon.
 */
export function segmentNodes(cst: CstNode | undefined): CstNode[] {
    if (!cst) return [];
    const children = (cst as { content?: CstNode[] }).content;
    if (!children || children.length === 0) return [cst];
    return children.filter(child => child.text !== ':');
}

/** The models declared directly in a unit. */
export function modelsOf(unit: Unit): Array<Justification | Template> {
    return unit.body.filter((body): body is Justification | Template =>
        isJustification(body) || isTemplate(body));
}

/**
 * How the identifier relates to the name it starts with.
 *
 * `names` — the identifier *is* the name: `implements T`, or a composition parameter. The match
 * has to be exact, or renaming template `T` would also rewrite the unrelated `T:a` beside it.
 *
 * `qualifies` — the name introduces something else, as in the override `evidence T:a`. At least
 * one further segment must follow, or renaming template `T` would rewrite a local element that
 * merely happens to be called `T`.
 */
type Role = 'names' | 'qualifies';

/**
 * Rewrites the one segment that spells the name, leaving the rest of the identifier alone.
 *
 * The longest matching spelling wins, so a model visible both plainly and under an alias has
 * `lib:T:a` attributed to `lib:T` rather than to a local `T` that happens to share the name.
 */
function segmentEdit(
    cst: CstNode | undefined,
    spellings: readonly NamePrefix[],
    newName: string,
    role: Role
): TextEdit | undefined {
    const segments = segmentNodes(cst);
    if (segments.length === 0) return undefined;

    let matched: NamePrefix | undefined;
    for (const spelling of spellings) {
        const fits = role === 'names'
            ? segments.length === spelling.length
            : segments.length > spelling.length;
        if (!fits) continue;
        if (!spelling.every((segment, index) => segments[index].text === segment)) continue;
        if (!matched || spelling.length > matched.length) matched = spelling;
    }
    if (!matched) return undefined;

    return TextEdit.replace(segments[matched.length - 1].range, newName);
}

/** Rewrites the last segment of an identifier, whatever qualifies it. */
function lastSegmentEdit(cst: CstNode | undefined, newName: string): TextEdit | undefined {
    const last = segmentNodes(cst).at(-1);
    return last ? TextEdit.replace(last.range, newName) : undefined;
}

/**
 * Every edit renaming a *model* to `newName` requires in one unit, given the spellings under which
 * that unit can name it.
 *
 * The declaration itself is not included: it is one edit in one document, and the caller knows
 * which. Everything here is a *usage* — a reference to the model, or its name used as a qualifier.
 */
export function qualifierEdits(
    unit: Unit,
    prefixes: readonly NamePrefix[],
    newName: string
): TextEdit[] {
    if (prefixes.length === 0) return [];
    const edits: TextEdit[] = [];
    const collect = (cst: CstNode | undefined, role: Role) => {
        const edit = segmentEdit(cst, prefixes, newName, role);
        if (edit) edits.push(edit);
    };

    for (const model of modelsOf(unit)) {
        collect(model.parent?.$refNode, 'names');
        for (const ref of model.composition?.params?.refs ?? []) {
            collect(ref.$refNode, 'names');
        }
        for (const element of model.contents?.body ?? []) {
            collect(element.id?.$cstNode, 'qualifies');
        }
        for (const relation of model.contents?.rels ?? []) {
            collect(relation.from?.$refNode, 'qualifies');
            collect(relation.to?.$refNode, 'qualifies');
        }
    }
    return edits;
}

/**
 * How an element named `name` in a model is written from *outside* that model: the model's name
 * followed by the element's.
 *
 * That is how an override is spelled, and so also how relations referring to the override are
 * spelled. `prefixes` are the spellings of the owning model in the document being looked at, so a
 * template loaded under an alias contributes `lib:T:abs` as well as `T:abs`.
 */
function restatements(prefixes: readonly NamePrefix[], name: string): NamePrefix[] {
    return prefixes.map(prefix => [...prefix, name]);
}

/**
 * The declarations in `unit` that restate an element of the model `prefixes` names — its overrides.
 *
 * An override is found by how it is written, because that is all it is: `evidence T:abs` overrides
 * `@support abs` by agreeing with the text after `implements`, and no link records the fact.
 */
export function overridesIn(
    unit: Unit,
    prefixes: readonly NamePrefix[],
    name: string
): JustificationElement[] {
    const spellings = restatements(prefixes, name);
    const found: JustificationElement[] = [];
    for (const model of modelsOf(unit)) {
        for (const element of model.contents?.body ?? []) {
            const parts = element.id?.parts ?? [];
            if (spellings.some(spelling =>
                spelling.length === parts.length && spelling.every((s, i) => parts[i] === s))) {
                found.push(element);
            }
        }
    }
    return found;
}

/**
 * Every edit renaming an *element* to `newName` requires in one unit.
 *
 * Relations are matched two ways, in this order. One resolving to any of the `affected`
 * declarations is renamed whatever it is spelled — which is what carries the short-name alias the
 * scope provider registers, where a relation says `abs` and means the template's. Otherwise the
 * identifier is matched by spelling, which is what carries a relation whose reference does not
 * resolve, as every relation in a file does while its `implements` line is being typed: a file
 * should come out of a rename no more broken than it went in.
 *
 * The declarations themselves come from `affected`, which the caller has already gathered across
 * the whole workspace — an override cannot be recognised from the document it sits in alone.
 */
export function elementEdits(
    unit: Unit,
    prefixes: readonly NamePrefix[],
    name: string,
    affected: ReadonlySet<AstNode>,
    newName: string
): TextEdit[] {
    const spellings = restatements(prefixes, name);
    const edits: TextEdit[] = [];
    const push = (edit: TextEdit | undefined) => { if (edit) edits.push(edit); };

    for (const model of modelsOf(unit)) {
        for (const element of model.contents?.body ?? []) {
            if (affected.has(element)) push(lastSegmentEdit(element.id?.$cstNode, newName));
        }
        for (const relation of model.contents?.rels ?? []) {
            for (const reference of [relation.from, relation.to]) {
                if (!reference) continue;
                push(reference.ref && affected.has(reference.ref)
                    ? lastSegmentEdit(reference.$refNode, newName)
                    : segmentEdit(reference.$refNode, spellings, newName, 'names'));
            }
        }
    }
    return edits;
}

/**
 * Every edit renaming an element requires in one unit's `refine` hooks.
 *
 * A hook is a name in a string — `refine(Base, Ref) { hook: "e" }` — so it is the same problem as
 * an override one step further from the type system: not a reference, not even a qualified id, and
 * invisible to a rename that follows either. It is separate from `elementEdits` because it is
 * matched differently. An override is recognised by how it is spelled; a hook is recognised by
 * *what it resolves to*, since `hookTarget` is the only thing that knows a bare `a` may name an
 * element declared `T:a`. Identity is also what keeps a same-named element of an unrelated model
 * out of the rename — spelling alone could not tell the two apart.
 *
 * A composed base is passed over, exactly as the validator passes it over: its hooks resolve
 * through aliases that appear only once an operator has run, so nothing here can say whether one
 * names the element being renamed. That is the known cost — rename a hooked element of a composed
 * model and the hook keeps the old spelling — and it is the honest half of a guess.
 *
 * Only the last segment is rewritten, so `"T:a"` becomes `"T:b"` and the qualifier survives.
 */
export function hookEdits(
    unit: Unit,
    affected: ReadonlySet<AstNode>,
    newName: string
): TextEdit[] {
    const edits: TextEdit[] = [];
    for (const model of modelsOf(unit)) {
        const composition = model.composition;
        if (composition?.operator !== 'refine') continue;

        const entry = composition.config?.entries.find(candidate => candidate.key === HOOK_KEY);
        if (!entry?.value) continue;
        const base = composition.params?.refs[0]?.ref;
        if (!base || base.composition) continue;

        const target = hookTarget(base, entry.value);
        if (!target || !affected.has(target)) continue;

        const edit = stringTailEdit(GrammarUtils.findNodeForProperty(entry.$cstNode, 'value'), newName);
        if (edit) edits.push(edit);
    }
    return edits;
}

/**
 * Replaces the last `:`-separated segment *inside* a string literal, quotes left alone.
 *
 * The value is one token, so unlike a qualified id there is no CST to read the segments off and
 * the offsets have to be counted in the token's own text. Counting it rather than rebuilding the
 * literal is what keeps the user's quote style, escapes and spacing untouched — only the name
 * moves. A literal broken across lines is declined rather than guessed at: the grammar's STRING
 * permits one, and the arithmetic here is single-line.
 */
function stringTailEdit(cst: CstNode | undefined, newName: string): TextEdit | undefined {
    if (!cst || cst.range.start.line !== cst.range.end.line) return undefined;
    const text = cst.text;
    if (text.length < 2) return undefined;

    const content = text.slice(1, -1);
    const start = cst.range.start.character + 1 + content.lastIndexOf(':') + 1;
    const end = cst.range.end.character - 1;
    if (start > end) return undefined;

    return TextEdit.replace({
        start: { line: cst.range.start.line, character: start },
        end: { line: cst.range.start.line, character: end }
    }, newName);
}
