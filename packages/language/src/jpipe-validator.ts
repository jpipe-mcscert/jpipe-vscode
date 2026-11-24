import * as path from 'node:path';
import { AstUtils, GrammarUtils, type LangiumDocument, type ValidationAcceptor, type ValidationChecks } from 'langium';
import { GlobExpansionError, isGlobPattern } from './jpipe-glob.js';
import {
    type JpipeAstType,
    type Unit,
    type Composition,
    type Evidence,
    type Strategy,
    type Conclusion,
    type SubConclusion,
    type AbstractSupport,
    type Template,
    type Justification,
    type JustificationElement,
    type Load,
    type Relation,
    isAbstractSupport,
    isConclusion,
    isEvidence,
    isJustification,
    isStrategy,
    isSubConclusion
} from './generated/ast.js';
import type { JpipeServices } from './jpipe-module.js';
import type { JpipeServerLogger } from './jpipe-logger.js';
import type { JpipeImportService, ModelDeclaration } from './jpipe-import.js';
import type { JpipeUnificationService } from './jpipe-unification.js';
import {
    HOOK_KEY,
    UNIFY_BY_KEY,
    allowedConfigKeys,
    arityPhrase,
    isKnownOperator,
    knownOperatorNames,
    operatorSpec,
    requiredConfigKeys
} from './jpipe-operators.js';
import {
    fsPathOf, getLocalElements, buildsOnCycle, implementsCycle, isDiscardedConclusion, qualifiedIdText, writtenNamespace,
    type ModelElement
} from './jpipe-utils.js';
import { hookTarget, type ModelContents } from './jpipe-model-contents.js';
import { bind, inheritedElements } from './jpipe-overrides.js';
import { JpipeIssue, report } from './jpipe-diagnostic-codes.js';
import { byCodeUnit } from './jpipe-text.js';
import { concreteKeywordFor, keywordFor } from './jpipe-render.js';
import { messageOf } from './jpipe-errors.js';

export function registerValidationChecks(services: JpipeServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.JpipeValidator;
    const checks: ValidationChecks<JpipeAstType> = {
        Unit:           [validator.checkUnitNotEmpty, validator.checkDuplicateModels],
        Load:           validator.checkLoadResolves,
        Composition:    [validator.checkOperatorName, validator.checkOperatorArity, validator.checkDuplicateSources, validator.checkConfigKeys, validator.checkUnificationMethod, validator.checkRefineHook],
        Template:       [validator.checkCyclicImplements, validator.checkTemplateHasSupport, validator.checkOverrides, validator.checkDuplicateElementIds, validator.checkModelHasConclusion, validator.checkSingleConclusion],
        Justification:  [validator.checkCyclicImplements, validator.checkOverrides, validator.checkDuplicateElementIds, validator.checkModelHasConclusion, validator.checkSingleConclusion],
        Evidence:       validator.checkLabelNotEmpty,
        Strategy:       [validator.checkLabelNotEmpty, validator.checkStrategyIncomingSupport],
        Conclusion:     [validator.checkLabelNotEmpty, validator.checkInheritedConclusion, validator.checkConclusionIncomingFromStrategy],
        SubConclusion:  validator.checkLabelNotEmpty,
        AbstractSupport: validator.checkLabelNotEmpty
    };
    registry.register(checks, validator);
}

export class JpipeValidator {
    private readonly logger: JpipeServerLogger;
    private readonly importService: JpipeImportService;
    private readonly unification: JpipeUnificationService;
    private readonly contents: ModelContents;

    constructor(services: JpipeServices) {
        this.logger = services.logger;
        this.importService = services.references.JpipeImportService;
        this.unification = services.unification;
        this.contents = services.references.ModelContents;
    }

    /**
     * Flags a `load` statement that resolves to nothing. Without this the failure is silent
     * (only a server-log warning), so a typo'd or broken path — or a path that resolves
     * incorrectly on Windows — looks like it did nothing.
     *
     * Messages deliberately mirror the compiler's own wording (`LoadResolver.expand`), so the
     * same text turns up whether the user hits the problem in the editor or in a build.
     */
    checkLoadResolves(load: Load, accept: ValidationAcceptor): void {
        const document = AstUtils.getDocument(load);

        if (!isGlobPattern(load.path)) {
            const resolved = this.importService.resolveExistingImportPath(load.path, document);
            if (!resolved) {
                report(accept, JpipeIssue.LoadUnresolved, `Cannot resolve load path '${load.path}': no such file.`,
                       { node: load, property: 'path' }, { path: load.path });
            } else {
                this.checkNotSelfLoad([resolved], load, document, accept);
            }
            return;
        }

        let matches: string[];
        try {
            matches = this.importService.expandLoadPath(load.path, document);
        } catch (error) {
            // Each expansion error words itself as the compiler words the matching FATAL.
            const message = error instanceof GlobExpansionError
                ? error.describe(load.path)
                : `Cannot expand load pattern '${load.path}': ${messageOf(error)}`;
            report(accept, JpipeIssue.LoadMalformedPattern, message,
                   { node: load, property: 'path' }, { path: load.path });
            return;
        }
        if (matches.length === 0) {
            report(accept, JpipeIssue.LoadNoMatch, `No file matches load pattern '${load.path}'`,
                   { node: load, property: 'path' }, { path: load.path });
            return;
        }

        this.checkNotSelfLoad(matches, load, document, accept);
    }

    /**
     * Reports a `load` that resolves to the file declaring it.
     *
     * A wide pattern such as `**.jd` naturally matches its own file, which the compiler rejects
     * as a cycle (`LoadResolver.expandOne` seeds its visited set with the source path). Reported
     * here so the editor does not stay silent about a model the compiler will refuse to build.
     */
    private checkNotSelfLoad(
        resolvedPaths: string[],
        load: Load,
        document: LangiumDocument,
        accept: ValidationAcceptor
    ): void {
        const self = resolvedPaths.find(candidate => this.importService.isSameFile(candidate, document));
        if (self) {
            report(accept, JpipeIssue.CyclicLoad, `Circular load detected: ${self}`,
                   { node: load, property: 'path' }, { path: load.path, resolved: self });
        }
    }

    checkOperatorName(composition: Composition, accept: ValidationAcceptor): void {
        if (!isKnownOperator(composition.operator)) {
            report(accept, JpipeIssue.UnknownOperator, `Unknown operator '${composition.operator}'. Expected: ${knownOperatorNames().join(', ')}.`,
                   { node: composition, property: 'operator' }, { actual: composition.operator, known: knownOperatorNames() });
        }
    }

    /**
     * A model given twice to one operator, as the compiler refuses it for every operator
     * (`CompositionOperator.requireDistinctSources`): composing a model with itself either merges
     * every element with its copy or fails on an unrelated unification error. In its words, on
     * each repeat. It is decided by the source alone, so it needs no contents
     * (jpipe-vscode ADR-VSC-0034).
     */
    checkDuplicateSources(composition: Composition, accept: ValidationAcceptor): void {
        const params = composition.params;
        if (!params || !operatorSpec(composition.operator)) return;
        const seen = new Set<string>();
        params.refs.forEach((ref, index) => {
            // Compared by name, as the compiler compares them: a file loaded under two namespaces
            // gives two models, `x:b` and `y:b`, from one declaration. A source that does not
            // resolve is the compiler's `unknown-model`, and it goes no further.
            const source = ref.$refText.replace(/\s+/g, '');
            if (!ref.ref) return;
            if (!seen.has(source)) {
                seen.add(source);
                return;
            }
            report(accept, JpipeIssue.DuplicateSource,
                   `'${composition.operator}' for '${composition.$container.id}': the model '${source}' is given more than once`,
                   { node: params, property: 'refs', index }, { operator: composition.operator, source });
        });
    }

    /**
     * An `implements` that closes a cycle, which the compiler reports as `cyclic-implements` and
     * builds nothing of. A cycle is reported once, as the compiler reports it: by the `implements`
     * of its first model in alphabetical order that has one, in the compiler's words, on the
     * template it names. A model that only implements a template on a cycle is not reported.
     */
    checkCyclicImplements(model: Justification | Template, accept: ValidationAcceptor): void {
        const cycle = implementsCycle(model);
        if (!cycle) return;
        const [reporter] = cycle.filter(link => link.parent !== undefined && !link.composition).map(link => link.id).sort(byCodeUnit);
        if (reporter !== model.id) return;
        report(accept, JpipeIssue.CyclicImplements, `cycle detected: ${describeCycle(cycle)}`,
               { node: model, property: 'parent' }, { modelId: model.id, cycle: cycle.map(link => link.id) });
    }

    /**
     * Checks how many source models a composition passes its operator.
     *
     * Nothing checked this before, so `refine(a)` reached the compiler and failed there —
     * `RefineOperator` throws on anything but two sources, and the grammar allows none at all.
     */
    checkOperatorArity(composition: Composition, accept: ValidationAcceptor): void {
        const spec = operatorSpec(composition.operator);
        if (!spec) return;

        const actual = composition.params?.refs.length ?? 0;
        const { min, max } = spec.arity;
        if (actual >= min && (max === undefined || actual <= max)) return;

        const expected = arityPhrase(min, max);
        // The noun agrees with the number that immediately precedes it.
        const count = max ?? min;
        report(accept, JpipeIssue.OperatorArity, `${composition.operator} requires ${expected} source ${count === 1 ? 'model' : 'models'}, got ${actual}.`,
               { node: composition, property: 'operator' }, { operator: composition.operator, actual, min, ...(max !== undefined ? { max } : {}) });
    }

    /**
     * Checks a composition's config block against the operator's key table.
     *
     * Both halves are errors: the compiler refuses to run without a required key, and from 4.0.0
     * refuses one it does not know too, as `invalid-operator-call`. 3.x ignored an unknown key, but
     * a misspelt key does nothing there either. `JpipeIssueSeverity` records the severities, along
     * with the rule they follow from (jpipe-vscode ADR-VSC-0023).
     */
    checkConfigKeys(composition: Composition, accept: ValidationAcceptor): void {
        const op = composition.operator;
        if (!isKnownOperator(op)) return;
        const allowed = allowedConfigKeys(op);
        const present = new Set(composition.config?.entries.map(e => e.key) ?? []);
        for (const entry of composition.config?.entries ?? []) {
            if (!allowed.includes(entry.key)) {
                report(accept, JpipeIssue.UnknownConfigKey, `Unknown config key '${entry.key}' for operator '${op}'. Allowed: ${allowed.join(', ')}.`,
                       { node: entry, property: 'key' }, { actual: entry.key, operator: op, allowed });
            }
        }
        const allMissing = requiredConfigKeys(op).filter(key => !present.has(key));
        for (const key of allMissing) {
            report(accept, JpipeIssue.MissingConfigKey, `Missing required config key '${key}' for operator '${op}'.`,
                   { node: composition, property: 'operator' }, {
                      missingKey: key,
                      operator: op,
                      allMissing,
                      hasConfigBlock: composition.config !== undefined
                  });
        }
    }

    /**
     * Flags a `unifyBy` naming a relation this workspace does not recognise.
     *
     * **The one exception to jpipe-vscode ADR-VSC-0023**, and the reason the exception exists. The
     * compiler would reject this, so the rule says error — but its registry is populated at
     * startup, so a build may carry relations shipped with neither jPipe core nor this extension.
     * A project with its own is not doing anything wrong, and calling its models broken would be
     * simply wrong. The editor cannot know, so it reports the limit of what it knows — which the
     * settings can widen — and the message is worded to claim exactly that and no more.
     *
     * Staying silent is not the alternative: a typo'd relation name fails the build with nothing
     * having warned, and the value is a plain string that nothing else checks.
     */
    checkUnificationMethod(composition: Composition, accept: ValidationAcceptor): void {
        for (const entry of composition.config?.entries ?? []) {
            if (entry.key !== UNIFY_BY_KEY) continue;
            const actual = entry.value;
            if (!actual || this.unification.isKnown(actual)) continue;
            const known = this.unification.known();
            report(accept, JpipeIssue.UnknownUnificationMethod, `Unknown unification method '${actual}'; registered: ${known.join(', ')}.`,
                   { node: entry, property: 'value' }, { actual, known });
        }
    }

    /**
     * Flags a `refine` whose `hook` names no element of the model being refined.
     *
     * `hook` is a string in the grammar, so nothing links it: a typo, or a rename that passed it
     * by, produced a model that looked fine in the editor and died at build time with
     * `hook element 'x' not found in base model 'B'`. That message is borrowed here, because it is
     * the same defect and jpipe-vscode ADR-VSC-0022 says one defect reads one way.
     *
     * `hookTarget` decides what resolves, and matches the compiler: against the base's contents,
     * under the ids template expansion and the operators give its elements, through the aliases
     * of the base's own operator, then by its suffix fallback. A base built on a composition is
     * read as the compiler built it. Two shapes are passed over instead, each because the editor
     * genuinely cannot answer:
     *
     * - **A base whose contents cannot tell**, when the hook matches none of the ids this can see:
     *   it may name one an operator builds that the compiler could not report, or one inherited
     *   through an `implements` that does not resolve. In the second case the visible problem is
     *   the `implements`, and pointing at the hook would send the user to the wrong line.
     * - **An unresolved first source**, which is a linking error already reported where it is.
     *
     * A missing `hook` is `missing-config-key`'s business and is left alone. An empty one is not:
     * the key is present, so nothing else reports it, and the compiler looks `''` up like any other
     * hook and fails the build on it.
     */
    async checkRefineHook(composition: Composition, accept: ValidationAcceptor): Promise<void> {
        if (composition.operator !== 'refine') return;
        const entry = composition.config?.entries.find(candidate => candidate.key === HOOK_KEY);
        const actual = entry?.value;
        if (!entry || actual === undefined) return;

        const source = composition.params?.refs[0];
        const base = source?.ref;
        if (!base) return;
        // As the composition's file sees it: `lib:K` is K of a file loaded `as lib`.
        const contents = await this.contents.contentsOf(base, writtenNamespace(source?.$refText, base.id), AstUtils.getDocument(composition));
        if (contents.kind === 'cannot-tell' || hookTarget(contents, actual)) return;

        const candidates = contents.elements
            .map(entry => entry.id)
            .filter(id => id.length > 0);
        report(accept, JpipeIssue.UnknownHook,
               `Hook element '${actual}' not found in base model '${base.id}'`,
               { node: entry, property: 'value' }, { actual, modelId: base.id, candidates });
    }

    checkLabelNotEmpty(element: Evidence | Strategy | Conclusion | SubConclusion | AbstractSupport,
                        accept: ValidationAcceptor): void {
        // The compiler discards such a conclusion before reading its label.
        if (isDiscardedConclusion(element)) return;
        if (element.name?.length === 0) {
            report(accept, JpipeIssue.NoEmptyLabel, 'Element label should not be empty',
                   { node: element, property: 'name' });
        }
    }

    /**
     * Flags a document that declares nothing at all.
     *
     * `imports` counts. A file whose entire content is `load` statements is an aggregator, and the
     * compiler resolves it and exits 0 — reading only `body` called that file empty, which is the
     * one shape the rule fired on where it was wrong (#70). The grammar routes loads to `imports`
     * rather than `body`, so the two lists have to be checked together.
     *
     * What remains is the genuinely empty document — nothing, whitespace, comments only, or text
     * that does not parse. The grammar's `+` makes all of those parse errors, but Langium's error
     * recovery still hands this a `Unit` with both lists empty, so the rule is not dead: it says in
     * plain words what the parser says as a token-set mismatch.
     *
     * Those are the files the compiler aborts on — `Compilation aborted due to syntax errors`,
     * exit 1 — which is why this is an error under ADR-VSC-0023 rather than the warning it used to
     * be. The warning had been justified by the loads-only file exiting 0, i.e. by the bug.
     */
    checkUnitNotEmpty(unit: Unit, accept: ValidationAcceptor): void {
        if (unit.body?.length === 0 && unit.imports?.length === 0) {
            report(accept, JpipeIssue.NoEmptyUnit, 'Justification File should not be empty',
                   { node: unit, property: 'body' });
        }
    }

    /**
     * Flags a model declared under a name a model read before it already has, whatever their
     * kinds: the compiler rejects it under the same code and in the same words, and drops the later
     * one with its whole body (`DuplicateModelFilter`; jpipe-vscode ADR-VSC-0022). The compiler
     * compares every model it reads to build this file, those of the files it loads included, in
     * the order it reads them (`modelDeclarations`). So, as there, the first declaration is the one
     * kept, and every later one is flagged, pointing at the first as `at lib.jd:8`.
     *
     * A later declaration in a loaded file is underlined by the compiler in that file, which this
     * validation does not reach. It is reported on the `load` of this file that brings it in, with
     * the place of both declarations: the build of this file fails because of it.
     */
    checkDuplicateModels(unit: Unit, accept: ValidationAcceptor): void {
        const document = unit.$document;
        if (!document) return;
        const first = new Map<string, ModelDeclaration>();
        for (const declaration of this.importService.modelDeclarations(unit, document)) {
            const earlier = first.get(declaration.name);
            if (!earlier) {
                first.set(declaration.name, declaration);
                continue;
            }
            const where = `is already declared${placeOf(earlier, ' at ')}`;
            const data = { id: declaration.name };
            if (declaration.via) {
                report(accept, JpipeIssue.DuplicateModel, `Model '${declaration.name}'${placeOf(declaration, ' in ')} ${where}`,
                       { node: declaration.via, property: 'path' }, data);
            } else {
                report(accept, JpipeIssue.DuplicateModel, `Model '${declaration.name}' ${where}`,
                       { node: declaration.model, property: 'id' }, data);
            }
        }
    }

    /**
     * Flags a model with no conclusion.
     *
     * The compiler refuses to build such a model, and applies the rule to templates as well as
     * justifications, so this one does too. An argument with nothing at its root is not an
     * argument.
     *
     * Inherited conclusions count, which is why this reads the model's contents: the compiler checks
     * completeness *after* `implements` has inlined the parent's elements, so a justification
     * whose conclusion comes from its template satisfies the rule there and must here. A conclusion
     * of its own does not count in a model that `implements` one: the compiler has discarded it,
     * and so have the contents.
     *
     * The grammar requires a non-empty body, so `justification J { }` is a parse error rather than
     * this; what reaches here is a model with contents that simply do not include a conclusion.
     *
     * A model built on a composition — `justification K is assemble(J, T) { … }`, or one
     * implementing a composed template — is read as the compiler built it: `assemble` synthesises
     * a conclusion from `conclusionLabel`, which no body declares. A model whose contents cannot
     * tell is skipped. That is one built on a composition the compiler could not report, whose
     * result the editor cannot know, or one whose `implements` does not resolve, which inherits
     * its conclusion from a template this cannot read, and the unresolved reference is the one
     * error to report (#129). Silence about a real problem beats noise about one that is not.
     */
    async checkModelHasConclusion(model: Justification | Template, accept: ValidationAcceptor): Promise<void> {
        const contents = await this.contents.contentsOf(model);
        if (contents.kind === 'cannot-tell') return;
        if (contents.elements.some(entry => entry.kind === 'conclusion')) return;

        report(accept, JpipeIssue.ConclusionPresent, `Model '${model.id}' has no conclusion`,
               { node: model, property: 'id' }, { id: model.id });
    }

    /**
     * Flags every conclusion after the first in one model.
     *
     * A justification claims one thing. The compiler enforces that while it is still reading the
     * file: the first `conclusion` becomes the model's, and each later one is reported as
     * `single-conclusion` and **discarded** — it never enters the model at all.
     *
     * That discarding is why this check has a second half, in `checkConclusionIncomingFromStrategy`.
     * A second conclusion is usually written with nothing supporting it yet, so the editor used to
     * answer "there are two conclusions here" with "the second one has no strategy" — a true
     * statement about a element the compiler had already thrown away, and the wrong problem to put
     * in front of someone. The compiler reports one error on this file and so does the editor now.
     *
     * Reported on each extra rather than once on the model, and anchored on the extra's id, so the
     * squiggle lands on the declaration to remove and the first conclusion is left unmarked —
     * the same shape as `checkDuplicateElementIds`, and the same anchor the compiler uses.
     *
     * A model that `implements` a template is left to `checkInheritedConclusion`: the compiler
     * refuses each of its conclusions under that code instead, however many there are.
     */
    checkSingleConclusion(model: Justification | Template, accept: ValidationAcceptor): void {
        if (model.parent) return;
        const conclusions = getLocalElements(model).filter(isConclusion);
        for (const extra of conclusions.slice(1)) {
            report(accept, JpipeIssue.SingleConclusion, `Model '${model.id}' declares multiple conclusions`,
                   { node: extra, property: 'id' }, { modelId: model.id, id: qualifiedIdText(extra.id) });
        }
    }

    /**
     * Flags a template that declares no `@support`.
     *
     * The compiler's own note for this rule says it best: a template with no abstract supports is
     * a justification in disguise. It refuses to build one, and the message here is its wording.
     *
     * Read on the template's contents, as the compiler reads it once `implements` is expanded: a
     * `@support` that the template overrides with an evidence is no longer one, so a template
     * whose every `@support` is overridden declares none.
     *
     * The `@support` elements a `refine` leaves unrefined are read from the compiler's result. A
     * template whose contents cannot tell is left alone: without that result, or under a template
     * that does not resolve, they are in no body this can read. Declaring the wrong kind for an
     * operator's result is a different error in the compiler, raised once the operator has run.
     */
    async checkTemplateHasSupport(template: Template, accept: ValidationAcceptor): Promise<void> {
        const contents = await this.contents.contentsOf(template);
        if (contents.kind === 'cannot-tell') return;
        const hasSupport = contents.elements.some(entry => entry.kind === 'abstract-support');

        if (!hasSupport) {
            report(accept, JpipeIssue.HasAbstractSupport, `Template '${template.id}' declares no abstract supports`,
                   { node: template, property: 'id' }, { id: template.id });
        }
    }


    /**
     * Flags two elements in one model sharing an id.
     *
     * The compiler rejects this under the same code, and it is worth catching in the editor
     * because the model still *parses*: relations naming the id resolve to whichever of the two
     * the scope happened to register, so the argument silently means something other than what
     * it reads as.
     *
     * Reported on every occurrence after the first, so the original declaration is left unmarked
     * and the squiggles land on the copies.
     */
    checkDuplicateElementIds(model: Justification | Template, accept: ValidationAcceptor): void {
        const seen = new Set<string>();
        for (const element of getLocalElements(model)) {
            const id = qualifiedIdText(element.id);
            // An element being typed has no id yet; it is not a duplicate of every other one.
            if (!id) continue;
            // Discarded by the compiler before ids are compared, so it clashes with nothing.
            if (isDiscardedConclusion(element)) continue;
            if (seen.has(id)) {
                report(accept, JpipeIssue.NoDuplicateIds, `Duplicate element id '${id}' in model '${model.id}'`,
                       { node: element, property: 'id' }, { id, modelId: model.id });
            }
            seen.add(id);
        }
    }

    checkStrategyIncomingSupport(strategy: Strategy, accept: ValidationAcceptor): void {
        const body = strategy.$container;
        if (!body?.rels) return;

        // `to` is absent while `e supports ` is still being typed, which is most of the time. A
        // relation using a discarded conclusion is discarded with it, so it supports nothing.
        const incoming = body.rels.filter(r => r.to?.ref === strategy && !isDiscardedRelation(r));
        if (incoming.length === 0) {
            report(accept, JpipeIssue.StrategySupported, `Strategy '${qualifiedIdText(strategy.id)}' is not supported by any evidence, sub-conclusion, or @support.`,
                   { node: strategy, property: 'id' }, { targetId: qualifiedIdText(strategy.id) });
            return;
        }
        for (const rel of incoming) {
            const fromElem = rel.from?.ref;
            if (!fromElem) continue;
            if (!isEvidence(fromElem) && !isSubConclusion(fromElem) && !isAbstractSupport(fromElem)) {
                report(accept, JpipeIssue.InvalidSupport, `Strategy '${qualifiedIdText(strategy.id)}' may only be supported by evidence, sub-conclusion, or @support (not ${keywordFor(fromElem)}).`,
                       { node: rel, property: 'from' }, {
                          targetId: qualifiedIdText(strategy.id),
                          supporterKind: keywordFor(fromElem)
                      });
            }
        }
    }

    /**
     * Flags a conclusion declared by a model that `implements` a template.
     *
     * Such a model inherits its template's conclusion (jpipe-compiler ADR-0012), and the compiler
     * refuses one of its own while it reads the file: every conclusion the model declares is
     * reported, and discarded with the relations that use it (`ActionListProvider.enterConclusion`).
     * The rule reads the declaration alone, so it holds whether or not the template resolves, and
     * the message names the template as the `implements` line spells it, as the compiler's does.
     *
     * Discarding is why no other rule says anything about these conclusions, or counts them: see
     * `isDiscardedConclusion`. An answer about an element that will not exist is the wrong problem
     * to put in front of someone.
     */
    checkInheritedConclusion(conclusion: Conclusion, accept: ValidationAcceptor): void {
        if (!isDiscardedConclusion(conclusion)) return;
        const model = conclusion.$container.$container;
        const parent = model.parent?.$refText ?? model.parent?.ref?.id ?? '';
        report(accept, JpipeIssue.InheritedConclusion,
               `Model '${model.id}' implements '${parent}' and inherits its conclusion: it cannot declare its own`,
               { node: conclusion, property: 'id' },
               { modelId: model.id, parentId: parent, id: qualifiedIdText(conclusion.id) });
    }

    checkConclusionIncomingFromStrategy(conclusion: Conclusion, accept: ValidationAcceptor): void {
        const body = conclusion.$container;
        if (!body?.rels) return;
        if (isDiscardedConclusion(conclusion)) return;

        // The compiler keeps only the first conclusion and discards the rest, so it never asks
        // whether a later one is supported — and neither should we. Without this, a model with two
        // conclusions reports the second one as unsupported, which is a true statement about an
        // element that will not exist and buries the error that matters (`single-conclusion`).
        const conclusions = (body.body ?? []).filter(isConclusion);
        if (conclusions.length > 1 && conclusions[0] !== conclusion) return;

        const incoming = body.rels.filter(r => r.to?.ref === conclusion);
        if (incoming.length === 0) {
            report(accept, JpipeIssue.ConclusionSupported, `Conclusion '${qualifiedIdText(conclusion.id)}' is not supported by any strategy.`,
                   { node: conclusion, property: 'id' }, { targetId: qualifiedIdText(conclusion.id) });
            return;
        }
        const hasStrategy = incoming.some(rel => isStrategy(rel.from?.ref));
        if (!hasStrategy) {
            report(accept, JpipeIssue.ConclusionSupported, `Conclusion '${qualifiedIdText(conclusion.id)}' must be supported by at least one strategy.`,
                   { node: conclusion, property: 'id' }, { targetId: qualifiedIdText(conclusion.id) });
        }
    }

    /**
     * Checks what a model's overrides name among the elements it inherits, bound as the compiler
     * binds them (`bind`), on the contents of the template it implements.
     *
     * - **An override naming several `@support` elements** is `ambiguous-id`, in the compiler's
     *   words, in a template as in a justification: `evidence top:h` under a template that
     *   `assemble` built from two models implementing `top` names both `l:top:h` and `r:top:h`
     *   (#127). The `@support` elements it names are not reported as missing on top of it: the
     *   compiler reports the failed override, once, where it is.
     * - **A justification leaving a `@support` without an override** is `no-abstract-support`.
     *   Every one still missing is listed on each diagnostic, so a single action can close them
     *   all at once.
     * - **An override of the wrong kind** is `support-override-type`: only an evidence or a
     *   sub-conclusion may stand for a `@support`.
     *
     * Under a template whose contents cannot tell, only the `@support` elements its bodies show are
     * required, and no override is called ambiguous: what is hidden could be named too. A model
     * below a cycle is left alone, which the compiler reports and builds nothing of. A conclusion spelled as an override is discarded
     * before overrides are matched, so the `@support` is still missing, as the compiler says,
     * rather than overridden by the wrong kind.
     */
    async checkOverrides(model: Justification | Template, accept: ValidationAcceptor): Promise<void> {
        const template = model.parent?.ref;
        if (!template || buildsOnCycle(model)) return;
        this.logger.debug(`Checking overrides for '${model.id}'`);
        const inheritance = await inheritedElements(model, this.contents);
        if (!inheritance) return;
        const inherited = inheritance.elements;

        // Each inherited element an override names, with the override naming it.
        const named = new Map<ModelElement, JustificationElement>();
        for (const element of getLocalElements(model)) {
            const id = qualifiedIdText(element.id);
            if (!id.includes(':') || isDiscardedConclusion(element)) continue;
            const binding = bind(inherited, id);
            if (binding.kind === 'found') {
                if (!named.has(binding.element)) named.set(binding.element, element);
            } else if (binding.kind === 'ambiguous') {
                binding.candidates.forEach(candidate => named.set(candidate, element));
                if (inheritance.whole && (isEvidence(element) || isSubConclusion(element))) {
                    const candidates = binding.candidates.map(candidate => candidate.id);
                    report(accept, JpipeIssue.AmbiguousId,
                           `ambiguous id '${id}' in model '${model.id}': it names ${candidates.map(c => `'${c}'`).join(', ')}; write the qualified id`,
                           { node: element, property: 'id' }, { id, modelId: model.id, candidates });
                }
            }
        }
        if (!isJustification(model)) return;

        // A `@support` an ancestor's override named ambiguously was reported there, once.
        const required = inherited.filter(entry => entry.kind === 'abstract-support' && !entry.contested);
        const allMissing = required
            .filter(entry => !named.has(entry))
            .map(entry => ({ expectedKey: entry.id, supportLabel: labelOf(entry) }));
        for (const entry of required) {
            const supportId = entry.element ? qualifiedIdText(entry.element.id) : entry.id.split(':').at(-1) ?? entry.id;
            const sourceTemplateId = declaringModel(entry.element)?.id ?? template.id;
            const override = named.get(entry);
            if (!override) {
                report(accept, JpipeIssue.NoAbstractSupport, `Justification '${model.id}' must override '@support ${supportId}' from template '${sourceTemplateId}'. Expected element with id '${entry.id}'.`,
                       { node: model, property: 'id' }, {
                          expectedKey: entry.id,
                          supportLabel: labelOf(entry),
                          supportId,
                          sourceTemplateId,
                          allMissing
                      });
                continue;
            }
            const elemType = concreteKeywordFor(override);
            if (elemType && elemType !== 'evidence' && elemType !== 'sub-conclusion') {
                report(accept, JpipeIssue.SupportOverrideType, `Cannot override '@support ${supportId}' with type '${elemType}' in justification '${model.id}'. @support elements can only be refined by 'evidence' or 'sub-conclusion'.`,
                       { node: override, property: 'id' }, {
                          actualKeyword: elemType,
                          allowedKeywords: ['evidence', 'sub-conclusion']
                      });
            }
        }
    }

}

/** The label of an element's declaration, `''` for an element no declaration stands for. */
function labelOf(entry: ModelElement): string {
    return entry.element?.name ?? '';
}

/** The model that declares `element`. */
function declaringModel(element: JustificationElement | undefined): Justification | Template | undefined {
    return element?.$container?.$container;
}

/**
 * Whether the compiler drops `relation` along with a discarded conclusion: whether either end is
 * *written* as that conclusion's id (`ActionListProvider`, its `rejectedConclusions`).
 *
 * Matched on the text, as the compiler matches, rather than on what the reference resolves to:
 * a short name the scope aliases to the conclusion is not its id, and the compiler keeps that
 * relation.
 */
function isDiscardedRelation(relation: Relation): boolean {
    const rejected = new Set((relation.$container.body ?? [])
        .filter(isDiscardedConclusion)
        .map(element => qualifiedIdText((element as Conclusion).id)));
    if (rejected.size === 0) return false;
    return [relation.from?.$refText, relation.to?.$refText]
        .some(text => text !== undefined && rejected.has(text.replace(/\s+/g, '')));
}

/**
 * A cycle as the compiler writes it (`describeCycle`): `a implements b implements a`, and, through an
 * operator, `j implements t, which 'assemble' builds from j`.
 */
function describeCycle(cycle: ReadonlyArray<Justification | Template>): string {
    return cycle[0].id + cycle.map((model, index) => {
        const next = cycle[(index + 1) % cycle.length].id;
        return model.composition
            ? `, which '${model.composition.operator}' builds from ${next}`
            : ` implements ${next}`;
    }).join('');
}

/**
 * Where the compiler says a model is declared, after `lead`: the file's name and the line of the
 * model's name, ` at lib.jd:8`; nothing when it is not known, as the compiler leaves it out.
 */
function placeOf(declaration: ModelDeclaration, lead: string): string {
    const name = declaration.model.$cstNode
        && GrammarUtils.findNodeForProperty(declaration.model.$cstNode, 'id');
    if (!name) return '';
    return `${lead}${path.basename(fsPathOf(declaration.document.uri))}:${name.range.start.line + 1}`;
}
