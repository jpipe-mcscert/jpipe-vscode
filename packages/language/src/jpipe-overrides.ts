/**
 * What an id written in a model names among the elements it inherits, read on the contents of the
 * template it implements (jpipe-vscode ADR-VSC-0034), as the compiler binds it.
 *
 * An override is matched to its `@support` by how it is written: `evidence T:a` names the element
 * `T:a` that the model inherits. The compiler binds such an id as it binds any id the source writes
 * (`JustificationModel.bind`): the element with exactly that id, or else the one inherited element
 * whose id ends with it, so `evidence T:a` also names `lib:T:a`. Several such elements are an
 * ambiguity, `ambiguous-id`, reported rather than settled by order (jpipe-compiler ADR-0012):
 * under a template that `assemble` built from two models implementing one template, `top:h` names
 * both `l:top:h` and `r:top:h`.
 */
import { AstUtils } from 'langium';
import type { Justification, Template } from './generated/ast.js';
import { listedIn, type ModelContents } from './jpipe-model-contents.js';
import { inheritedId, qualify, writtenNamespace, type ModelElement } from './jpipe-utils.js';

/**
 * The elements `model` inherits, under the ids they have in it, or `undefined` when it implements
 * nothing this can read.
 *
 * `whole` says whether they are all of them. When the template's contents cannot tell, these are
 * the ones its bodies show: each is certainly inherited, since a body below the composition
 * replaces what the composition built, but others are hidden, so nothing may be concluded from
 * one being absent, nor from an id naming only one of them.
 */
export async function inheritedElements(
    model: Justification | Template,
    contents: ModelContents
): Promise<{ readonly elements: readonly ModelElement[]; readonly whole: boolean } | undefined> {
    const parent = model.parent?.ref;
    if (!parent) return undefined;
    const namespace = writtenNamespace(model.parent?.$refText, parent.id);
    const answer = await contents.contentsOf(parent, namespace, AstUtils.getDocument(model));
    const parentName = qualify(namespace, parent.id);
    return {
        elements: listedIn(answer).map(entry => ({ ...entry, id: inheritedId(parentName, entry.id) })),
        whole: answer.kind === 'elements'
    };
}

export { bind, type Binding } from './jpipe-utils.js';
