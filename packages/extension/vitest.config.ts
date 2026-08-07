import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Only vscode-free modules are testable here: there is no VS Code host, so anything
        // importing 'vscode' must stay out of these tests.
        include: ['test/**/*.test.ts']
    }
});
