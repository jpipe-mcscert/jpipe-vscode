import { describe, expect, test } from 'vitest';
import manifest from '../package.json' with { type: 'json' };

/**
 * One jPipe menu wherever a model is right-clicked: the editor, a `.jd` file in the Explorer, and
 * a row of the Models view (jpipe-vscode ADR-VSC-0027). Menus are JSON and nothing type-checks
 * them, so the arrangement is held here: a place that stops showing the shared submenu, or an
 * Explorer item added beside it instead of inside it, fails this rather than reaching users.
 */

type MenuEntry = { command?: string; submenu?: string; when?: string; group?: string };
const menus = manifest.contributes.menus as unknown as Record<string, MenuEntry[]>;
const SUBMENU = 'jpipe.submenu';
const inSubmenu = new Set(menus[SUBMENU].map(e => e.command));

describe('the jPipe submenu', () => {

    test('is in the editor\'s context menu', () => {
        expect(menus['editor/context'].some(e => e.submenu === SUBMENU)).toBe(true);
    });

    test('is on a .jd file in the Explorer', () => {
        const entry = menus['explorer/context'].find(e => e.submenu === SUBMENU);
        expect(entry?.when).toContain("resourceExtname == '.jd'");
    });

    test('is on every model row in Models', () => {
        const entry = menus['view/item/context'].find(e => e.submenu === SUBMENU);
        expect(entry?.when).toContain('view == jpipe.models');
        expect(entry?.when).toContain('jpipe\\.model\\.');
    });

    test('holds every jPipe command the Explorer offers a .jd file', () => {
        // What stays outside the submenu in the Explorer is for folders only, which are not models.
        const outside = menus['explorer/context'].filter(e => e.command?.startsWith('jpipe.'));
        for (const entry of outside) {
            expect(entry.when, `${entry.command} is offered to .jd files outside the submenu`).toMatch(/^explorerResourceIsFolder\b/);
            expect(inSubmenu.has(entry.command)).toBe(true);
        }
    });

    test('decides Exclude or Include from the path in the editor, and from the row in Models', () => {
        for (const id of ['jpipe.excludeResource', 'jpipe.includeResource']) {
            const when = menus[SUBMENU].find(e => e.command === id)?.when ?? '';
            expect(when, id).toContain('resourcePath');
            expect(when, id).toContain('view == jpipe.models');
        }
    });
});
