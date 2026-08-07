import { describe, expect, test } from 'vitest';
import {
    escapeCmdArgument,
    escapeCmdCommand,
    isBatchFile,
    planLaunch,
    readEnv,
    resolveWindowsExecutable,
    type LaunchEnvironment
} from '../src/extension/process-launcher.js';

/**
 * These run on any platform: the Windows rules are exercised through an injected platform, env
 * and existence probe, so CI does not need a Windows runner to catch a regression here.
 */

/** A pretend Windows box whose `files` exist and nothing else does. */
function windows(files: string[], env: Record<string, string> = {}): LaunchEnvironment {
    const present = new Set(files.map(f => f.toLowerCase()));
    return {
        platform: 'win32',
        env: {
            Path: 'C:\\Users\\dev\\scoop\\shims;C:\\Windows\\system32',
            PATHEXT: '.COM;.EXE;.BAT;.CMD',
            ComSpec: 'C:\\Windows\\system32\\cmd.exe',
            ...env
        },
        isFile: candidate => present.has(candidate.toLowerCase())
    };
}

const SHIMS = 'C:\\Users\\dev\\scoop\\shims';

describe('readEnv', () => {
    // Windows spells it `Path`; Node's process.env is case-insensitive but a spread copy is not.
    test('finds a variable whatever its casing', () => {
        expect(readEnv({ Path: 'a' }, 'PATH')).toBe('a');
        expect(readEnv({ PATH: 'a' }, 'Path')).toBe('a');
        expect(readEnv({ ComSpec: 'x' }, 'COMSPEC')).toBe('x');
        expect(readEnv({}, 'PATH')).toBeUndefined();
    });
});

describe('resolveWindowsExecutable', () => {
    // The reported bug: Scoop shims `jpipe.ps1` as `jpipe`, producing jpipe.cmd + jpipe.ps1 +
    // an extension-less bash shim, but no jpipe.exe. CreateProcessW only tries `.exe`.
    test('finds a .cmd shim for a bare command name', () => {
        const deps = windows([`${SHIMS}\\jpipe.cmd`, `${SHIMS}\\jpipe.ps1`, `${SHIMS}\\jpipe`]);
        expect(resolveWindowsExecutable('jpipe', deps)?.toLowerCase()).toBe(`${SHIMS}\\jpipe.cmd`.toLowerCase());
    });

    test('never picks the extension-less shim, which Windows cannot execute', () => {
        const deps = windows([`${SHIMS}\\jpipe`]);
        expect(resolveWindowsExecutable('jpipe', deps)).toBeUndefined();
    });

    test('prefers .exe over .cmd, following PATHEXT order', () => {
        const deps = windows([`${SHIMS}\\tool.cmd`, `${SHIMS}\\tool.exe`]);
        expect(resolveWindowsExecutable('tool', deps)?.toLowerCase()).toBe(`${SHIMS}\\tool.exe`.toLowerCase());
    });

    test('searches PATH entries in order', () => {
        const deps = windows(['C:\\Windows\\system32\\java.exe']);
        expect(resolveWindowsExecutable('java', deps)?.toLowerCase()).toBe('C:\\Windows\\system32\\java.exe'.toLowerCase());
    });

    test('ignores script extensions we cannot launch', () => {
        // .PS1 in PATHEXT would otherwise resolve to a file CreateProcessW still cannot start.
        const deps = windows([`${SHIMS}\\jpipe.ps1`], { PATHEXT: '.COM;.EXE;.BAT;.CMD;.PS1' });
        expect(resolveWindowsExecutable('jpipe', deps)).toBeUndefined();
    });

    test('falls back to the standard extensions when PATHEXT is absent', () => {
        const deps = windows([`${SHIMS}\\jpipe.cmd`], { PATHEXT: '' });
        expect(resolveWindowsExecutable('jpipe', deps)?.toLowerCase()).toBe(`${SHIMS}\\jpipe.cmd`.toLowerCase());
    });

    test('does not search PATH when the command has a directory component', () => {
        const deps = windows([`${SHIMS}\\jpipe.cmd`, 'C:\\tools\\jpipe.cmd']);
        expect(resolveWindowsExecutable('C:\\tools\\jpipe', deps)?.toLowerCase()).toBe('C:\\tools\\jpipe.cmd'.toLowerCase());
    });

    test('accepts a fully specified path verbatim', () => {
        const deps = windows(['C:\\tools\\jpipe.cmd']);
        expect(resolveWindowsExecutable('C:\\tools\\jpipe.cmd', deps)).toBe('C:\\tools\\jpipe.cmd');
    });

    test('returns undefined when nothing matches', () => {
        expect(resolveWindowsExecutable('absent', windows([]))).toBeUndefined();
    });
});

describe('isBatchFile', () => {
    test.each([
        ['C:\\x\\jpipe.cmd', true],
        ['C:\\x\\jpipe.BAT', true],
        ['C:\\x\\jpipe.exe', false],
        ['C:\\x\\jpipe.ps1', false],
        ['C:\\x\\jpipe', false]
    ])('%s → %s', (file, expected) => {
        expect(isBatchFile(file)).toBe(expected);
    });
});

describe('planLaunch', () => {
    test('leaves POSIX completely alone', () => {
        const deps: LaunchEnvironment = {
            platform: 'darwin',
            env: { PATH: '/usr/bin' },
            isFile: () => true
        };
        expect(planLaunch('jpipe', ['process', '-i', 'a.jd'], deps)).toEqual({
            file: 'jpipe',
            args: ['process', '-i', 'a.jd']
        });
    });

    test('spawns a resolved .exe directly, with no interpreter', () => {
        const deps = windows(['C:\\Windows\\system32\\java.exe']);
        const plan = planLaunch('java', ['-jar', 'x.jar'], deps);

        expect(plan.file.toLowerCase()).toBe('C:\\Windows\\system32\\java.exe'.toLowerCase());
        expect(plan.args).toEqual(['-jar', 'x.jar']);
        expect(plan.windowsVerbatimArguments).toBeUndefined();
    });

    test('routes a .cmd shim through cmd.exe', () => {
        const deps = windows([`${SHIMS}\\jpipe.cmd`]);
        const plan = planLaunch('jpipe', ['process', '-i', 'C:\\models\\a.jd'], deps);

        expect(plan.file).toBe('C:\\Windows\\system32\\cmd.exe');
        expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
        expect(plan.windowsVerbatimArguments).toBe(true);
        // The whole command line is one wrapped argument, as `/s` expects.
        expect(plan.args).toHaveLength(4);
        expect(plan.args[3].startsWith('"')).toBe(true);
        expect(plan.args[3].endsWith('"')).toBe(true);
        expect(plan.args[3].toLowerCase()).toContain('jpipe.cmd');
    });

    test('falls back to the original name so Node reports the configured command', () => {
        // Nothing on disk: the user should see `spawn jpipe ENOENT`, naming what they set.
        const plan = planLaunch('jpipe', ['x'], windows([]));
        expect(plan).toEqual({ file: 'jpipe', args: ['x'] });
    });

    test('honours ComSpec when set', () => {
        const deps = windows([`${SHIMS}\\jpipe.cmd`], { ComSpec: 'D:\\alt\\cmd.exe' });
        expect(planLaunch('jpipe', [], deps).file).toBe('D:\\alt\\cmd.exe');
    });
});

describe('cmd.exe escaping', () => {
    // Arguments reach the compiler as file paths and a diagram name read out of the .jd file, so
    // they are user data. These are hand-worked expectations, not snapshots of the implementation:
    // quote → CRT backslash/quote rules → caret-escape cmd's metacharacters, twice when the
    // target is a batch file (its contents are parsed a second time, consuming one layer).
    test.each([
        // input                doubleEscape   expected
        ['plain',               false,         '^"plain^"'],
        ['plain',               true,          '^^^"plain^^^"'],
        // The whole point: `&` reaches the program as text rather than starting a new command.
        ['a&b',                 false,         '^"a^&b^"'],
        ['a&b',                 true,          '^^^"a^^^&b^^^"'],
        // A quote in the argument must not close the quoted span cmd is tracking.
        ['a"b',                 false,         '^"a\\^"b^"'],
        // A trailing backslash would otherwise escape the closing quote away.
        ['C:\\dir\\',           false,         '^"C:\\dir\\\\^"'],
        ['C:\\models\\a.jd',    true,          '^^^"C:\\models\\a.jd^^^"']
    ])('escapes %o (doubleEscape=%s)', (argument, doubleEscape, expected) => {
        expect(escapeCmdArgument(argument, doubleEscape as boolean)).toBe(expected);
    });

    test('an injection attempt stays a single argument', () => {
        const escaped = escapeCmdArgument('a.jd & calc.exe', true);
        // The text survives, but every character cmd would act on is caret-escaped, and the
        // argument stays wrapped, so `calc.exe` cannot become a second command.
        expect(escaped).toBe('^^^"a.jd^^^ ^^^&^^^ calc.exe^^^"');
    });

    test('double escaping adds a second caret layer for batch re-parsing', () => {
        expect(escapeCmdArgument('a&b', false)).toBe('^"a^&b^"');
        expect(escapeCmdArgument('a&b', true)).toBe('^^^"a^^^&b^^^"');
    });

    test('escapeCmdCommand protects the command without quoting it', () => {
        expect(escapeCmdCommand('C:\\Program Files\\jpipe.cmd')).toBe('C:\\Program^ Files\\jpipe.cmd');
    });
});
