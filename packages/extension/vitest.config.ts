import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Only vscode-free modules are testable here: there is no VS Code host, so anything
        // importing 'vscode' must stay out of these tests.
        include: ['test/**/*.test.ts'],
        // Most of these run in plain Node. The diagnostic view is DOM code — it builds the
        // tables the panel shows — so it opts into a document with a per-file annotation
        // (`@vitest-environment happy-dom`) rather than everything paying for one.
        environment: 'node'
    }
});
