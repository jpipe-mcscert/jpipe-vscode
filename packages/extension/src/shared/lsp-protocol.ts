/**
 * The custom notifications the extension sends to its language server.
 *
 * Types and constants only — this module is imported by both the extension-host bundle and the
 * language-server bundle, so it must pull in neither `vscode` nor the DOM. See
 * jpipe-vscode ADR-VSC-0005.
 *
 * These names used to be declared twice, once on each side of the boundary, each with a comment
 * pointing at the other file. That is a contract two files have to agree on with nothing able to
 * check that they do: renaming one side type-checks, builds, packages and ships, and the failure
 * is a notification the server never receives — no error, no log, the setting simply stops
 * having any effect. `preview-protocol.ts` already keeps the extension↔webview contract in one
 * place for the same reason.
 */

/**
 * `jpipe.excludedPaths` changed.
 *
 * Payload: `string[]` of **URI strings** — `vscode.Uri.toString()` on the client
 * (`ExclusionManager.getResolvedUris`), `URI.parse` on the server
 * (`JpipeExclusionService.setExcludedPaths`). So `file:///Users/x/models`, not `/Users/x/models`.
 *
 * Worth stating precisely, because the extension holds the same set in three shapes and only
 * this one crosses the wire: `getResolvedPaths()` gives `vscode.Uri`, `getResolvedUris()` gives
 * the URI strings sent here, and `getExcludedResourcePaths()` gives bare `uri.path` for menu
 * `when` clauses. Sending `fsPath` instead would look right on macOS and Linux and diverge on
 * Windows, where the same folder is `c:\dir` as a path and `file:///c%3A/dir` as a URI.
 *
 * Initial state travels through `initializationOptions` instead, because the server needs it
 * before the first notification could arrive.
 */
export const SET_EXCLUDED_PATHS = 'jpipe/setExcludedPaths';

/**
 * `jpipe.additionalUnificationMethods` changed.
 *
 * Payload: `string[]` — the `jpipe.additionalUnificationMethods` setting verbatim, naming the
 * relations this build understands beyond the one jPipe ships.
 */
export const SET_UNIFICATION_METHODS = 'jpipe/setUnificationMethods';
