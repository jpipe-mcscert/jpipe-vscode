import { describe, expect, test } from 'vitest';
import * as path from 'node:path';
import {
    buildPathEnv,
    expandTilde,
    findDiagramName,
    resolveExecCommand,
    type CompilerContext,
    type CompilerSettings
} from '../src/extension/image-generation/compiler-invocation.js';

const HOME = '/home/dev';

function settings(overrides: Partial<CompilerSettings> = {}): CompilerSettings {
    return {
        executionMode: 'cli',
        cliPath: 'jpipe',
        jarFile: '',
        javaExecutable: 'java',
        jvmArgs: [],
        ...overrides
    };
}

function context(overrides: Partial<CompilerContext> = {}): CompilerContext {
    return {
        fileExists: () => true,
        installedJarPath: undefined,
        home: HOME,
        ...overrides
    };
}

describe('expandTilde', () => {
    test('expands a leading ~', () => {
        expect(expandTilde('~', HOME)).toBe(HOME);
        expect(expandTilde('~/jars/jpipe.jar', HOME)).toBe(path.join(HOME, 'jars/jpipe.jar'));
        expect(expandTilde('~\\jars\\jpipe.jar', HOME)).toBe(path.join(HOME, 'jars\\jpipe.jar'));
    });

    test('leaves everything else alone', () => {
        expect(expandTilde('/abs/jpipe.jar', HOME)).toBe('/abs/jpipe.jar');
        expect(expandTilde('', HOME)).toBe('');
        // Only a leading ~ followed by a separator is a home reference.
        expect(expandTilde('~user/jpipe.jar', HOME)).toBe('~user/jpipe.jar');
    });
});

describe('resolveExecCommand — cli mode', () => {
    test('passes a bare name through for PATH lookup at spawn time', () => {
        expect(resolveExecCommand(settings(), context())).toEqual({ file: 'jpipe', args: [] });
    });

    test('trims a configured name', () => {
        expect(resolveExecCommand(settings({ cliPath: '  jpipe  ' }), context()).file).toBe('jpipe');
    });

    test('normalises a path-like setting', () => {
        const resolved = resolveExecCommand(settings({ cliPath: '/opt/bin/../bin/jpipe' }), context());
        expect(resolved.file).toBe(path.normalize('/opt/bin/../bin/jpipe'));
    });

    test('does not consult the filesystem — a missing CLI fails at spawn, not here', () => {
        // The error should name the command the user configured, which is spawn's job.
        expect(() => resolveExecCommand(settings({ cliPath: 'absent' }), context({ fileExists: () => false })))
            .not.toThrow();
    });
});

describe('resolveExecCommand — jar mode', () => {
    test('builds java -jar with the configured jar', () => {
        const resolved = resolveExecCommand(
            settings({ executionMode: 'jar', jarFile: '/jars/jpipe.jar' }), context());
        expect(resolved).toEqual({ file: 'java', args: ['-jar', path.normalize('/jars/jpipe.jar')] });
    });

    test('expands ~ in the jar path', () => {
        const resolved = resolveExecCommand(
            settings({ executionMode: 'jar', jarFile: '~/jars/jpipe.jar' }), context());
        expect(resolved.args).toEqual(['-jar', path.normalize(path.join(HOME, 'jars/jpipe.jar'))]);
    });

    test('inserts jvm args before -jar, dropping blanks', () => {
        const resolved = resolveExecCommand(
            settings({ executionMode: 'jar', jarFile: '/j.jar', jvmArgs: ['-Xmx1g', '  ', ' -Dx=1 '] }),
            context());
        expect(resolved.args).toEqual(['-Xmx1g', '-Dx=1', '-jar', path.normalize('/j.jar')]);
    });

    test('honours a custom java executable', () => {
        const resolved = resolveExecCommand(
            settings({ executionMode: 'jar', jarFile: '/j.jar', javaExecutable: ' /jdk/bin/java ' }), context());
        expect(resolved.file).toBe('/jdk/bin/java');
    });

    test('complains when unconfigured', () => {
        expect(() => resolveExecCommand(settings({ executionMode: 'jar' }), context()))
            .toThrow(/jarFile is not configured/);
    });

    test('complains when the jar is missing, naming it', () => {
        expect(() => resolveExecCommand(
            settings({ executionMode: 'jar', jarFile: '/jars/gone.jar' }),
            context({ fileExists: () => false })))
            .toThrow(/JAR file not found: \/jars\/gone\.jar/);
    });
});

describe('resolveExecCommand — managed mode', () => {
    test('runs the installed jar', () => {
        const resolved = resolveExecCommand(
            settings({ executionMode: 'managed' }),
            context({ installedJarPath: '/store/v2.3.0/jpipe-cli-2.3.0.jar' }));
        expect(resolved).toEqual({
            file: 'java',
            args: ['-jar', path.normalize('/store/v2.3.0/jpipe-cli-2.3.0.jar')]
        });
    });

    test('points at the install command when nothing is installed', () => {
        expect(() => resolveExecCommand(settings({ executionMode: 'managed' }), context()))
            .toThrow(/No managed jPipe compiler installed/);
    });

    test('reports a recorded jar that has since gone', () => {
        expect(() => resolveExecCommand(
            settings({ executionMode: 'managed' }),
            context({ installedJarPath: '/store/gone.jar', fileExists: () => false })))
            .toThrow(/Managed JAR file not found/);
    });
});

describe('buildPathEnv', () => {
    test('puts configured entries first, then defaults, then the inherited PATH', () => {
        const env = buildPathEnv({ PATH: '/usr/bin' }, ['/my/tools'], 'darwin');
        expect(env.PATH).toBe('/my/tools:/opt/homebrew/bin:/usr/local/bin:/usr/bin');
    });

    test('drops blank segments rather than emitting an empty one', () => {
        // An empty PATH segment means "current directory" to POSIX shells — a footgun.
        const env = buildPathEnv({ PATH: '' }, ['  ', '/my/tools'], 'darwin');
        expect(env.PATH).toBe('/my/tools:/opt/homebrew/bin:/usr/local/bin');
        expect(env.PATH).not.toMatch(/::|:$/);
    });

    test('omits the Homebrew defaults on Windows and uses its delimiter', () => {
        const env = buildPathEnv({ Path: 'C:\\Windows' }, ['C:\\tools'], 'win32');
        expect(env.Path).toBe('C:\\tools;C:\\Windows');
        expect(env.Path).not.toContain('homebrew');
    });

    // Windows spells it `Path`; adding `PATH` alongside would leave the child with two entries
    // differing only in case, and no say in which one wins.
    test('replaces the existing PATH key rather than adding a second casing', () => {
        const env = buildPathEnv({ Path: 'C:\\Windows', OTHER: 'x' }, ['C:\\tools'], 'win32');
        const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === 'path');
        expect(pathKeys).toEqual(['Path']);
        expect(env.OTHER).toBe('x');
    });

    test('defaults to PATH when the environment has none', () => {
        const env = buildPathEnv({}, ['/my/tools'], 'darwin');
        expect(Object.keys(env).filter(k => k.toLowerCase() === 'path')).toEqual(['PATH']);
        expect(env.PATH).toBe('/my/tools:/opt/homebrew/bin:/usr/local/bin');
    });

    test('leaves the rest of the environment untouched', () => {
        const env = buildPathEnv({ PATH: '/usr/bin', JAVA_HOME: '/jdk' }, [], 'linux');
        expect(env.JAVA_HOME).toBe('/jdk');
    });
});

describe('findDiagramName', () => {
    const model = [
        'load "base.jd"',          // 0
        'justification first {',   // 1
        '    evidence e is "x"',   // 2
        '}',                       // 3
        '',                        // 4
        'template second {',       // 5
        '    @support s is "y"',   // 6
        '}'                        // 7
    ].join('\n');

    test('picks the declaration the cursor is inside', () => {
        expect(findDiagramName(model, 2)).toBe('first');
        expect(findDiagramName(model, 6)).toBe('second');
    });

    test('picks the declaration on the cursor line itself', () => {
        expect(findDiagramName(model, 1)).toBe('first');
        expect(findDiagramName(model, 5)).toBe('second');
    });

    // Scanning down to the cursor rather than up from it means a cursor past a closing brace,
    // but before the next declaration, still selects the model it just left.
    test('a cursor between models keeps the previous one', () => {
        expect(findDiagramName(model, 4)).toBe('first');
    });

    test('a cursor beyond the end of the file selects the last declaration', () => {
        expect(findDiagramName(model, 999)).toBe('second');
    });

    test('matches templates and justifications, case-insensitively and with indentation', () => {
        expect(findDiagramName('  JUSTIFICATION Weird {', 0)).toBe('Weird');
        expect(findDiagramName('\ttemplate Indented {', 0)).toBe('Indented');
    });

    test('ignores the word appearing mid-line', () => {
        // Only a declaration at the start of a line counts.
        expect(() => findDiagramName('// see justification foo for details', 0))
            .toThrow(/No diagram name found/);
    });

    test('complains when the file declares nothing renderable', () => {
        expect(() => findDiagramName('load "base.jd"\n', 0)).toThrow(/No diagram name found/);
        expect(() => findDiagramName('', 0)).toThrow(/No diagram name found/);
    });

    test('a declaration below the cursor is not selected', () => {
        expect(() => findDiagramName(model, 0)).toThrow(/No diagram name found/);
    });
});
