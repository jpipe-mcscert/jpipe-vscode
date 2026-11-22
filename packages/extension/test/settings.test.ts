import { describe, expect, test } from 'vitest';
import manifest from '../package.json' with { type: 'json' };

/**
 * The settings groups, as the Settings editor lists them (jpipe-vscode ADR-VSC-0028).
 *
 * VS Code shows one level of groups, so the tree — a compiler family, a runner family — is
 * written into the titles: `jPipe › <Tool> › <Group>`. What is held here is that every group is
 * named that way, and that the list reads as the tree would.
 */

const groups = [...manifest.contributes.configuration].sort((a, b) => a.order - b.order);
const TITLE = /^jPipe › (Compiler|Runner) › (.+)$/;
const toolOf = (title: string) => TITLE.exec(title)![1];

describe('the settings groups', () => {

    test('are each titled jPipe › Tool › Group', () => {
        for (const group of groups) expect(group.title).toMatch(TITLE);
    });

    test('are listed tool by tool, the compiler first', () => {
        const tools = groups.map(group => toolOf(group.title));
        expect(tools.filter((tool, i) => tool !== tools[i - 1])).toEqual(['Compiler', 'Runner']);
    });

    test('start, for each tool, with its General group', () => {
        for (const tool of ['Compiler', 'Runner']) {
            expect(groups.find(group => toolOf(group.title) === tool)!.title).toBe(`jPipe › ${tool} › General`);
        }
    });

    test('have distinct titles and distinct places in the list', () => {
        expect(new Set(groups.map(group => group.title)).size).toBe(groups.length);
        expect(new Set(groups.map(group => group.order)).size).toBe(groups.length);
    });

    test('keep the runner\'s settings out of the compiler\'s groups, and the reverse', () => {
        for (const group of groups) {
            const runner = toolOf(group.title) === 'Runner';
            for (const id of Object.keys(group.properties)) expect(id.startsWith('jpipe.runner.'), id).toBe(runner);
        }
    });
});
