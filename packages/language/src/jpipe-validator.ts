import { AstUtils, type LangiumDocument, type ValidationAcceptor, type ValidationChecks } from 'langium';
import { GlobExpansionError, isGlobPattern } from './jpipe-glob.js';
import type {
    JpipeAstType,
    Unit,
    Composition,
    Evidence,
    Strategy,
    Conclusion,
    SubConclusion,
    AbstractSupport,
    Template,
    Justification,
    Load
} from './generated/ast.js';
import {
    isTemplate,
    isJustification,
    isAbstractSupport,
    isEvidence,
    isStrategy,
    isSubConclusion
} from './generated/ast.js';
import type { JpipeServices } from './jpipe-module.js';
import type { JpipeServerLogger } from './jpipe-logger.js';
import type { JpipeImportService } from './jpipe-import.js';
import { getAllElements, getLocalElements, qualifiedIdText } from './jpipe-utils.js';
import { allowedConfigKeys, isKnownOperator, knownOperatorNames, operatorSpec, requiredConfigKeys } from './jpipe-operators.js';
import { JpipeIssue, issue } from './jpipe-diagnostic-codes.js';
import { concreteKeywordFor, keywordFor } from './jpipe-render.js';

export function registerValidationChecks(services: JpipeServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.JpipeValidator;
    const checks: ValidationChecks<JpipeAstType> = {
        Unit:           validator.checkUnitNotEmpty,
        Load:           validator.checkLoadResolves,
        Composition:    [validator.checkOperatorName, validator.checkOperatorArity, validator.checkConfigKeys],
        Template:       [validator.checkDuplicateTemplateName, validator.checkTemplateHasSupport],
        Justification:  [validator.checkDuplicateJustificationName, validator.checkJustificationOverride],
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

    constructor(services: JpipeServices) {
        this.logger = services.logger;
        this.importService = services.references.JpipeImportService;
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
                accept('error',
                    `Cannot resolve load path '${load.path}': no such file.`,
                    { node: load, property: 'path',
                      ...issue(JpipeIssue.LoadUnresolved, { path: load.path }) });
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
                : `Cannot expand load pattern '${load.path}': ${error instanceof Error ? error.message : String(error)}`;
            accept('error', message,
                { node: load, property: 'path',
                  ...issue(JpipeIssue.LoadMalformedPattern, { path: load.path }) });
            return;
        }
        if (matches.length === 0) {
            accept('error',
                `No file matches load pattern '${load.path}'`,
                { node: load, property: 'path',
                  ...issue(JpipeIssue.LoadNoMatch, { path: load.path }) });
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
            accept('error', `Circular load detected: ${self}`,
                { node: load, property: 'path',
                  ...issue(JpipeIssue.LoadCircular, { path: load.path, resolved: self }) });
        }
    }

    checkOperatorName(composition: Composition, accept: ValidationAcceptor): void {
        if (!isKnownOperator(composition.operator)) {
            accept('error',
                `Unknown operator '${composition.operator}'. Expected: ${knownOperatorNames().join(', ')}.`,
                { node: composition, property: 'operator',
                  ...issue(JpipeIssue.UnknownOperator,
                           { actual: composition.operator, known: knownOperatorNames() }) });
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

        const expected = max === min
            ? `exactly ${min}`
            : max === undefined
                ? `at least ${min}`
                : `between ${min} and ${max}`;
        // The noun agrees with the number that immediately precedes it.
        const count = max === undefined ? min : max;
        accept('error',
            `${composition.operator} requires ${expected} source ${count === 1 ? 'model' : 'models'}, got ${actual}.`,
            { node: composition, property: 'operator',
              ...issue(JpipeIssue.OperatorArity, { operator: composition.operator, actual, min, ...(max !== undefined ? { max } : {}) }) });
    }

    /**
     * Checks a composition's config block against the operator's key table.
     *
     * A missing required key is an error: the compiler refuses to run without it. An unknown key
     * is only a warning, because the compiler ignores keys it does not recognise — flagging one
     * as an error would claim a build failure that will not happen.
     */
    checkConfigKeys(composition: Composition, accept: ValidationAcceptor): void {
        const op = composition.operator;
        if (!isKnownOperator(op)) return;
        const allowed = allowedConfigKeys(op);
        const present = new Set(composition.config?.entries.map(e => e.key) ?? []);
        for (const entry of composition.config?.entries ?? []) {
            if (!allowed.includes(entry.key)) {
                accept('warning',
                    `Unknown config key '${entry.key}' for operator '${op}'. Allowed: ${allowed.join(', ')}.`,
                    { node: entry, property: 'key',
                      ...issue(JpipeIssue.UnknownConfigKey,
                               { actual: entry.key, operator: op, allowed }) });
            }
        }
        const allMissing = requiredConfigKeys(op).filter(key => !present.has(key));
        for (const key of allMissing) {
            accept('error',
                `Missing required config key '${key}' for operator '${op}'.`,
                { node: composition, property: 'operator',
                  ...issue(JpipeIssue.MissingConfigKey, {
                      missingKey: key,
                      operator: op,
                      allMissing,
                      hasConfigBlock: composition.config !== undefined
                  }) });
        }
    }

    checkLabelNotEmpty(element: Evidence | Strategy | Conclusion | SubConclusion | AbstractSupport,
                        accept: ValidationAcceptor): void {
        if (element.name?.length === 0) {
            accept('warning', 'Element label should not be empty',
                   { node: element, property: 'name', ...issue(JpipeIssue.EmptyLabel) });
        }
    }

    checkUnitNotEmpty(unit: Unit, accept: ValidationAcceptor): void {
        if (unit.body?.length === 0) {
            accept('warning', 'Justification File should not be empty',
                   { node: unit, property: 'body', ...issue(JpipeIssue.EmptyUnit) });
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
            accept('error', `Duplicate template name '${template.id}'`,
                   { node: template, property: 'id',
                     ...issue(JpipeIssue.DuplicateModelName, { id: template.id }) });
        }
    }

    checkTemplateHasSupport(template: Template, accept: ValidationAcceptor): void {
        const allElements = getAllElements(template);
        const hasSupport = allElements.some(elem => isAbstractSupport(elem));

        if (!hasSupport) {
            accept('warning',
                `Template '${template.id}' has no @support elements. Justifications implementing this template are not required to override any elements.`,
                { node: template, property: 'id',
                  ...issue(JpipeIssue.TemplateWithoutSupport, { id: template.id }) });
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
            accept('error', `Duplicate justification name '${justification.id}'`,
                   { node: justification, property: 'id',
                     ...issue(JpipeIssue.DuplicateModelName, { id: justification.id }) });
        }
    }

    checkStrategyIncomingSupport(strategy: Strategy, accept: ValidationAcceptor): void {
        const body = strategy.$container;
        if (!body?.rels) return;

        // `to` is absent while `e supports ` is still being typed, which is most of the time.
        const incoming = body.rels.filter(r => r.to?.ref === strategy);
        if (incoming.length === 0) {
            accept('warning',
                `Strategy '${qualifiedIdText(strategy.id)}' is not supported by any evidence, sub-conclusion, or @support.`,
                { node: strategy, property: 'id',
                  ...issue(JpipeIssue.StrategyUnsupported, { targetId: qualifiedIdText(strategy.id) }) });
            return;
        }
        for (const rel of incoming) {
            const fromElem = rel.from?.ref;
            if (!fromElem) continue;
            if (!isEvidence(fromElem) && !isSubConclusion(fromElem) && !isAbstractSupport(fromElem)) {
                accept('error',
                    `Strategy '${qualifiedIdText(strategy.id)}' may only be supported by evidence, sub-conclusion, or @support (not ${keywordFor(fromElem)}).`,
                    { node: rel, property: 'from',
                      ...issue(JpipeIssue.StrategyBadSupporter, {
                          targetId: qualifiedIdText(strategy.id),
                          supporterKind: keywordFor(fromElem)
                      }) });
            }
        }
    }

    checkConclusionIncomingFromStrategy(conclusion: Conclusion, accept: ValidationAcceptor): void {
        const body = conclusion.$container;
        if (!body?.rels) return;

        const incoming = body.rels.filter(r => r.to?.ref === conclusion);
        if (incoming.length === 0) {
            accept('warning',
                `Conclusion '${qualifiedIdText(conclusion.id)}' is not supported by any strategy.`,
                { node: conclusion, property: 'id',
                  ...issue(JpipeIssue.ConclusionUnsupported, { targetId: qualifiedIdText(conclusion.id) }) });
            return;
        }
        const hasStrategy = incoming.some(rel => isStrategy(rel.from?.ref));
        if (!hasStrategy) {
            accept('error',
                `Conclusion '${qualifiedIdText(conclusion.id)}' must be supported by at least one strategy.`,
                { node: conclusion, property: 'id',
                  ...issue(JpipeIssue.ConclusionNoStrategy, { targetId: qualifiedIdText(conclusion.id) }) });
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
                accept('error',
                    `Justification '${justification.id}' must override '@support ${qualifiedIdText(req.support.id)}' from template '${req.sourceTemplateId}'. Expected element with id '${req.expectedKey}'.`,
                    { node: justification, property: 'id',
                      ...issue(JpipeIssue.MissingSupportOverride, {
                          expectedKey: req.expectedKey,
                          supportLabel: req.support.name,
                          supportId: qualifiedIdText(req.support.id),
                          sourceTemplateId: req.sourceTemplateId,
                          allMissing
                      }) });
                continue;
            }
            const elemType = concreteKeywordFor(override);
            if (elemType && elemType !== 'evidence' && elemType !== 'sub-conclusion') {
                accept('error',
                    `Cannot override '@support ${qualifiedIdText(req.support.id)}' with type '${elemType}' in justification '${justification.id}'. @support elements can only be refined by 'evidence' or 'sub-conclusion'.`,
                    { node: override, property: 'id',
                      ...issue(JpipeIssue.BadSupportOverrideType, {
                          actualKeyword: elemType,
                          allowedKeywords: ['evidence', 'sub-conclusion']
                      }) });
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
