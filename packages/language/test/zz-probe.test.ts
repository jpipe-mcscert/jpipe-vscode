import { describe, expect, test } from 'vitest';
import { JPIPE_OPERATORS, renderInvocation } from 'jpipe-language';
describe('probe', () => {
    test('shapes as the provider renders them', () => {
        for (const spec of JPIPE_OPERATORS) {
            const snippet = renderInvocation(spec, '', (i, text) => text ? `\${${i}:${text}}` : `\${${i}}`);
            const preview = renderInvocation(spec, '', (_i, text) => text);
            console.log(`\n=== ${spec.name} ===\n[snippet]\n${snippet}\n[preview]\n${preview}`);
        }
        expect(true).toBe(true);
    });
});
