/**
 * How a run is named wherever it is shown: by the host, in Results and the panel's state, and by
 * the run panel's page. Shared by both bundles, so it imports neither `vscode` nor the DOM
 * (jpipe-vscode ADR-VSC-0005).
 */
import type { RunKind } from './run-protocol.js';

/** What a run is called wherever it is shown: an execution calls the steps, a check does not. */
export const kindOf = (check: boolean): RunKind => check ? 'check' : 'execution';

/** `Executing release…`, `Checking release…`. */
export const underWay = (name: string, check: boolean): string => `${check ? 'Checking' : 'Executing'} ${name}…`;
