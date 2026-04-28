import { beforeAll, describe, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { expectHover } from 'langium/test';
import { createJpipeServices } from 'jpipe-language';

let hover: ReturnType<typeof expectHover>;

beforeAll(async () => {
    const services = createJpipeServices(EmptyFileSystem);
    hover = expectHover(services.Jpipe);
});

describe('hover provider', () => {

    test('shows label for evidence', async () => {
        await hover({
            text: 'justification J { evidence e<|>1 is "My Evidence" conclusion c1 is "x" e1 supports c1 }',
            index: 0,
            hover: '**My Evidence** *(evidence)*',
            disposeAfterCheck: true
        });
    });

    test('shows label for strategy', async () => {
        await hover({
            text: 'justification J { evidence e1 is "x" strategy s<|>1 is "My Strategy" conclusion c1 is "x" e1 supports s1 s1 supports c1 }',
            index: 0,
            hover: '**My Strategy** *(strategy)*',
            disposeAfterCheck: true
        });
    });

    test('shows label for conclusion', async () => {
        await hover({
            text: 'justification J { evidence e1 is "x" conclusion c<|>1 is "My Conclusion" e1 supports c1 }',
            index: 0,
            hover: '**My Conclusion** *(conclusion)*',
            disposeAfterCheck: true
        });
    });

    test('shows label for sub-conclusion with correct kind', async () => {
        await hover({
            text: 'justification J { evidence e1 is "x" strategy s1 is "x" sub-conclusion sc<|>1 is "My SubConclusion" conclusion c1 is "x" e1 supports s1 s1 supports sc1 sc1 supports c1 }',
            index: 0,
            hover: '**My SubConclusion** *(sub-conclusion)*',
            disposeAfterCheck: true
        });
    });

    test('shows label for @support with correct kind', async () => {
        await hover({
            text: 'template T { @support abs<|>1 is "Abstract One" }',
            index: 0,
            hover: '**Abstract One** *(@support)*',
            disposeAfterCheck: true
        });
    });

    test('shows id for justification', async () => {
        await hover({
            text: 'justification <|>J { evidence e1 is "x" conclusion c1 is "x" e1 supports c1 }',
            index: 0,
            hover: '**J** *(justification)*',
            disposeAfterCheck: true
        });
    });

    test('shows id for template', async () => {
        await hover({
            text: 'template <|>T { @support abs1 is "Abstract Support" }',
            index: 0,
            hover: '**T** *(template)*',
            disposeAfterCheck: true
        });
    });
});
