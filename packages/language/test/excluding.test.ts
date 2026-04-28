import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import type { Unit } from 'jpipe-language';
import { createJpipeServices } from 'jpipe-language';

const EXCLUDED_DIR = 'file:///workspace/excluded';
const EXCLUDED_FILE = `${EXCLUDED_DIR}/test.jd`;
const NORMAL_FILE = 'file:///workspace/normal/test.jd';

const VALID_JUSTIFICATION = `
    justification J {
        conclusion c is "Claim"
        strategy s is "Strategy"
        evidence e is "Evidence"
        e supports s
        s supports c
    }
`;

const INVALID_JUSTIFICATION = `
    justification J {
        conclusion c is "Claim"
        evidence e is "Evidence"
        e supports c
    }
`;

describe('Excluded directory validation', () => {
    const savedEnv = process.env.JPIPE_EXCLUDED_DIRS;

    beforeEach(() => {
        process.env.JPIPE_EXCLUDED_DIRS = JSON.stringify([EXCLUDED_DIR]);
    });

    afterEach(() => {
        if (savedEnv === undefined) delete process.env.JPIPE_EXCLUDED_DIRS;
        else process.env.JPIPE_EXCLUDED_DIRS = savedEnv;
    });

    test('file in excluded directory shows only exclusion warning', async () => {
        const services = createJpipeServices(EmptyFileSystem);
        const parse = parseHelper<Unit>(services.Jpipe);
        const doc = await parse(INVALID_JUSTIFICATION, { documentUri: EXCLUDED_FILE, validation: true });

        expect(doc.diagnostics).toHaveLength(1);
        expect(doc.diagnostics![0].severity).toBe(DiagnosticSeverity.Warning);
        expect(doc.diagnostics![0].message).toContain('excluded directory');
    });

    test('file in excluded directory suppresses normal validation errors', async () => {
        const services = createJpipeServices(EmptyFileSystem);
        const parse = parseHelper<Unit>(services.Jpipe);
        const doc = await parse(INVALID_JUSTIFICATION, { documentUri: EXCLUDED_FILE, validation: true });

        const errors = (doc.diagnostics ?? []).filter(d => d.severity === DiagnosticSeverity.Error);
        expect(errors).toHaveLength(0);
    });

    test('file outside excluded directory validates normally', async () => {
        const services = createJpipeServices(EmptyFileSystem);
        const parse = parseHelper<Unit>(services.Jpipe);
        const doc = await parse(INVALID_JUSTIFICATION, { documentUri: NORMAL_FILE, validation: true });

        const messages = (doc.diagnostics ?? []).map(d => d.message);
        expect(messages.some(m => m.includes('excluded'))).toBe(false);
        expect(messages.some(m => m.includes('strategy'))).toBe(true);
    });

    test('valid file in excluded directory shows only exclusion warning, not other warnings', async () => {
        const services = createJpipeServices(EmptyFileSystem);
        const parse = parseHelper<Unit>(services.Jpipe);
        const doc = await parse(VALID_JUSTIFICATION, { documentUri: EXCLUDED_FILE, validation: true });

        expect(doc.diagnostics).toHaveLength(1);
        expect(doc.diagnostics![0].message).toContain('excluded directory');
    });

    test('malformed JPIPE_EXCLUDED_DIRS falls back to no exclusions', async () => {
        process.env.JPIPE_EXCLUDED_DIRS = 'not-valid-json';
        const services = createJpipeServices(EmptyFileSystem);
        const parse = parseHelper<Unit>(services.Jpipe);
        const doc = await parse(INVALID_JUSTIFICATION, { documentUri: EXCLUDED_FILE, validation: true });

        const messages = (doc.diagnostics ?? []).map(d => d.message);
        expect(messages.some(m => m.includes('excluded'))).toBe(false);
    });

    test('non-array JPIPE_EXCLUDED_DIRS falls back to no exclusions', async () => {
        process.env.JPIPE_EXCLUDED_DIRS = '"just-a-string"';
        const services = createJpipeServices(EmptyFileSystem);
        const parse = parseHelper<Unit>(services.Jpipe);
        const doc = await parse(INVALID_JUSTIFICATION, { documentUri: EXCLUDED_FILE, validation: true });

        const messages = (doc.diagnostics ?? []).map(d => d.message);
        expect(messages.some(m => m.includes('excluded'))).toBe(false);
    });
});
