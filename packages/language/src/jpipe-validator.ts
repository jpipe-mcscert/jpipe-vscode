import { AstUtils, type AstNode, type LangiumDocument, type ValidationAcceptor, type ValidationChecks } from 'langium';
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
    type Load,
    type Relation,
    isTemplate,
    isJustification,
    isAbstractSupport,
    isConclusion,
    isEvidence,
    isStrategy,
    isSubConclusion
} from './generated/ast.js';
import type { JpipeServices } from './jpipe-module.js';
import type { JpipeServerLogger } from './jpipe-logger.js';
import type { JpipeImportService } from './jpipe-import.js';
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
import { cannotSeeAllElements, expandedElements, getAllElements, getLocalElements, hookTarget, qualifiedIdText } from './jpipe-utils.js';
import { JpipeIssue, report } from './jpipe-diagnostic-codes.js';
import { concreteKeywordFor, keywordFor } from './jpipe-render.js';
import { messageOf } from './jpipe-errors.js';

export function registerValidationChecks(services: JpipeServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.JpipeValidator;
    const checks: ValidationChecks<JpipeAstType> = {
        Unit:           validator.checkUnitNotEmpty,
        Load:           validator.checkLoadResolves,
        Composition:    [validator.checkOperatorName, validator.checkOperatorArity, validator.checkConfigKeys, validator.checkUnificationMethod, validator.checkRefineHook],
        Template:       [validator.checkDuplicateModelName, validator.checkTemplateHasSupport, validator.checkDuplicateElementIds, validator.checkModelHasConclusion, validator.checkSingleConclusion],
        Justification:  [validator.checkDuplicateModelName, validator.checkJustificationOverride, validator.checkDuplicateElementIds, validator.checkModelHasConclusion, validator.checkSingleConclusion],
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

    constructor(services: JpipeServices) {
        this.logger = services.logger;
        this.importService = services.references.JpipeImportService;
        this.unification = services.unification;
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
     * `hookTarget` decides what resolves, and matches the compiler: against the ids template
     * expansion gives inherited elements, then by its suffix fallback. Two shapes are passed over
     * instead, each because the editor genuinely cannot answer:
     *
     * - **A base for which `cannotSeeAllElements` holds**, when the hook matches none of the ids
     *   this can see: it may name one an operator builds, or one inherited through an `implements`
     *   that does not resolve. In the second case the visible problem is the `implements`, and
     *   pointing at the hook would send the user to the wrong line.
     * - **An unresolved first source**, which is a linking error already reported where it is.
     *
     * A missing `hook` is `missing-config-key`'s business and is left alone. An empty one is not:
     * the key is present, so nothing else reports it, and the compiler looks `''` up like any other
     * hook and fails the build on it.
     */
    checkRefineHook(composition: Composition, accept: ValidationAcceptor): void {
        if (composition.operator !== 'refine') return;
        const entry = composition.config?.entries.find(candidate => candidate.key === HOOK_KEY);
        const actual = entry?.value;
        if (!entry || actual === undefined) return;

        const base = composition.params?.refs[0]?.ref;
        if (!base) return;
        if (hookTarget(base, actual) || cannotSeeAllElements(base)) return;

        const candidates = expandedElements(base)
            .map(entry => entry.id)
            .filter(id => id.length > 0);
        report(accept, JpipeIssue.UnknownHook,
               `Hook element '${actual}' not found in base model '${base.id}'`,
               { node: entry, property: 'value' }, { actual, modelId: base.id, candidates });
    }

    checkLabelNotEmpty(element: Evidence | Strategy | Conclusion | SubConclusion | AbstractSupport,
                        accept: ValidationAcceptor): void {
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
     * Flags a model declared under a name another model of the file already has, whatever their
     * kinds: the compiler rejects it under the same code and in the same words, and drops the later
     * one with its whole body (jpipe-vscode ADR-VSC-0022). So, as there, the first declaration is
     * the one kept and every later one is flagged, pointing at it. The compiler also compares the
     * files a model loads; this checks one file (#122).
     */
    checkDuplicateModelName(model: Justification | Template, accept: ValidationAcceptor): void {
        const unit = model.$container;
        if (!unit) return;
        const named = unit.body.filter(item => (isJustification(item) || isTemplate(item)) && item.id === model.id);
        if (named.indexOf(model) < 1) return;
        const first = named[0].$cstNode?.range.start.line;
        const where = first === undefined ? '' : ` at line ${first + 1}`;
        report(accept, JpipeIssue.DuplicateModel, `Model '${model.id}' is already declared${where}`,
               { node: model, property: 'id' }, { id: model.id });
    }

    /**
     * Flags a model with no conclusion.
     *
     * The compiler refuses to build such a model, and applies the rule to templates as well as
     * justifications, so this one does too. An argument with nothing at its root is not an
     * argument.
     *
     * Inherited conclusions count, which is why this reads `getAllElements`: the compiler checks
     * completeness *after* `implements` has inlined the parent's elements, so a justification
     * whose conclusion comes from its template satisfies the rule there and must here. A conclusion
     * of its own does not count in a model that `implements` one: the compiler has discarded it.
     *
     * The grammar requires a non-empty body, so `justification J { }` is a parse error rather than
     * this; what reaches here is a model with contents that simply do not include a conclusion.
     *
     * A model for which `cannotSeeAllElements` holds is skipped. One built on a composition —
     * `justification K is assemble(J, T) { … }`, or one implementing a composed template — has
     * elements that do not exist until the operator has run; one whose `implements` does not
     * resolve inherits its conclusion from a template this cannot read, and the unresolved
     * reference is the one error to report (#129). `assemble` synthesises a conclusion from `conclusionLabel`, so the compiler
     * checks the *result* and is satisfied; checking the source text here would report an error on
     * a model that builds. The cost is that a composition whose result genuinely has no conclusion
     * is caught by the compiler and not by the editor, which is the right way round: silence about
     * a real problem beats noise about one that is not.
     */
    checkModelHasConclusion(model: Justification | Template, accept: ValidationAcceptor): void {
        if (cannotSeeAllElements(model)) return;
        if (getAllElements(model).some(element => isConclusion(element) && !isDiscardedConclusion(element))) return;

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
     * A template for which `cannotSeeAllElements` holds is left alone: the `@support` elements a
     * `refine` leaves unrefined, or those of a template that does not resolve, are in no body this
     * can read. Declaring the wrong kind for an operator's result is a different error in the
     * compiler, raised once the operator has run.
     */
    checkTemplateHasSupport(template: Template, accept: ValidationAcceptor): void {
        if (cannotSeeAllElements(template)) return;
        const allElements = getAllElements(template);
        const hasSupport = allElements.some(elem => isAbstractSupport(elem));

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

    checkJustificationOverride(justification: Justification, accept: ValidationAcceptor): void {
        this.logger.debug(`Checking overrides for justification '${justification.id}'`);
        if (!justification.parent?.ref) return;

        const template = justification.parent.ref;
        const parentRefText = justification.parent.$refText ?? template.id;
        const localElements = getLocalElements(justification);
        // A conclusion spelled as an override is discarded before overrides are matched, so the
        // `@support` is still missing, as the compiler says, rather than overridden by the wrong kind.
        const localById = new Map(localElements
            .filter(e => !isDiscardedConclusion(e))
            .map(e => [qualifiedIdText(e.id), e]));

        const required = this.getRequiredOverrides(template, parentRefText);
        // Every gap is listed on each diagnostic, so a single action can close them all at once.
        const allMissing = required
            .filter(req => !localById.has(req.expectedKey))
            .map(req => ({ expectedKey: req.expectedKey, supportLabel: req.support.name }));

        for (const req of required) {
            const override = localById.get(req.expectedKey);
            if (!override) {
                report(accept, JpipeIssue.NoAbstractSupport, `Justification '${justification.id}' must override '@support ${qualifiedIdText(req.support.id)}' from template '${req.sourceTemplateId}'. Expected element with id '${req.expectedKey}'.`,
                       { node: justification, property: 'id' }, {
                          expectedKey: req.expectedKey,
                          supportLabel: req.support.name,
                          supportId: qualifiedIdText(req.support.id),
                          sourceTemplateId: req.sourceTemplateId,
                          allMissing
                      });
                continue;
            }
            const elemType = concreteKeywordFor(override);
            if (elemType && elemType !== 'evidence' && elemType !== 'sub-conclusion') {
                report(accept, JpipeIssue.SupportOverrideType, `Cannot override '@support ${qualifiedIdText(req.support.id)}' with type '${elemType}' in justification '${justification.id}'. @support elements can only be refined by 'evidence' or 'sub-conclusion'.`,
                       { node: override, property: 'id' }, {
                          actualKeyword: elemType,
                          allowedKeywords: ['evidence', 'sub-conclusion']
                      });
            }
        }
    }

    /**
     * The `@support` elements a justification implementing `template` must override.
     *
     * `seen` guards the `implements` walk: a template may point back at itself, which the
     * compiler reports as `cyclic-implements`, and the model sits in that state while it is being
     * edited. Recursing through such a chain would exhaust the stack and abort validation for the
     * whole document.
     */
    private getRequiredOverrides(
        template: Template,
        refText: string,
        seen: Set<Template> = new Set()
    ): Array<{ support: AbstractSupport; expectedKey: string; sourceTemplateId: string }> {
        if (seen.has(template)) return [];
        seen.add(template);
        const local = template.contents?.body ?? [];
        // Keys of non-abstract elements defined directly in this template (these override parent abstracts)
        const localOverrideKeys = new Set(
            local.filter(e => !isAbstractSupport(e) && !isDiscardedConclusion(e)).map(e => qualifiedIdText(e.id))
        );
        const result: Array<{ support: AbstractSupport; expectedKey: string; sourceTemplateId: string }> = [];

        // Abstract supports declared directly in this template
        for (const elem of local) {
            if (isAbstractSupport(elem)) {
                result.push({
                    support: elem,
                    expectedKey: `${refText}:${qualifiedIdText(elem.id)}`,
                    sourceTemplateId: template.id
                });
            }
        }

        // Propagate unresolved abstract supports from the parent chain
        if (template.parent?.ref) {
            const parentRefText = template.parent.$refText ?? template.parent.ref.id;
            for (const req of this.getRequiredOverrides(template.parent.ref, parentRefText, seen)) {
                // Skip if this template already provides a non-abstract override for it
                if (!localOverrideKeys.has(req.expectedKey)) {
                    result.push(req);
                }
            }
        }

        return result;
    }


}

/**
 * Whether `element` is a conclusion the compiler throws away: one declared by a model that
 * `implements` a template, and so inherits its conclusion.
 *
 * The compiler refuses it while reading the file (`inherited-conclusion`, from the declaration
 * alone) and drops it together with every relation that uses it, before any other rule runs. Every
 * check here must therefore read the model as if it were not written: it does not satisfy
 * `conclusion-present`, support a strategy, override a `@support`, clash with another id, or need
 * support of its own.
 */
function isDiscardedConclusion(element: AstNode | undefined): boolean {
    return isConclusion(element) && element.$container?.$container?.parent !== undefined;
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
