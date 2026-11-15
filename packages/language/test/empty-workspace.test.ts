/**
 * A workspace with no model in it still answers.
 *
 * Requests such as `workspace/symbol` wait for the builder to reach a state. In a workspace with
 * no `.jd` file the first build has nothing to build, and a request that arrived while it was
 * under way used to wait forever — which is how the Models view, opened on a project that has no
 * model yet, never stopped loading.
 */
import { describe, expect, test } from 'vitest';
import { DocumentState, EmptyFileSystem } from 'langium';
import { createJpipeServices } from 'jpipe-language';

describe('a build with nothing to build', () => {

    test('releases whoever was waiting for the workspace to be linked', async () => {
        const { shared } = createJpipeServices(EmptyFileSystem);
        const builder = shared.workspace.DocumentBuilder;
        let answered = false;
        const waiting = builder.waitUntil(DocumentState.IndexedReferences).then(() => { answered = true; });
        await builder.build([]);
        await Promise.race([waiting, new Promise(resolve => setTimeout(resolve, 200))]);
        expect(answered).toBe(true);
    });

    test('leaves later requests nothing to wait for', async () => {
        const { shared } = createJpipeServices(EmptyFileSystem);
        await shared.workspace.DocumentBuilder.build([]);
        await expect(shared.workspace.DocumentBuilder.waitUntil(DocumentState.Validated)).resolves.toBeUndefined();
    });
});
