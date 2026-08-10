/**
 * "Auto-indent and align" — laying a file out the way the examples are written.
 *
 * The layout itself lives in `jpipe-layout.ts`; this is the decision to offer it, and where.
 *
 * Its kind sits under `source.jpipe.` rather than being a formatting provider, for the same reason
 * `organizeLoads` avoids `source.organizeImports`: `editor.formatOnSave` is a setting people carry
 * across every language they use, and re-spacing someone's argument the moment they hit save is a
 * decision they should make deliberately for this language, not inherit from another. Anyone who
 * wants it on save can still name this kind; they just have to mean it.
 *
 * It also means the action is only ever offered when it would change something, which a formatting
 * provider cannot express — `Source Action…` on an already-tidy file simply does not list it.
 */
import type { CodeAction } from 'vscode-languageserver';
import { layoutEdits } from '../jpipe-layout.js';
import { refactoring } from './types.js';

export const AUTO_INDENT_KIND = 'source.jpipe.autoIndent';

export const autoIndent = refactoring({
    id: 'auto-indent',
    actionKind: AUTO_INDENT_KIND,

    create(context): CodeAction[] {
        const edits = layoutEdits(context.document);
        if (edits.length === 0) return [];

        return [{
            title: 'Auto-indent and align',
            kind: AUTO_INDENT_KIND,
            edit: { changes: { [context.document.uri.toString()]: edits } }
        }];
    }
});
