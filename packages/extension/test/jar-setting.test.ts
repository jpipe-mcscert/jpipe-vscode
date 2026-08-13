/**
 * Where a JAR chosen from the file dialog gets written, and what counts as a JAR.
 *
 * The dialog itself needs an editor and is not covered here. This is the half that can be wrong
 * without anything saying so: VS Code resolves a setting most-specific-first, so a write to the
 * wrong scope succeeds, reports success, and changes a value nothing reads.
 */
import { describe, expect, test } from 'vitest';
import { looksLikeJar, scopeToWrite } from '../src/extension/compiler/jar-setting.js';

describe('choosing the scope to write the JAR path to', () => {

    // Nothing anywhere: the path names a file on this disk, which is a fact about the machine
    // rather than about the project, so it belongs in the user's own settings.
    test('falls back to global when the setting is unset everywhere', () => {
        expect(scopeToWrite({})).toBe('global');
    });

    test('overwrites the global value when that is where it lives', () => {
        expect(scopeToWrite({ globalValue: '/opt/jpipe/jpipe.jar' })).toBe('global');
    });

    /**
     * The case the rule exists for. Writing global here would leave the workspace value in front
     * of it, so the compiler would go on using the old jar while the User settings tab showed the
     * new one — the picker looking like it had done nothing.
     */
    test('overwrites the workspace value in preference to the global one', () => {
        expect(scopeToWrite({
            workspaceValue: '/work/project/build/jpipe.jar',
            globalValue: '/opt/jpipe/jpipe.jar'
        })).toBe('workspace');
    });

    test('and the folder value in preference to both', () => {
        expect(scopeToWrite({
            workspaceFolderValue: '/work/project/pkg/jpipe.jar',
            workspaceValue: '/work/project/build/jpipe.jar',
            globalValue: '/opt/jpipe/jpipe.jar'
        })).toBe('workspaceFolder');
    });

    /**
     * `jpipe.jarFile` declares `""` as its default, and a scope that holds only that holds
     * nothing anybody chose. Treating it as set would pin every later write to whichever scope
     * happened to carry the blank.
     */
    test('an empty string does not count as a value', () => {
        expect(scopeToWrite({ workspaceValue: '' })).toBe('global');
        expect(scopeToWrite({ workspaceValue: '   ' })).toBe('global');
        expect(scopeToWrite({ workspaceFolderValue: '', workspaceValue: '/w/jpipe.jar' })).toBe('workspace');
    });
});

describe('recognising a JAR', () => {

    test('accepts a .jar, whatever its case', () => {
        expect(looksLikeJar('/opt/jpipe/jpipe.jar')).toBe(true);
        expect(looksLikeJar('C:\\tools\\jPipe.JAR')).toBe(true);
    });

    // The dialog filters to .jar, but every file dialog offers a way past its own filter, and
    // the compiler's complaint about a file that is not an archive does not point back here.
    test('rejects what the filter would have kept out', () => {
        expect(looksLikeJar('/opt/jpipe/jpipe')).toBe(false);
        expect(looksLikeJar('/opt/jpipe/jpipe.jar.txt')).toBe(false);
        expect(looksLikeJar('/opt/jpipe/jarfile')).toBe(false);
        expect(looksLikeJar('')).toBe(false);
    });
});
