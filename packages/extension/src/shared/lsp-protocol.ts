/**
 * The custom notifications and requests between the extension and its language server.
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

/**
 * The language server asks for the compiler's report on a file: `jpipe diagnostic -f json`, which
 * compiled contents read a composed model's elements from (jpipe-vscode ADR-VSC-0034).
 *
 * A request, server to client. Params: `{ uri }`, the file's **URI string**. Result: the report,
 * or `null` when there is none to be had — no compiler, one too old to name composed elements as
 * the editor reads them, or a run that failed. The client runs the compiler the user configured,
 * so the server never starts a process itself.
 */
export const COMPILER_REPORT = 'jpipe/compilerReport';

/**
 * Files the compiler reads may have changed on disk: saved, or changed outside the editor.
 *
 * Payload: `string[]` of URI strings; empty when every report may have changed, as when the
 * compiler the user configured changes. The server forgets the reports they can change and checks
 * again the documents that read them.
 */
export const COMPILER_INPUTS_CHANGED = 'jpipe/compilerInputsChanged';

/**
 * The client asks for a model's elements, as the activity's Outline and the Run panel show them:
 * `ModelContents.contentsOf` (jpipe-vscode ADR-VSC-0034), whatever kind of model it is.
 *
 * A request, client to server. Params: `{ uri, name, position? }`, the URI string of the model's
 * file as the server gave it, its name, and a position in its name, which tells it from another
 * model of that name in the file. Result: `{ complete, elements }`, or `null` when the file or the
 * model is not in the workspace. `complete` is false when the server cannot tell: `elements` then
 * holds what the files declare, and an element missing from it may still be there. The shapes are
 * `ModelContentsParams` and `ModelContentsAnswer` in jpipe-language.
 */
export const MODEL_CONTENTS = 'jpipe/modelContents';
