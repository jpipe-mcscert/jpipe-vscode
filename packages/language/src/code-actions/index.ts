/**
 * The registry — the one place that knows what this IDE offers.
 *
 * Adding an action means writing its module and adding one line here. Listed explicitly rather
 * than discovered: the extension is bundled to CJS, so there is no directory to scan at runtime;
 * the order below is the order a user sees in the lightbulb menu; and one greppable list answers
 * "what can this thing do".
 */
import { addRequiredConfigKeys } from './add-required-config-keys.js';
import { addSupportOverride } from './add-support-override.js';
import { addMissingLoad } from './add-missing-load.js';
import { addSupporter } from './add-supporter.js';
import { fixConfigKey } from './fix-config-key.js';
import { fixLoadPath } from './fix-load-path.js';
import { fixOperatorName } from './fix-operator-name.js';
import { fixOverrideType } from './fix-override-type.js';
import { convertModelKind } from './convert-model-kind.js';
import { organizeLoads } from './organize-loads.js';
import { sortElements } from './sort-elements.js';
import { removeLoad } from './remove-load.js';
import type { RefactoringDefinition, RegisteredQuickFix } from './types.js';

export const JPIPE_QUICK_FIXES: readonly RegisteredQuickFix[] = [
    addSupportOverride,
    fixOverrideType,
    fixOperatorName,
    addRequiredConfigKeys,
    fixConfigKey,
    addSupporter,
    fixLoadPath,
    removeLoad
];

export const JPIPE_REFACTORINGS: readonly RefactoringDefinition[] = [
    addMissingLoad,
    organizeLoads,
    convertModelKind,
    sortElements
];
