import * as path from 'node:path';
import { readEnv } from '../process-launcher.js';
import { parseSemver } from './release-selection.js';

/**
 * Deciding *what* to run and *what to run it on*, with nothing from the editor.
 *
 * Split out of `image-generator.ts`, which imports `vscode` and so cannot be loaded outside an
 * extension host. These are the parts that pick the executable, build its environment, and choose
 * which diagram gets rendered — all worth pinning, none of them needing VS Code.
 */

/** The `jpipe.*` settings that determine how the compiler is launched. */
export interface CompilerSettings {
    readonly executionMode: string;
    readonly cliPath: string;
    readonly jarFile: string;
    readonly javaExecutable: string;
    readonly jvmArgs: string[];
}

/** What the resolver needs from the outside world. */
export interface CompilerContext {
    readonly fileExists: (candidate: string) => boolean;
    /** Jar recorded by the managed-install flow, if any. */
    readonly installedJarPath: string | undefined;
    readonly home: string;
}

/** Expand a leading `~` to the home directory (Node does not do this by default). */
export function expandTilde(filePath: string, home: string): string {
    if (filePath === '~') return home;
    if (filePath.startsWith('~/') || filePath.startsWith('~\\')) return path.join(home, filePath.slice(2));
    return filePath;
}

/**
 * The executable and its leading arguments for the configured execution mode: the CLI on its own,
 * or `java [jvmArgs…] -jar <jar>` for `jar` / `managed`.
 *
 * Returned as an argv pair so callers can spawn without a shell — user and workspace settings are
 * never handed to a command interpreter.
 *
 * @throws with a user-facing message when the mode is configured but unusable.
 */
export function resolveExecCommand(
    settings: CompilerSettings,
    context: CompilerContext
): { file: string; args: string[] } {
    if (settings.executionMode === 'jar') {
        const jarFile = expandTilde(settings.jarFile.trim(), context.home);
        if (!jarFile) throw new Error('jpipe.jarFile is not configured.');
        if (!context.fileExists(jarFile)) throw new Error(`JAR file not found: ${jarFile}`);
        return buildJarCommand(settings, jarFile);
    }

    if (settings.executionMode === 'managed') {
        if (!context.installedJarPath) {
            throw new Error("No managed jPipe compiler installed. Run 'jPipe: Install Compiler from GitHub Release'.");
        }
        if (!context.fileExists(context.installedJarPath)) {
            throw new Error(`Managed JAR file not found: ${context.installedJarPath}`);
        }
        return buildJarCommand(settings, context.installedJarPath);
    }

    // cli mode: a bare name is looked up on PATH at spawn time; a path is used directly.
    const cliPath = settings.cliPath.trim();
    const file = (path.isAbsolute(cliPath) || cliPath.includes(path.sep)) ? path.normalize(cliPath) : cliPath;
    return { file, args: [] };
}

/** The `java [jvmArgs…] -jar <jar>` argv shared by the `jar` and `managed` modes. */
function buildJarCommand(settings: CompilerSettings, jarFile: string): { file: string; args: string[] } {
    const jvmArgs = settings.jvmArgs.map(a => a.trim()).filter(Boolean);
    return { file: settings.javaExecutable.trim(), args: [...jvmArgs, '-jar', path.normalize(jarFile)] };
}

/**
 * PATH augmented so the compiler can find external interpreters (e.g. `python3`, `dot`):
 * configured extra entries first, then the Homebrew defaults, then the inherited PATH.
 */
export function buildPathEnv(
    baseEnv: NodeJS.ProcessEnv,
    extraPaths: string[],
    platform: NodeJS.Platform
): NodeJS.ProcessEnv {
    const isWindows = platform === 'win32';
    // The Homebrew defaults are POSIX-only; on Windows they would just be dead segments.
    const defaults = isWindows ? [] : ['/opt/homebrew/bin', '/usr/local/bin'];
    const existing = readEnv(baseEnv, 'PATH') ?? '';
    // Trim and drop empties so we never introduce an empty PATH segment (which POSIX shells
    // treat as the current directory — a security footgun) or a trailing delimiter.
    const segments = [...extraPaths, ...defaults, existing].map(s => s.trim()).filter(Boolean);
    const value = segments.join(isWindows ? ';' : ':');

    // Windows names the variable `Path`, so spreading the env and adding `PATH` would leave the
    // child with two entries differing only in case — and no say in which one wins. Replace
    // whichever casing is already there instead of adding a second.
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    const existingKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
    for (const key of Object.keys(env)) {
        if (key.toLowerCase() === 'path') delete env[key];
    }
    env[existingKey ?? 'PATH'] = value;
    return env;
}

/**
 * The diagram to render: the last `justification` or `template` declared at or above the cursor.
 *
 * Scanning downwards to the cursor rather than upwards from it means the cursor sitting anywhere
 * inside a model — including past its closing brace but before the next declaration — still
 * selects that model.
 *
 * @throws when the file declares nothing renderable.
 */
export function findDiagramName(text: string, cursorLine: number): string {
    const lines = text.split('\n');
    let diagramName: string | undefined;

    for (let i = 0; i <= cursorLine && i < lines.length; i++) {
        const match = /^\s*(justification|template)\s+(\w+)/i.exec(lines[i]);
        if (match) {
            diagramName = match[2];
        }
    }

    if (!diagramName) {
        throw new Error('No diagram name found (justification or template declaration)');
    }
    return diagramName;
}

/* ------------------------------------------------------- what this compiler can be asked for */

/** The release that introduced `diagnostic -f json`. */
export const MIN_JSON_DIAGNOSTIC_VERSION: readonly [number, number, number] = [2, 4, 0];

/**
 * The version `jpipe --version` reports, e.g. `jPipe 2.4.0` or `jPipe 2.4.0-SNAPSHOT`.
 *
 * Returns undefined for anything that does not look like a version, which callers treat as "do
 * not ask this build for things only newer ones have".
 */
export function parseCompilerVersion(output: string):
    { nums: [number, number, number]; pre: string | undefined } | undefined {
    // The line is `jPipe <version>` today, but pinning that exact shape would break on a build
    // that adds a commit hash or a JVM banner. Take the first version-looking token instead.
    const token = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(output.trim());
    return token ? parseSemver(token[0]) : undefined;
}

/**
 * Does this build understand `diagnostic -f json`?
 *
 * Compares the release numbers and **ignores the prerelease tag**, which is the one subtlety
 * here. Semver says `2.4.0-SNAPSHOT` precedes `2.4.0`, and that is right when the question is
 * "which release is newer" — the question `release-selection.ts` asks when offering an install.
 * It is wrong for this question. A `-SNAPSHOT` or `-rc1` of 2.4.0 is a build *of* 2.4.0 and
 * carries its features, so ordering it below 2.4.0 would refuse structured diagnostics on every
 * development build of the very release that introduces them.
 */
export function supportsJsonDiagnostic(
    version: { nums: readonly [number, number, number] } | undefined
): boolean {
    if (!version) return false;
    for (let i = 0; i < 3; i++) {
        if (version.nums[i] !== MIN_JSON_DIAGNOSTIC_VERSION[i]) {
            return version.nums[i] > MIN_JSON_DIAGNOSTIC_VERSION[i];
        }
    }
    return true;
}

/**
 * Did this invocation fail because the compiler does not know the option we passed?
 *
 * Not the detection mechanism — the version is (see `supportsJsonDiagnostic`). This is recovery
 * for the case where the version said yes and the flag was not there anyway: a pre-feature
 * `2.4.0-SNAPSHOT`, or a patched build. Without it the panel would show picocli's usage dump as
 * though it were a diagnostic report; with it, the text report is fetched instead. When the
 * version gate is right, which is essentially always, this never fires.
 *
 * picocli answers an unrecognised option with exit code 2 and an `Unknown option(s)` or
 * `Unmatched argument` line. Both halves are required, so that a model with errors (exit 1) or an
 * internal crash (exit 42) is never mistaken for a missing flag.
 */
export const USAGE_ERROR_EXIT_CODE = 2;

export function isUnknownOptionFailure(exitCode: unknown, stderr: string): boolean {
    if (exitCode !== USAGE_ERROR_EXIT_CODE) return false;
    // `[^\S\r\n]` rather than `\s`: with the `m` flag, `\s*` can consume newlines, so a run
    // of blank lines gives the engine many overlapping start positions for the same match
    // (S8786). Confining it to same-line whitespace cannot change the answer, because `^`
    // already matches at the start of the line the marker is actually on.
    return /^[^\S\r\n]*(Unknown option|Unmatched argument)/mi.test(stderr);
}
