import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import type { Unit } from 'jpipe-language';
import { createJpipeServices } from 'jpipe-language';

const EXCLUDED_DIR = 'file:///workspace/excluded';
const EXCLUDED_FILE = `${EXCLUDED_DIR}/test.jd`;
const NESTED_EXCLUDED_FILE = `${EXCLUDED_DIR}/deep/nested/test.jd`;
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

    test('invalid file in excluded directory reports no diagnostics at all', async () => {
        const services = createJpipeServices(EmptyFileSystem);
        const parse = parseHelper<Unit>(services.Jpipe);
        const doc = await parse(INVALID_JUSTIFICATION, { documentUri: EXCLUDED_FILE, validation: true });

        expect(doc.diagnostics).toHaveLength(0);
    });

    test('valid file in excluded directory reports no diagnostics at all', async () => {
        const services = createJpipeServices(EmptyFileSystem);
        const parse = parseHelper<Unit>(services.Jpipe);
        const doc = await parse(VALID_JUSTIFICATION, { documentUri: EXCLUDED_FILE, validation: true });

        expect(doc.diagnostics).toHaveLength(0);
    });

    test('file in a subdirectory of an excluded directory is excluded too', async () => {
        const services = createJpipeServices(EmptyFileSystem);
        const parse = parseHelper<Unit>(services.Jpipe);
        const doc = await parse(INVALID_JUSTIFICATION, { documentUri: NESTED_EXCLUDED_FILE, validation: true });

        expect(doc.diagnostics).toHaveLength(0);
    });

    test('file outside excluded directory validates normally', async () => {
        const services = createJpipeServices(EmptyFileSystem);
        const parse = parseHelper<Unit>(services.Jpipe);
        const doc = await parse(INVALID_JUSTIFICATION, { documentUri: NORMAL_FILE, validation: true });

        const errors = (doc.diagnostics ?? []).filter(d => d.severity === DiagnosticSeverity.Error);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some(d => d.message.includes('strategy'))).toBe(true);
    });

    test('exclusions can be changed at runtime without recreating the services', async () => {
        delete process.env.JPIPE_EXCLUDED_DIRS;
        const services = createJpipeServices(EmptyFileSystem);
        const parse = parseHelper<Unit>(services.Jpipe);

        // A fresh URI per step: the test helper refuses to add the same document twice.
        const before = await parse(INVALID_JUSTIFICATION, { documentUri: `${EXCLUDED_DIR}/a.jd`, validation: true });
        expect((before.diagnostics ?? []).length).toBeGreaterThan(0);

        services.Jpipe.exclusions.setExcludedDirectories([EXCLUDED_DIR]);
        const excluded = await parse(INVALID_JUSTIFICATION, { documentUri: `${EXCLUDED_DIR}/b.jd`, validation: true });
        expect(excluded.diagnostics).toHaveLength(0);

        services.Jpipe.exclusions.setExcludedDirectories([]);
        const included = await parse(INVALID_JUSTIFICATION, { documentUri: `${EXCLUDED_DIR}/c.jd`, validation: true });
        expect((included.diagnostics ?? []).length).toBeGreaterThan(0);
    });

    test('invalid excluded-directory entries are skipped without disabling the others', async () => {
        const services = createJpipeServices(EmptyFileSystem);
        services.Jpipe.exclusions.setExcludedDirectories(['', EXCLUDED_DIR]);
        const parse = parseHelper<Unit>(services.Jpipe);

        const excluded = await parse(INVALID_JUSTIFICATION, { documentUri: EXCLUDED_FILE, validation: true });
        expect(excluded.diagnostics).toHaveLength(0);

        const normal = await parse(INVALID_JUSTIFICATION, { documentUri: NORMAL_FILE, validation: true });
        expect((normal.diagnostics ?? []).length).toBeGreaterThan(0);
    });

    test('malformed JPIPE_EXCLUDED_DIRS falls back to no exclusions', async () => {
        process.env.JPIPE_EXCLUDED_DIRS = 'not-valid-json';
        const services = createJpipeServices(EmptyFileSystem);
        const parse = parseHelper<Unit>(services.Jpipe);
        const doc = await parse(INVALID_JUSTIFICATION, { documentUri: EXCLUDED_FILE, validation: true });

        expect((doc.diagnostics ?? []).length).toBeGreaterThan(0);
    });

    test('non-array JPIPE_EXCLUDED_DIRS falls back to no exclusions', async () => {
        process.env.JPIPE_EXCLUDED_DIRS = '"just-a-string"';
        const services = createJpipeServices(EmptyFileSystem);
        const parse = parseHelper<Unit>(services.Jpipe);
        const doc = await parse(INVALID_JUSTIFICATION, { documentUri: EXCLUDED_FILE, validation: true });

        expect((doc.diagnostics ?? []).length).toBeGreaterThan(0);
    });
});
