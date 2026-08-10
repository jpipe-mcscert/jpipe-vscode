/**
 * The document `jpipe diagnostic -f json` produces.
 *
 * Types only — this module is imported by both the extension-host bundle and the browser bundle,
 * so it must pull in neither `vscode` nor the DOM.
 *
 * These declarations mirror `schema/diagnostic-report.v1.schema.json`, which is the contract and
 * the thing to change first. They are written by hand rather than generated: they are small, and
 * the schema's constraints are worth restating in a form the TypeScript compiler can enforce at
 * every use site. Two of them are:
 *
 * - a symbol carries a location exactly when it is not synthesized (`SymbolEntry` is a union on
 *   `synthesized`, so reading `.location` off a synthesized symbol will not type-check);
 * - a diagnostic's `line` and `column` arrive together or not at all (`dependentRequired` in the
 *   schema, one optional pair here), so there is no state where a caller has a line but no column.
 *
 * The fixtures under `test/fixtures/diagnostic/` are typed as `DiagnosticReport` *and* validated
 * against the schema, which is what keeps these two descriptions of the same thing in step.
 */

/** The only shape this extension knows how to render. Anything else falls back to the raw text. */
export const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * A source position.
 *
 * Line is 1-based, column 0-based — the compiler's convention, converted to VS Code's at exactly
 * one place (`revealLocation` in the preview provider) and nowhere else.
 */
export interface SourceLocation {
    /**
     * The file this position belongs to.
     *
     * Omitted when it is the report's own `source`. When present it may name a *different* file:
     * that is how elements pulled in by a `load` appear, so anything navigating to a location has
     * to open by path rather than assume the active editor.
     */
    source?: string;
    line: number;
    column: number;
}

/**
 * `error` accumulates and sets the exit code; `fatal` aborts the pipeline before a report is
 * rendered, so it should never actually arrive. Handled anyway — the schema documents it as
 * reserved rather than impossible.
 */
export type Severity = 'error' | 'fatal';

/** A position, or the absence of one. Never half of one. */
type MaybePositioned =
    | { line: number; column: number }
    | { line?: undefined; column?: undefined };

export type Diagnostic = {
    severity: Severity;
    /**
     * A bare kebab-case rule name (`conclusion-supported`), never bracketed, and never repeated
     * inside `message`. Absent on diagnostics that are not raised by a named rule.
     */
    code?: string;
    /** Always present, even when the position is not — a diagnostic always names a file. */
    source: string;
    message: string;
} & MaybePositioned;

export interface Stats {
    commands: {
        /**
         * Note this is *not* `actions.length`: the trace lists expanded macro steps that the
         * command count does not include. Show each where it belongs; never derive one from the
         * other.
         */
        total: number;
        macros: number;
    };
    /** Execution-engine deferral rounds. Non-zero means forward references had to be retried. */
    deferrals: number;
}

export type ModelKind = 'justification' | 'template';

export type SymbolKind =
    | 'conclusion'
    | 'sub-conclusion'
    | 'strategy'
    | 'evidence'
    | 'abstract-support';

/**
 * An element of a model.
 *
 * `synthesized` means the element was produced by template expansion or composition and so has no
 * source position of its own — which the schema enforces, and this union restates.
 */
export type SymbolEntry =
    | { id: string; kind: SymbolKind; synthesized: false; location: SourceLocation }
    | { id: string; kind: SymbolKind; synthesized: true; location?: undefined };

/** An element id rewritten during composition. */
export interface Alias {
    from: string;
    to: string;
}

/**
 * The element census, matching the text report's `elements:` line.
 *
 * The keys are camelCase while `SymbolKind` is hyphenated. Crossing that boundary is what
 * `symbolKindOfCensusKey` in `diagnostic-model.ts` is for — do not spell the mapping inline.
 */
export interface ElementCensus {
    /** 0 or 1: a model owns at most one conclusion. */
    conclusion: number;
    subConclusion: number;
    strategy: number;
    evidence: number;
    abstractSupport: number;
}

export interface ModelSummary {
    name: string;
    kind: ModelKind;
    /** The template this model implements, when it implements one. */
    implements?: string;
    location?: SourceLocation;
    elements: ElementCensus;
    /** Models implementing this one. Guaranteed empty for a justification. */
    usedBy: Array<{ name: string; location?: SourceLocation }>;
    /**
     * The model's elements in the compiler's stable display order: conclusion, sub-conclusions,
     * strategies, evidence, abstract supports. Preserve it — it is meaningful, not incidental.
     */
    symbols: SymbolEntry[];
    aliases: Alias[];
}

/** One step of the model-construction trace. Carries no source position. */
export interface ExecutedAction {
    /** 1-based and authoritative. Display this, not the array index. */
    index: number;
    /** Nesting depth inside macro expansions. */
    depth: number;
    macro: boolean;
    description: string;
}

export interface DiagnosticReport {
    schemaVersion: number;
    /** The compiled file, as given to the compiler. */
    source: string;
    /** Mirrors the exit code: `ok` is 0, `errors` is 1. */
    status: 'ok' | 'errors';
    diagnostics: Diagnostic[];
    stats: Stats;
    /** One entry per model in the unit, in declaration order. */
    models: ModelSummary[];
    /** Empty when interpretation did not run. */
    actions: ExecutedAction[];
}
