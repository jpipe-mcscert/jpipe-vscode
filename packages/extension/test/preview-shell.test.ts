import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * The shell markup and the code that reaches into it, checked against each other.
 *
 * `preview-shell.ts` imports `vscode`, so it cannot be loaded here — but the part that matters is
 * a template literal, and reading it as text is enough to catch the failure that actually
 * happens: someone renames an id in one file and the other silently gets `null`, which surfaces
 * as a dead control rather than an error.
 *
 * This is not a substitute for looking at the panel. It is a substitute for finding out about a
 * typo by looking at the panel.
 */

/** No `__dirname` in an ESM package; see the note in `diagnostic-fixtures.test.ts`. */
const here = dirname(fileURLToPath(import.meta.url));

const read = (...parts: string[]) => readFileSync(join(here, '..', ...parts), 'utf8');

const shell = read('src', 'extension', 'image-generation', 'preview-shell.ts');
const preview = read('src', 'webview', 'preview.ts');
const css = read('src', 'webview', 'preview.css');

/** Every `getElementById('…')` the page performs. */
function lookedUpIds(source: string): string[] {
    return [...source.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
}

describe('the shell provides what the page looks up', () => {
    test('every element the page fetches by id exists in the markup', () => {
        const ids = lookedUpIds(preview);
        expect(ids.length).toBeGreaterThan(10);
        for (const id of ids) {
            expect(shell, `#${id} is fetched by preview.ts but absent from the shell`)
                .toContain(`id="${id}"`);
        }
    });

    /**
     * Two banners, and either may be up — a compile failure on a file with unsaved edits raises
     * both. The layers below are offset by the stack's *measured* height, so the stack has to be
     * one element with both banners inside it; a banner outside it would overlap the diagram.
     */
    test('both banners are inside the one stack the layers are offset by', () => {
        const stack = shell.slice(shell.indexOf('id="banners"'), shell.indexOf('class="layer"'));
        expect(stack).toContain('id="unsaved-banner"');
        expect(stack).toContain('id="error-banner"');
        expect(css).toMatch(/\.layer\s*\{[^}]*top:\s*calc\(44px \+ var\(--banners-height/);
    });

    // A constant offset was right for one banner and wrong for none, both, or either wrapping on
    // a narrow panel — so nothing may depend on a banner being a known height.
    test('no rule assumes how tall the banners are', () => {
        expect(css).not.toContain('has-unsaved-banner');
    });

    /**
     * The two banners can be up together, and amber against red is the pair a red-green colour
     * deficiency is least able to separate — so they must not be the same banner in two colours.
     */
    test('the banners differ by glyph, not only by hue', () => {
        const glyphs = [...shell.matchAll(/class="banner-glyph"[^>]*>([^<]+)</g)].map(m => m[1]);
        expect(glyphs).toHaveLength(2);
        expect(new Set(glyphs).size, `both banners open with '${glyphs[0]}'`).toBe(2);
    });

    /**
     * Setting a banner's text in the same colour its background is tinted with is what put every
     * one of these under the WCAG AA threshold — the unsaved banner reached 2.4:1 on a light
     * theme. The words take the editor's foreground; the hue stays on the background, the rule
     * beneath and the glyph, none of which carries meaning the words do not.
     */
    test('banner text is set in the editor foreground, not in the hue', () => {
        const rule = css.slice(css.indexOf('.banner {'), css.indexOf('.banner.visible'));
        expect(rule).toContain('color: var(--vscode-editor-foreground)');
        for (const id of ['#unsaved-banner {', '#error-banner {']) {
            const block = css.slice(css.indexOf(id), css.indexOf('}', css.indexOf(id)));
            expect(block, `${id} should not colour its text with its own hue`).not.toMatch(/[^-]color:/);
        }
    });

    // A banner appearing is the whole signal; a screen reader that never hears about it is left
    // with a diagram and no reason to doubt it.
    test('each banner announces itself', () => {
        const stack = shell.slice(shell.indexOf('id="banners"'), shell.indexOf('class="layer"'));
        expect([...stack.matchAll(/role="status"/g)]).toHaveLength(2);
        expect([...stack.matchAll(/aria-live="polite"/g)]).toHaveLength(2);
    });

    // The banner says it in words now. A wash over the whole diagram said only that *something*
    // had happened, and cost the diagram's own readability to say it.
    test('a failed compile no longer tints the diagram', () => {
        expect(css).not.toContain('jpipe-render-error');
    });

    test('the diagnostic layer carries both of its faces', () => {
        // The structured view and the raw text live in the same layer; losing either turns one
        // of the two supported outcomes into a blank panel.
        expect(shell).toContain('id="diag-panel"');
        expect(shell).toContain('id="diag-output"');
    });

    test('every tab the view knows about is in the strip', () => {
        for (const tab of ['diagnostics', 'models', 'symbols', 'actions']) {
            expect(shell).toContain(`data-tab="${tab}"`);
        }
    });
});

describe('toolbar order', () => {
    /**
     * The mode switch is the only control on the right belonging to the panel rather than to what
     * the panel is showing. Everything else there appears and disappears with the mode, so if the
     * switch is not last it moves under the user as they use it.
     */
    test('the mode switch is the last control on the right', () => {
        // Bounded by the banner stack, which is the first thing after the toolbar.
        const toolbar = shell.slice(shell.indexOf('id="toolbar-right"'), shell.indexOf('id="banners"'));
        const buttons = [...toolbar.matchAll(/id="([a-z-]+)"/g)].map(m => m[1]);
        expect(buttons.at(-1)).toBe('mode-toggle');
    });

    test('it is not in a group that hides with the diagram', () => {
        // `diagram-only` groups vanish outside diagram mode; the switch has to survive that or
        // there is no way back.
        const group = shell.slice(shell.indexOf('id="mode-group"') - 200, shell.indexOf('id="mode-toggle"'));
        expect(group).not.toContain('diagram-only');
    });

    // Settings belong to the extension, not to the diagram or the report, so the gear sits with
    // the brand rather than among the controls that change with the mode.
    test('the settings gear sits in the brand, beside the jpipe.org link', () => {
        const brand = shell.slice(shell.indexOf('id="brand"'), shell.indexOf('id="toolbar-right"'));
        expect(brand).toContain('id="open-settings"');
        expect(brand.indexOf('id="jpipe-link"')).toBeLessThan(brand.indexOf('id="open-settings"'));
    });

    // A gear is a rim with teeth on it; a ring of detached strokes around a dot is a sun.
    test('the gear is drawn as a rim with teeth, not as rays', () => {
        const button = shell.slice(shell.indexOf('id="open-settings"'), shell.indexOf('</button>', shell.indexOf('id="open-settings"')));
        expect(button).toContain('<circle');
        // Teeth are struck thicker than the rim so they read as part of it.
        expect(button).toMatch(/stroke-width="2(\.\d+)?"/);
    });
});

describe('the diagnostic layer is laid out as a column', () => {
    /**
     * `body[data-mode="diagnostic"] #diagnostic-overlay` outranks a bare `#diagnostic-overlay`,
     * so the layer's `display` has to be set in the selecting rule. Setting it anywhere else
     * leaves the layer `display: block`, the panel inside it with no flex context, and the
     * content growing past a `overflow: hidden` layer where it cannot be scrolled to.
     */
    test('the layer-selection rule makes it a flex container', () => {
        expect(css).toMatch(/body\[data-mode="diagnostic"\]\s*#diagnostic-overlay\s*\{\s*display:\s*flex/);
    });

    test('the panel is the part that scrolls', () => {
        expect(css).toMatch(/#diag-panel\s*\{[^}]*overflow:\s*auto/);
    });

    /**
     * Copy / Report / Text / JSON sit at the right of the header, and have to stay there when the
     * tabs beside them are not on screen.
     *
     * Two states hide the tabs: any face but Report, and a report from a compiler too old to
     * produce a structured one. In both, this row is the header's only child — and `space-between`
     * places a lone flex child at the *start*, which slid the whole group to the left edge. So the
     * position cannot be left to the header's distribution; the row has to push itself over.
     */
    test('the report controls hold the right edge without the tabs beside them', () => {
        expect(css, 'raw faces hide the tabs, so the header can be left with one child')
            .toMatch(/body\.diag-raw\s+#diag-tabs[^{]*\{[^}]*display:\s*none/);
        expect(css, '#diag-summary-actions must not depend on a sibling for its position')
            .toMatch(/#diag-summary-actions\s*\{[^}]*margin-left:\s*auto/);
    });
});
