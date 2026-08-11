import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Only vscode-free modules are testable here: there is no VS Code host, so anything
        // importing 'vscode' must stay out of these tests.
        include: ['test/**/*.test.ts'],
        // Most of these run in plain Node. The diagnostic view is DOM code — it builds the
        // tables the panel shows — so it opts into a document with a per-file annotation
        // (`@vitest-environment happy-dom`) rather than everything paying for one.
        environment: 'node',
        coverage: {
            provider: 'v8',
            reporter: ['text-summary', 'lcov'],
            reportsDirectory: './coverage',
            // These tests import `../src/**` directly, so what v8 instruments is already the
            // source and `include` behaves as it reads: a module no test reaches is reported
            // as 0% rather than being absent, which is what stops new untested code from
            // quietly improving the average.
            //
            // The language package deliberately does NOT set this — its tests go through the
            // built `out/index.js`, and there the same line silently discards the coverage
            // before it can be mapped back to source. See the comment in its vitest.config.ts.
            include: ['src/**/*.ts'],
            // Not coverable, by construction rather than by neglect. Each of these either
            // imports `vscode` — which does not exist outside an extension host — or is an
            // environment entry point with module-level side effects. Reporting them as 0%
            // would drown the figure for the code that genuinely is under test.
            //
            // The rule for this list is *uncoverable by construction, never merely untested*:
            // a module belongs here because it cannot be loaded, not because covering it is
            // inconvenient. See jpipe-vscode ADR-VSC-0004.
            exclude: [
                'src/extension/main.ts',
                'src/extension/logger.ts',
                'src/extension/exclusions.ts',
                'src/extension/image-generation/image-generator.ts',
                'src/extension/image-generation/preview-provider.ts',
                'src/extension/image-generation/release-manager.ts',
                'src/extension/image-generation/preview-shell.ts',
                'src/extension/image-generation/index.ts',
                'src/language/main.ts',
                'src/webview/preview.ts',
                'src/webview/minimap.ts',
                // Types only — nothing to execute, so a coverage figure is meaningless.
                'src/shared/preview-protocol.ts',
                'src/shared/diagnostic-report.ts'
            ]
        }
    }
});
