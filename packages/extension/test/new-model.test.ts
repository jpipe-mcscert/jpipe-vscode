import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
    RESERVED_WORDS,
    appendSeparator,
    chooseFolder,
    dirnameOf,
    fileNameFor,
    kebabCase,
    loadInsertionLine,
    loadsFile,
    modelSnippet,
    nameError,
    nameWarning,
    relativeLoadPath
} from '../src/extension/models-view/new-model.js';

/**
 * Creating a model from the Models view, minus the editor. The failures that matter are the ones a
 * user only finds after pressing Enter: a name that does not parse, a file in an unexpected
 * place, a `load` that does not resolve, or a skeleton that starts out broken.
 */

const here = dirname(fileURLToPath(import.meta.url));

describe('model names', () => {

    test.each(['Release', 'release_v2', 'R2D2', 'x'])('%s is usable', name => {
        expect(nameError(name)).toBeUndefined();
    });

    test.each([
        ['', 'Give'],
        ['Release Signoff', 'letters, digits and underscores'],
        ['release-signoff', 'letters, digits and underscores'],
        ['template', 'keyword'],
        ['is', 'keyword']
    ])('%j is refused', (name, reason) => {
        expect(nameError(name)).toContain(reason);
    });

    test('a name the target file already declares is refused', () => {
        expect(nameError('Release', ['Release'])).toContain('already declares');
    });

    test('a name used in another file only warns', () => {
        expect(nameWarning('Release', ['Release'])).toContain('ambiguous');
        expect(nameWarning('Release', ['Other'])).toBeUndefined();
    });

    test('the reserved words are every identifier-shaped keyword in the grammar', () => {
        // A keyword added to the grammar would otherwise be accepted as a name and fail to parse.
        const grammar = readFileSync(join(here, '..', '..', 'language', 'src', 'jpipe.langium'), 'utf8');
        const keywords = [...grammar.matchAll(/'(\w+)'/g)].map(m => m[1]);
        expect([...new Set(keywords)].sort()).toEqual([...RESERVED_WORDS].sort());
    });
});

describe('file names', () => {

    test.each([
        ['ReleaseSignoff', 'release-signoff'],
        ['HTTPServer', 'http-server'],
        ['parseHTTPRequest', 'parse-http-request'],
        ['release_v2', 'release-v2'],
        ['Release2Go', 'release2-go'],
        ['_private__thing_', 'private-thing'],
        ['x', 'x']
    ])('%s → %s', (name, kebab) => {
        expect(kebabCase(name)).toBe(kebab);
    });

    test('the file is the kebab-cased name with the .jd extension', () => {
        expect(fileNameFor('ReleaseSignoff')).toBe('release-signoff.jd');
    });
});

describe('choosing the folder', () => {

    const ROOT = 'file:///w';

    test('beside the model the command was invoked on, first', () => {
        expect(chooseFolder({
            contextUri: 'file:///w/lib/signoff.jd',
            activeUri: 'file:///w/app/a.jd',
            modelUris: [],
            workspaceFolders: [ROOT]
        })).toBe('file:///w/lib');
    });

    test('then beside the file being edited', () => {
        expect(chooseFolder({ activeUri: 'file:///w/app/a.jd', modelUris: [], workspaceFolders: [ROOT] }))
            .toBe('file:///w/app');
    });

    test('then where most models already are, preferring the shallower folder on a tie', () => {
        expect(chooseFolder({
            modelUris: ['file:///w/a/x.jd', 'file:///w/b/y.jd', 'file:///w/b/z.jd'],
            workspaceFolders: [ROOT]
        })).toBe('file:///w/b');
        expect(chooseFolder({
            modelUris: ['file:///w/deep/er/x.jd', 'file:///w/top/y.jd'],
            workspaceFolders: [ROOT]
        })).toBe('file:///w/top');
    });

    test('then the first workspace folder, and nothing without one', () => {
        expect(chooseFolder({ modelUris: [], workspaceFolders: [ROOT, 'file:///v'] })).toBe(ROOT);
        expect(chooseFolder({ modelUris: [], workspaceFolders: [] })).toBeUndefined();
    });

    test('dirnameOf drops the last segment', () => {
        expect(dirnameOf('file:///w/lib/signoff.jd')).toBe('file:///w/lib');
    });
});

describe('loads', () => {

    test.each([
        ['file:///w/app/a.jd', 'file:///w/app/signoff.jd', 'signoff.jd'],
        ['file:///w/app/a.jd', 'file:///w/lib/signoff.jd', '../lib/signoff.jd'],
        ['file:///w/a.jd', 'file:///w/lib/deep/signoff.jd', 'lib/deep/signoff.jd'],
        ['file:///w/my%20app/a.jd', 'file:///w/my%20lib/t.jd', '../my lib/t.jd'],
        ['file:///c%3A/w/app/a.jd', 'file:///c%3A/w/lib/t.jd', '../lib/t.jd']
    ])('from %s to %s is %s', (from, to, expected) => {
        expect(relativeLoadPath(from, to)).toBe(expected);
    });

    test('a file already loading the template literally is recognised, however the path is spelled', () => {
        const text = 'load "../lib/signoff.jd"\nload "other.jd"\n';
        expect(loadsFile(text, 'file:///w/app/a.jd', 'file:///w/lib/signoff.jd')).toBe(true);
        expect(loadsFile('load "./../lib/./signoff.jd"', 'file:///w/app/a.jd', 'file:///w/lib/signoff.jd')).toBe(true);
        expect(loadsFile(text, 'file:///w/app/a.jd', 'file:///w/lib/strict.jd')).toBe(false);
    });

    test('a glob is not taken for a literal load', () => {
        expect(loadsFile('load "../lib/*.jd"', 'file:///w/app/a.jd', 'file:///w/lib/signoff.jd')).toBe(false);
    });

    test('a new load goes after the last one, or at the top', () => {
        expect(loadInsertionLine('load "a.jd"\nload "b.jd"\n\njustification J {\n}')).toBe(2);
        expect(loadInsertionLine('justification J {\n}')).toBe(0);
    });
});

describe('the skeleton', () => {

    test('of a justification is evidence → strategy → conclusion, laid out as the formatter would', () => {
        expect(modelSnippet('justification', 'Release')).toBe([
            'justification Release {',
            '    evidence   ${1:e} is "${2:Evidence}"',
            '    strategy   ${3:s} is "${4:Strategy}"',
            '    conclusion ${5:c} is "${6:Conclusion}"',
            '    ${1:e} supports ${3:s}',
            '    ${3:s} supports ${5:c}',
            '}',
            ''
        ].join('\n'));
    });

    test('of a template has an @support where the evidence would be', () => {
        const snippet = modelSnippet('template', 'Signoff');
        expect(snippet).toMatch(/^template Signoff \{\n/);
        expect(snippet).toContain('    @support   ${1:e} is "${2:Evidence}"');
    });

    test('of an implementation is an empty body for the server to fill', () => {
        expect(modelSnippet('justification', 'Release', { name: 'Signoff', uri: 'file:///w/lib/s.jd' }))
            .toBe('justification Release implements Signoff {\n}\n');
    });

    test.each([
        ['', ''],
        ['   \n', ''],
        ['justification J {\n}', '\n\n'],
        ['justification J {\n}\n', '\n'],
        ['justification J {\n}\n\n', '']
    ])('appending after %j leaves one blank line', (text, separator) => {
        expect(appendSeparator(text)).toBe(separator);
    });
});
