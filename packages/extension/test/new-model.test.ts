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
    loadsFile,
    modelSnippet,
    nameError,
    nameWarning
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

// The `load` is the server's own "add missing load" fix (#121); what is decided here is which of
// its fixes is the template's, when several files declare a template of that name.
describe('the load an implementation takes', () => {

    test.each([
        ['load "./signoff.jd"\n', 'file:///w/app/a.jd', 'file:///w/app/signoff.jd'],
        ['load "../lib/signoff.jd"\n\n', 'file:///w/app/a.jd', 'file:///w/lib/signoff.jd'],
        ['load "./my lib/t.jd"\n', 'file:///w/a.jd', 'file:///w/my%20lib/t.jd'],
        ['load "../lib/t.jd"\n', 'file:///c%3A/w/app/a.jd', 'file:///C%3A/w/lib/t.jd'],
        ['load "d:/lib/t.jd"\n', 'file:///c%3A/w/a.jd', 'file:///d%3A/lib/t.jd']
    ])('%s, written in %s, loads %s', (newText, file, target) => {
        expect(loadsFile(newText, file, target)).toBe(true);
    });

    test('is not one loading another file of the same template name', () => {
        expect(loadsFile('load "./other/signoff.jd"\n', 'file:///w/a.jd', 'file:///w/lib/signoff.jd')).toBe(false);
    });

    test('is not an edit that writes no load', () => {
        expect(loadsFile('evidence Signoff:e is "E"\n', 'file:///w/a.jd', 'file:///w/signoff.jd')).toBe(false);
    });

    test('a template loaded under a name is implemented under that name', () => {
        expect(modelSnippet('justification', 'J', { name: 'Signoff', uri: 'file:///w/lib.jd' }, 'lib'))
            .toBe('justification J implements lib:Signoff {\n}\n');
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
