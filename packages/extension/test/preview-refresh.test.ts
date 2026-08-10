/**
 * When the preview should re-run the compiler, follow the cursor, or stay put.
 *
 * This decision was previously inline in the provider, where nothing could reach it, and it was
 * wrong in one branch for as long as the diagnostic view has existed: in diagnostic mode it
 * followed the cursor unconditionally, so moving to a different file left the previous file's
 * report on screen looking like a current one.
 *
 * The costly answer is `render`, which runs the external compiler. So the cases below are really
 * about two failures with opposite shapes — running it when nothing has changed, and failing to
 * run it when everything has.
 */
import { describe, expect, test } from 'vitest';
import { responseToCursorMove, type CursorContext } from '../src/extension/image-generation/preview-refresh.js';

/** A cursor sitting where the panel is already looking, with nothing unsaved. */
function settled(overrides: Partial<CursorContext> = {}): CursorContext {
    return {
        mode: 'diagram',
        documentUri: 'file:///ws/model.jd',
        renderedUri: 'file:///ws/model.jd',
        unsaved: false,
        diagramAtCursor: 'j',
        renderedDiagram: 'j',
        ...overrides
    };
}

describe('diagnostic mode', () => {

    // The reported bug.
    test('re-runs the report when the cursor moves to another file', () => {
        expect(responseToCursorMove(settled({
            mode: 'diagnostic',
            documentUri: 'file:///ws/other.jd'
        }))).toBe('render');
    });

    // A report describes the file, so it cannot change as the cursor moves inside it; re-running
    // would put the compiler on every keystroke.
    test('only follows the cursor within one file', () => {
        expect(responseToCursorMove(settled({ mode: 'diagnostic' }))).toBe('highlight');
    });

    test('does not consult the diagram under the cursor', () => {
        expect(responseToCursorMove(settled({
            mode: 'diagnostic',
            diagramAtCursor: 'somethingElse'
        }))).toBe('highlight');
    });

    // Refusing would leave the previous file's report up, which says nothing true. The panel
    // states plainly that a report describes the last saved version.
    test('runs on a new file even with unsaved edits', () => {
        expect(responseToCursorMove(settled({
            mode: 'diagnostic',
            documentUri: 'file:///ws/other.jd',
            unsaved: true
        }))).toBe('render');
    });

    test('renders when the panel has shown nothing yet', () => {
        expect(responseToCursorMove(settled({
            mode: 'diagnostic',
            renderedUri: undefined
        }))).toBe('render');
    });
});

describe('diagram mode', () => {

    test('re-renders when the cursor moves to another file', () => {
        expect(responseToCursorMove(settled({ documentUri: 'file:///ws/other.jd' }))).toBe('render');
    });

    test('re-renders when the cursor moves to another diagram in the same file', () => {
        expect(responseToCursorMove(settled({ diagramAtCursor: 'k' }))).toBe('render');
    });

    test('follows the cursor within one diagram', () => {
        expect(responseToCursorMove(settled())).toBe('highlight');
    });

    // The compiler reads the file from disk, so rendering would draw an older picture.
    test('stays put on a new file while there are unsaved edits', () => {
        expect(responseToCursorMove(settled({
            documentUri: 'file:///ws/other.jd',
            unsaved: true
        }))).toBe('nothing');
    });

    test('does not re-render for a new diagram while there are unsaved edits', () => {
        expect(responseToCursorMove(settled({ diagramAtCursor: 'k', unsaved: true }))).toBe('highlight');
    });

    // Outside any diagram block there is nothing to render, so the panel keeps what it has.
    test('follows the cursor when it sits outside every diagram', () => {
        expect(responseToCursorMove(settled({ diagramAtCursor: undefined }))).toBe('highlight');
    });
});
