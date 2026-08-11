/*
 * For a detailed explanation regarding each configuration property and type check, visit:
 * https://vitest.dev/config/
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        deps: {
            interopDefault: true
        },
        include: ['**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text-summary', 'lcov'],
            reportsDirectory: './coverage',
            // Most of these tests import 'jpipe-language', which resolves through the package's
            // `exports` map to the *built* `out/index.js` — deliberately, so the suite exercises
            // the package the way a consumer does. v8 therefore instruments JavaScript, and the
            // lcov below is produced by remapping it through the source maps `tsc` emits.
            //
            // Do NOT add `include: ['src/**/*.ts']` here. It reads as the obvious way to state
            // the report in source terms, and it silently breaks that remapping: the filter is
            // applied to the *executed* path, so every `out/*.js` file is dropped before it can
            // be mapped back to `src/`. The result still looks plausible — a report containing
            // only the three modules some tests import from `../src/` directly, and a coverage
            // figure around 6% instead of 86%.
            //
            // Nothing is lost by omitting it: `src/index.ts` re-exports the whole package, so
            // every module is loaded and every one appears in the report.
            //
            // These globs match against absolute paths, so they must not be anchored at the
            // package root — `src/generated/**` does not match, `**/generated/**` does.
            exclude: [
                // Emitted by langium-cli from jpipe.langium, git-ignored, never hand-edited.
                // See jpipe-vscode ADR-VSC-0006.
                '**/generated/**',
                // Test helpers are not the code under test.
                '**/test/**'
            ]
        }
    }
});
