import { AstUtils, type LangiumDocument, type ValidationAcceptor, type ValidationChecks } from 'langium';
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
    UNIFY_BY_KEY,
    allowedConfigKeys,
    arityPhrase,
    isKnownOperator,
    knownOperatorNames,
    operatorSpec,
    requiredConfigKeys
} from './jpipe-operators.js';
import { getAllElements, getLocalElements, qualifiedIdText } from './jpipe-utils.js';
import { JpipeIssue, report } from './jpipe-diagnostic-codes.js';
import { concreteKeywordFor, keywordFor } from './jpipe-render.js';
import { messageOf } from './jpipe-errors.js';

export function registerValidationChecks(services: JpipeServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.JpipeValidator;
    const checks: ValidationChecks<JpipeAstType> = {
        Unit:           validator.checkUnitNotEmpty,
        Load:           validator.checkLoadResolves,
        Composition:    [validator.checkOperatorName, validator.checkOperatorArity, validator.checkConfigKeys, validator.checkUnificationMethod],
        Template:       [validator.checkDuplicateTemplateName, validator.checkTemplateHasSupport, validator.checkDuplicateElementIds, validator.checkModelHasConclusion, validator.checkSingleConclusion],
        Justification:  [validator.checkDuplicateJustificationName, validator.checkJustificationOverride, validator.checkDuplicateElementIds, validator.checkModelHasConclusion, validator.checkSingleConclusion],
        Evidence:       validator.checkLabelNotEmpty,
        Strategy:       [validator.checkLabelNotEmpty, validator.checkStrategyIncomingSupport],
        Conclusion:     [validator.checkLabelNotEmpty, validator.checkConclusionIncomingFromStrategy],
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
     * The two halves land at different severities, and deliberately: the compiler refuses to run
     * without a required key, but silently ignores one it does not recognise. `JpipeIssueSeverity`
     * records that, along with the rule it follows from (jpipe-vscode ADR-VSC-0023).
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

    checkLabelNotEmpty(element: Evidence | Strategy | Conclusion | SubConclusion | AbstractSupport,
                        accept: ValidationAcceptor): void {
        if (element.name?.length === 0) {
            report(accept, JpipeIssue.NoEmptyLabel, 'Element label should not be empty',
                   { node: element, property: 'name' });
        }
    }

    checkUnitNotEmpty(unit: Unit, accept: ValidationAcceptor): void {
        if (unit.body?.length === 0) {
            report(accept, JpipeIssue.NoEmptyUnit, 'Justification File should not be empty',
                   { node: unit, property: 'body' });
        }
    }

    checkDuplicateTemplateName(template: Template, accept: ValidationAcceptor): void {
        this.logger.debug(`Validating template '${template.id}'`);
        const unit = template.$container;
        if (!unit) return;

        const duplicates = unit.body.filter(
            (item): item is Template => isTemplate(item) && item.id === template.id
        );

        if (duplicates.length > 1) {
            report(accept, JpipeIssue.NoDuplicateModelNames, `Duplicate template name '${template.id}'`,
                   { node: template, property: 'id' }, { id: template.id });
        }
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
     * whose conclusion comes from its template satisfies the rule there and must here.
     *
     * The grammar requires a non-empty body, so `justification J { }` is a parse error rather than
     * this; what reaches here is a model with contents that simply do not include a conclusion.
     *
     * A composed model — `justification K is assemble(J, T) { … }` — is skipped, because its
     * elements do not exist until the operator has run. `assemble` synthesises a conclusion from
     * `conclusionLabel`, so the compiler checks the *result* and is satisfied; checking the source
     * text here would report an error on a model that builds. The cost is that a composition whose
     * result genuinely has no conclusion is caught by the compiler and not by the editor, which is
     * the right way round: silence about a real problem beats noise about one that is not.
     */
    checkModelHasConclusion(model: Justification | Template, accept: ValidationAcceptor): void {
        if (model.composition) return;
        if (getAllElements(model).some(isConclusion)) return;

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
     */
    checkSingleConclusion(model: Justification | Template, accept: ValidationAcceptor): void {
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
     */
    checkTemplateHasSupport(template: Template, accept: ValidationAcceptor): void {
        const allElements = getAllElements(template);
        const hasSupport = allElements.some(elem => isAbstractSupport(elem));

        if (!hasSupport) {
            report(accept, JpipeIssue.HasAbstractSupport, `Template '${template.id}' declares no abstract supports`,
                   { node: template, property: 'id' }, { id: template.id });
        }
    }

    checkDuplicateJustificationName(justification: Justification, accept: ValidationAcceptor): void {
        this.logger.debug(`Validating justification '${justification.id}'`);
        const unit = justification.$container;
        if (!unit) return;

        const duplicates = unit.body.filter(
            (item): item is Justification => isJustification(item) && item.id === justification.id
        );

        if (duplicates.length > 1) {
            report(accept, JpipeIssue.NoDuplicateModelNames, `Duplicate justification name '${justification.id}'`,
                   { node: justification, property: 'id' }, { id: justification.id });
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

        // `to` is absent while `e supports ` is still being typed, which is most of the time.
        const incoming = body.rels.filter(r => r.to?.ref === strategy);
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

    checkConclusionIncomingFromStrategy(conclusion: Conclusion, accept: ValidationAcceptor): void {
        const body = conclusion.$container;
        if (!body?.rels) return;

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
        const localById = new Map(localElements.map(e => [qualifiedIdText(e.id), e]));

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
            local.filter(e => !isAbstractSupport(e)).map(e => qualifiedIdText(e.id))
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
