/**
 * The decisions behind writing a chosen JAR back into settings.
 *
 * Kept apart from the dialog that produces the choice so they can be tested: the flow itself is
 * `showOpenDialog` and a notification, which need an editor, while *where the value goes* is the
 * part that can be quietly wrong. See jpipe-vscode ADR-VSC-0004.
 */

/** The setting scopes VS Code can write to, most specific first. */
export type SettingScope = 'workspaceFolder' | 'workspace' | 'global';

/** What `WorkspaceConfiguration.inspect` reports about where a setting currently has a value. */
export interface ScopedValues {
    workspaceFolderValue?: string;
    workspaceValue?: string;
    globalValue?: string;
}

/**
 * Which scope a new value has to be written to for the user to actually see it.
 *
 * VS Code resolves a setting most-specific-first, so writing the user's global settings while a
 * workspace value exists changes a value nothing reads: the picker would appear to do nothing at
 * all, which is a worse failure than the typing it replaces — the setting *looks* right in the
 * User tab and the compiler goes on using the old jar.
 *
 * So the rule is to overwrite wherever the value already lives, and to fall back to global only
 * when it lives nowhere. Global is the right fallback rather than workspace because a path to a
 * jar on this disk is a fact about this machine, not about the project.
 */
export function scopeToWrite(values: ScopedValues): SettingScope {
    if (isSet(values.workspaceFolderValue)) return 'workspaceFolder';
    if (isSet(values.workspaceValue)) return 'workspace';
    return 'global';
}

/**
 * Whether a scope holds a value a reader would actually get.
 *
 * The empty string is the declared default of `jpipe.jarFile`, and an all-whitespace path is the
 * shape a half-finished hand-edit leaves behind. Neither is a value anybody chose, so neither
 * should pin the write to that scope.
 */
function isSet(value: string | undefined): boolean {
    return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Whether the chosen file looks like a JAR at all.
 *
 * The dialog filters to `.jar`, but every file dialog lets the user switch the filter off, and
 * the compiler's complaint about a file that is not an archive is not one that points back here.
 * Case-insensitive: the filter is a display convention, not the filesystem's rule.
 */
export function looksLikeJar(path: string): boolean {
    return path.toLowerCase().endsWith('.jar');
}
