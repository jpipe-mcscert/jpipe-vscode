import { describe, expect, test } from 'vitest';
import manifest from '../package.json' with { type: 'json' };

/**
 * The same jPipe items wherever a model is right-clicked: the editor, a `.jd` file in the
 * Explorer, and a row of the Models view (jpipe-vscode ADR-VSC-0027). Menus are JSON and nothing
 * type-checks them, so the arrangement is held here: a place that loses an item, gains one the
 * others lack, or lists export formats itself instead of showing the shared submenu, fails this
 * rather than reaching users.
 */

type MenuEntry = { command?: string; submenu?: string; when?: string; group?: string };
const menus = manifest.contributes.menus as unknown as Record<string, MenuEntry[]>;
const EXPORT_AS = 'jpipe.exportAs';

/** Each place a model is right-clicked, and the `when` fragment that says "this is a model". */
const PLACES = [
    { menu: 'editor/context', isModel: 'resourceLangId == jpipe' },
    { menu: 'explorer/context', isModel: "resourceExtname == '.jd'" },
    { menu: 'view/item/context', isModel: 'view == jpipe.models && viewItem =~ /^jpipe\\.model\\.' }
];

/** What a place offers a model: its entries whose `when` names a model, as command or submenu ids. */
const offered = (place: typeof PLACES[number]): MenuEntry[] =>
    menus[place.menu].filter(e => e.when?.includes(place.isModel));
const idOf = (entry: MenuEntry): string => entry.command ?? entry.submenu ?? '';

describe('the ▶ menu of a Python editor', () => {

    test('offers Run as jPipe, then Check as jPipe Library, on a checked library only', () => {
        const entries = menus['editor/title/run'];
        expect(entries.map(idOf)).toEqual(['jpipe.runLibrary', 'jpipe.checkLibrary']);
        for (const entry of entries) {
            expect(entry.when).toBe('resourceLangId == python && resourcePath in jpipe.checkedLibraryPaths');
            // Never first: the button itself stays the Python extension's own run.
            expect(entry.group?.startsWith('navigation')).toBe(false);
        }
    });
});

describe('a justification in the Models view', () => {

    test('offers Run, then Check, at the top of its menu, and only Run inline', () => {
        const isJustification = 'view == jpipe.models && viewItem =~ /^jpipe\\.model\\.justification/';
        const entries = menus['view/item/context'].filter(e => e.when === isJustification);
        const inMenu = entries.filter(e => e.group?.startsWith('1_model@')).sort((a, b) => a.group!.localeCompare(b.group!));
        expect(inMenu.slice(0, 2).map(idOf)).toEqual(['jpipe.run', 'jpipe.check']);
        expect(entries.filter(e => e.group?.startsWith('inline')).map(idOf)).toEqual(['jpipe.run']);
    });
});

describe('right-clicking a model', () => {

    test.each(PLACES)('in $menu offers preview, Export as…, and Exclude or Include, in that order', place => {
        // A menu group is `name@order`: the shared items are those in the group Export as… is in.
        const groupOf = (entry: MenuEntry | undefined) => entry?.group?.split('@')[0];
        const orderOf = (entry: MenuEntry) => Number(entry.group?.split('@')[1]);
        const entries = offered(place);
        const exportGroup = groupOf(entries.find(e => e.submenu === EXPORT_AS));
        const shared = entries.filter(e => groupOf(e) === exportGroup).sort((a, b) => orderOf(a) - orderOf(b));
        expect(shared.map(idOf)).toEqual([
            'jpipe.vis.preview', EXPORT_AS, 'jpipe.excludeResource', 'jpipe.includeResource'
        ]);
    });

    test.each(PLACES)('in $menu reaches every export format through the one submenu', place => {
        const formats = new Set(menus[EXPORT_AS].map(e => e.command));
        expect(formats.size).toBeGreaterThan(0);
        for (const entry of menus[place.menu]) {
            expect(formats.has(entry.command), `${entry.command} is listed in ${place.menu} itself`).toBe(false);
        }
    });

    test('offers Exclude or Include, never both', () => {
        // Decided from the file's path in the editor and the Explorer, and from the row in
        // Models, where VS Code sets no path.
        const whenOf = (menu: string, id: string) => menus[menu].find(e => e.command === id && e.group !== 'inline')?.when ?? '';
        for (const menu of ['editor/context', 'explorer/context']) {
            expect(whenOf(menu, 'jpipe.excludeResource')).toContain('resourcePath not in jpipe.excludedResourcePaths');
            expect(whenOf(menu, 'jpipe.includeResource')).toContain('resourcePath in jpipe.excludedResourcePaths');
        }
        const row = (kind: string) => (id: string) => new RegExp(/viewItem =~ \/(.*)\/$/.exec(whenOf('view/item/context', id))![1]).test(kind);
        for (const [kind, excluded] of [['jpipe.model.template', false], ['jpipe.model.justification.excluded', true]] as const) {
            expect(row(kind)('jpipe.excludeResource'), kind).toBe(!excluded);
            expect(row(kind)('jpipe.includeResource'), kind).toBe(excluded);
        }
    });

    test('the Explorer still offers Exclude and Include on a folder', () => {
        for (const id of ['jpipe.excludeResource', 'jpipe.includeResource']) {
            expect(menus['explorer/context'].find(e => e.command === id)?.when).toContain('explorerResourceIsFolder');
        }
    });
});
