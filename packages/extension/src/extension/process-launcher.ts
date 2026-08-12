import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Turning an argv pair into something Windows can actually launch.
 *
 * Node spawns processes with `CreateProcessW`, which only ever appends `.exe` when the command
 * has no extension. A command distributed as a batch shim — `jpipe.cmd`, as Scoop produces from
 * `"bin": [["jpipe.ps1", "jpipe"]]` — is therefore invisible to `execFile('jpipe', …)` and fails
 * with `spawn jpipe ENOENT`, even though the very same name works in a terminal.
 *
 * The obvious fix, `shell: true`, is the wrong one here: it would feed user-controlled paths and
 * the diagram name (read out of the `.jd` file) through a command interpreter. Instead the
 * command is resolved to a concrete file the way Windows resolves it, and only a batch shim —
 * which genuinely cannot be launched any other way — goes through `cmd.exe`, with every argument
 * escaped for it.
 *
 * POSIX is untouched: `planLaunch` returns the original argv pair unchanged.
 */

/**
 * Extensions worth considering when resolving a bare command name.
 *
 * Deliberately narrower than a typical `PATHEXT`: these are the four we know how to launch.
 * Anything else there (`.PS1`, `.VBS`, `.JS`, …) would be handed to a script host, so we ignore
 * it rather than execute a file we cannot reason about. Scoop always emits a `.cmd` beside its
 * `.ps1`, so nothing is lost in practice.
 */
const LAUNCHABLE_EXTENSIONS = ['.COM', '.EXE', '.BAT', '.CMD'];

/** Shims that `CreateProcessW` cannot start; these have to be run by the command interpreter. */
const BATCH_EXTENSIONS = new Set(['.BAT', '.CMD']);

/**
 * Characters `cmd.exe` acts on. Straight from `cross-spawn`'s escape rules, which are in turn
 * derived from the analysis at https://qntm.org/cmd.
 */
const CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

/** How to start a process: an argv pair, plus the Windows quoting mode when one is needed. */
export interface LaunchPlan {
    readonly file: string;
    readonly args: string[];
    /** True when `args` are already escaped and Node must not re-quote them. */
    readonly windowsVerbatimArguments?: boolean;
}

/** Injectable surroundings, so the resolution rules can be tested off Windows. */
export interface LaunchEnvironment {
    readonly platform: NodeJS.Platform;
    readonly env: NodeJS.ProcessEnv;
    /** Existence probe; injected so tests need no real files. */
    readonly isFile: (candidate: string) => boolean;
}

/** Reads an environment variable case-insensitively, as Windows itself treats them. */
export function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(env)) {
        if (key.toLowerCase() === wanted) return value;
    }
    return undefined;
}

/**
 * Locates `command` the way Windows would: each `PATH` entry crossed with each launchable
 * extension. Returns undefined when nothing matches, leaving the caller to spawn the original
 * name and get Node's own ENOENT.
 *
 * A name that already carries an extension is an exact filename: it is looked up as written and
 * never has a suffix appended, so a configured `tool.exe` can only ever resolve to `tool.exe` and
 * not to some `tool.exe.cmd` that happens to sit beside it.
 *
 * A name that does not carry one is *never* tried bare — an extension-less file on Windows is not
 * executable, and Scoop ships exactly such a file (a bash shim) next to the `.cmd` we want.
 */
export function resolveWindowsExecutable(command: string, deps: LaunchEnvironment): string | undefined {
    const win = path.win32;
    const hasExtension = /\.[^\\/.]+$/.test(win.basename(command));
    const suffixes = hasExtension ? [''] : launchableExtensions(deps.env);

    // A command with any directory component is a path, not something to look up on PATH.
    const directories = command.includes('/') || command.includes('\\')
        ? ['']
        : (readEnv(deps.env, 'PATH') ?? '').split(win.delimiter).map(entry => entry.trim()).filter(Boolean);

    for (const directory of directories) {
        for (const suffix of suffixes) {
            const candidate = directory ? win.join(directory, command + suffix) : command + suffix;
            if (deps.isFile(candidate)) return candidate;
        }
    }
    return undefined;
}

/**
 * The subset of `PATHEXT` we are willing to launch, in the user's order and casing.
 *
 * Casing is preserved rather than normalised because the result becomes a path we spawn and log;
 * the filesystem does not care, but a needlessly shouty path in an error message does.
 */
function launchableExtensions(env: NodeJS.ProcessEnv): string[] {
    const configured = (readEnv(env, 'PATHEXT') ?? '')
        .split(';')
        .map(entry => entry.trim())
        .filter(entry => LAUNCHABLE_EXTENSIONS.includes(entry.toUpperCase()));
    return configured.length > 0 ? configured : LAUNCHABLE_EXTENSIONS;
}

/** Whether `file` is a batch shim, which only `cmd.exe` can start. */
export function isBatchFile(file: string): boolean {
    return BATCH_EXTENSIONS.has(path.win32.extname(file).toUpperCase());
}

/**
 * Escapes one argument for a `cmd.exe` command line.
 *
 * Two layers, because two parsers see it: first the Windows CRT convention the target program
 * uses to split argv (backslashes before a quote are doubled, quotes escaped), then `cmd.exe`'s
 * own metacharacters, neutralised with `^`.
 *
 * `doubleEscape` covers the case that applies to us: when the thing being run is itself a batch
 * file, its contents are parsed a second time, so one round of `^` is consumed before the
 * argument reaches the program. Ported from `cross-spawn`.
 */
export function escapeCmdArgument(argument: string, doubleEscape: boolean): string {
    let escaped = String(argument);
    escaped = escaped.replace(/(\\*)"/g, '$1$1\\"');
    escaped = escaped.replace(/(\\*)$/, '$1$1');
    escaped = `"${escaped}"`;
    escaped = escaped.replace(CMD_META_CHARACTERS, '^$1');
    if (doubleEscape) escaped = escaped.replace(CMD_META_CHARACTERS, '^$1');
    return escaped;
}

/** Escapes the command itself, which is not quoted but must survive `cmd.exe`'s parser. */
export function escapeCmdCommand(command: string): string {
    return command.replace(CMD_META_CHARACTERS, '^$1');
}

/**
 * Works out how to launch `file` with `args`.
 *
 * Off Windows this is the identity — the argv pair goes straight to `execFile`, no shell, exactly
 * as before. On Windows the command is resolved first; a real executable is spawned directly by
 * its resolved path, and only a batch shim is routed through `cmd.exe`.
 */
export function planLaunch(file: string, args: string[], deps: LaunchEnvironment): LaunchPlan {
    if (deps.platform !== 'win32') {
        return { file, args };
    }

    const resolved = resolveWindowsExecutable(file, deps);
    if (!resolved) {
        // Nothing found: spawn the original name so the failure is Node's usual ENOENT, naming
        // what the user actually configured.
        return { file, args };
    }
    if (!isBatchFile(resolved)) {
        return { file: resolved, args };
    }

    const commandLine = [
        escapeCmdCommand(resolved),
        ...args.map(argument => escapeCmdArgument(argument, true))
    ].join(' ');

    return {
        file: readEnv(deps.env, 'ComSpec') || 'cmd.exe',
        // `/d` skips AutoRun scripts, `/s` makes cmd strip the outer quotes and take the rest
        // verbatim, `/c` runs it and exits.
        args: ['/d', '/s', '/c', `"${commandLine}"`],
        windowsVerbatimArguments: true
    };
}

/** `planLaunch` against the real platform and filesystem. */
export function planLaunchHere(file: string, args: string[], env: NodeJS.ProcessEnv): LaunchPlan {
    return planLaunch(file, args, {
        platform: process.platform,
        env,
        isFile: candidate => {
            try {
                return fs.statSync(candidate).isFile();
            } catch {
                return false;
            }
        }
    });
}
