/**
 * The registry — the one place that knows what this IDE offers.
 *
 * Adding an action means writing its module and adding one line here. Listed explicitly rather
 * than discovered: the extension is bundled to CJS, so there is no directory to scan at runtime;
 * the order below is the order a user sees in the lightbulb menu; and one greppable list answers
 * "what can this thing do".
 */
import { fixOverrideType } from './fix-override-type.js';
import type { RefactoringDefinition, RegisteredQuickFix } from './types.js';

export const JPIPE_QUICK_FIXES: readonly RegisteredQuickFix[] = [
    fixOverrideType
];

export const JPIPE_REFACTORINGS: readonly RefactoringDefinition[] = [
];
