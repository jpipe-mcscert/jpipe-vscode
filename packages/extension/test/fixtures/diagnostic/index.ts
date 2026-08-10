import type { DiagnosticReport } from '../../../src/shared/diagnostic-report.js';

import cleanTemplateJson from './clean-template.json' with { type: 'json' };
import loadCrossFileJson from './load-cross-file.json' with { type: 'json' };
import unifyAliasesJson from './unify-aliases.json' with { type: 'json' };
import unknownSymbolJson from './unknown-symbol.json' with { type: 'json' };
import unsupportedElementsJson from './unsupported-elements.json' with { type: 'json' };

/**
 * The fixtures, handed to the pure functions as `DiagnosticReport`.
 *
 * The assertions below are genuinely assertions, not checks — `resolveJsonModule` widens every
 * string literal in a JSON import (`"status": "ok"` arrives as `string`), so neither an
 * annotation nor `satisfies` can prove these files match the interface. There is no way to get
 * TypeScript to verify imported JSON against a union type.
 *
 * What actually holds the fixtures to shape is `diagnostic-fixtures.test.ts`, which validates
 * every one of them against the schema — and the schema is the stricter of the two anyway, since
 * it also enforces what TypeScript cannot express (a bracketed code, a `line` without a `column`,
 * a synthesized symbol that still carries a location). Treat a red schema test, not a red
 * compile, as the signal that a fixture has drifted.
 */

/** A template with an `@support`, no diagnostics, no macros. The simplest well-formed report. */
export const cleanTemplate = cleanTemplateJson as DiagnosticReport;

/** Three completeness errors, each landing exactly on the declaration it complains about. */
export const unsupportedElements = unsupportedElementsJson as DiagnosticReport;

/**
 * Two diagnostics pointing at `support` statements rather than declarations, plus one carrying no
 * position at all — between them, every way attribution can fail.
 */
export const unknownSymbol = unknownSymbolJson as DiagnosticReport;

/** Composition: synthesized symbols, alias rows, and a macro expanded 21 steps deep. */
export const unifyAliases = unifyAliasesJson as DiagnosticReport;

/** A `load`ed template: locations naming a file other than the report's own. */
export const loadCrossFile = loadCrossFileJson as DiagnosticReport;

export const allFixtures: readonly DiagnosticReport[] = [
    cleanTemplate,
    unsupportedElements,
    unknownSymbol,
    unifyAliases,
    loadCrossFile
];
