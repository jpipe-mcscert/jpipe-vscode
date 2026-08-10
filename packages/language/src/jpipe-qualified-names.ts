/**
 * Where a model's name shows up once it is written into a qualified identifier.
 *
 * A model name is not confined to its declaration and the references that point at it. Because an
 * override is matched to its `@support` **by string**, a justification implementing template `T`
 * spells the override `evidence T:a`, and every relation touching it says `T:a` too. Those are not
 * cross-references to `T` — `T:a` resolves to the element — so nothing in the index connects them
 * to the template, and a rename that only rewrites references leaves them behind, pointing at a
 * name that no longer exists.
 *
 * Reading the segments off the CST rather than splitting the text keeps every range exact:
 * whitespace is hidden in this grammar, so `T : a` is a legal spelling of the same identifier and
 * only the CST knows where its three pieces actually are.
 *
 * Pure functions over an AST — no services — so the rename provider and its tests reach the same
 * answer without a workspace.
 */
import type { CstNode } from 'langium';
import { TextEdit } from 'vscode-languageserver-types';
import { isJustification, isTemplate, type Justification, type Template, type Unit } from './generated/ast.js';

/** How a model can be named in one document: its own id, or an alias followed by its id. */
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

/**
 * How the identifier relates to the model whose name it starts with.
 *
 * `names` — the identifier *is* the model: `implements T`, or a composition parameter. The match
 * has to be exact, or renaming template `T` would also rewrite the unrelated `T:a` next to it.
 *
 * `qualifies` — the model's name introduces something else, as in the override `evidence T:a`.
 * Here at least one further segment must follow, or renaming template `T` would rewrite a local
 * element that merely happens to be called `T`.
 */
type Role = 'names' | 'qualifies';

/**
 * Rewrites the one segment that spells the model's name, leaving the rest of the identifier alone.
 *
 * The longest matching prefix wins, so a model visible both plainly and under an alias has
 * `lib:T:a` attributed to `lib:T` rather than to a local `T` that happens to share the name.
 */
function segmentEdit(
    cst: CstNode | undefined,
    prefixes: readonly NamePrefix[],
    newName: string,
    role: Role
): TextEdit | undefined {
    const segments = segmentNodes(cst);
    if (segments.length === 0) return undefined;

    let matched: NamePrefix | undefined;
    for (const prefix of prefixes) {
        const fits = role === 'names'
            ? segments.length === prefix.length
            : segments.length > prefix.length;
        if (!fits) continue;
        if (!prefix.every((segment, index) => segments[index].text === segment)) continue;
        if (!matched || prefix.length > matched.length) matched = prefix;
    }
    if (!matched) return undefined;

    return TextEdit.replace(segments[matched.length - 1].range, newName);
}

/** The models declared directly in a unit. */
export function modelsOf(unit: Unit): Array<Justification | Template> {
    return unit.body.filter((body): body is Justification | Template =>
        isJustification(body) || isTemplate(body));
}

/**
 * Every edit renaming a model to `newName` requires in one unit, given the spellings under which
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
