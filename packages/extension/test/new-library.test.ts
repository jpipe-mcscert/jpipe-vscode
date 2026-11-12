import { describe, expect, test } from 'vitest';
import {
    defaultLibraryName,
    libraryFileName,
    libraryFolder,
    librarySkeleton,
    moduleNameError
} from '../src/extension/runner/new-library.js';
import { scanFile } from '../src/extension/runner/library-scan.js';

/** New Library…, minus the editor: the name, where the file goes, and what it starts with. */

describe('module names', () => {

    test.each(['release_steps', 'steps', '_private', 'steps2', 'steps.py'])('%s is usable', name => {
        expect(moduleNameError(name)).toBeUndefined();
    });

    test.each([
        ['', 'Give'],
        ['release-steps', 'letters, digits and underscores'],
        ['2steps', 'cannot start with a digit'],
        ['my steps', 'letters, digits and underscores'],
        ['import', 'keyword'],
        ['class.py', 'keyword']
    ])('%j is refused', (name, reason) => {
        expect(moduleNameError(name)).toContain(reason);
    });

    test('the file is the module name with .py, typed or not', () => {
        expect(libraryFileName('release_steps')).toBe('release_steps.py');
        expect(libraryFileName('release_steps.py')).toBe('release_steps.py');
    });

    test('the name offered is after the model in question, in snake case', () => {
        expect(defaultLibraryName('ReleaseSignoff')).toBe('release_signoff_steps');
        expect(defaultLibraryName(undefined)).toBe('steps');
        expect(defaultLibraryName('2go')).toBe('steps');
    });
});

describe('the folder', () => {

    const ROOT = 'file:///w';

    test('is where most libraries already are', () => {
        expect(libraryFolder(['file:///w/checks/a.py', 'file:///w/checks/b.py', 'file:///w/c.py'], 'file:///w/models/r.jd', [ROOT]))
            .toBe('file:///w/checks');
    });

    test('for the first library, is beside the model in question', () => {
        expect(libraryFolder([], 'file:///w/models/r.jd', [ROOT])).toBe('file:///w/models');
    });

    test('with neither, is the workspace folder', () => {
        expect(libraryFolder([], undefined, [ROOT])).toBe(ROOT);
    });
});

describe('the skeleton', () => {

    test('is listed as a library before it has a step', () => {
        expect(scanFile(librarySkeleton('release')).isLibrary).toBe(true);
    });

    test('names the justification it is for, and points at the authoring guide', () => {
        const text = librarySkeleton('release');
        expect(text).toContain('the release justification');
        expect(text).toContain('"release:e1"');
        expect(text).toContain('docs/authoring.md');
    });
});
