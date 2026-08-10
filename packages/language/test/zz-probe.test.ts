import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { URI, type LangiumDocument } from 'langium';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CodeAction } from 'vscode-languageserver';
import { Diagnostic } from 'vscode-languageserver-types';
import { createJpipeServices, type Unit } from 'jpipe-language';

describe('probe', () => {
    test('namespaced reference', async () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-ns-'));
        fs.mkdirSync(path.join(ws, 'lib'), { recursive: true });
        fs.writeFileSync(path.join(ws, 'lib', 'alpha.jd'),
            'template alpha {\n    @support a is "A"\n    conclusion c is "C"\n    strategy s is "S"\n    a supports s\n    s supports c\n}');
        fs.writeFileSync(path.join(ws, 'main.jd'),
            'justification j implements lib:alpha {\n    evidence lib:alpha:a is "E"\n}');

        const s = createJpipeServices(NodeFileSystem);
        const docs = await Promise.all(['lib/alpha.jd', 'main.jd'].map(async r =>
            await s.shared.workspace.LangiumDocuments.getOrCreateDocument(
                URI.parse(pathToFileURL(path.join(ws, r)).toString())) as LangiumDocument<Unit>));
        await s.shared.workspace.DocumentBuilder.build(docs, { validation: true });
        const main = docs[1];
        const uri = main.uri.toString();

        const acts = ((await s.Jpipe.lsp.CodeActionProvider!.getCodeActions(main, {
            textDocument: { uri },
            range: { start: main.textDocument.positionAt(0), end: main.textDocument.positionAt(main.textDocument.getText().length) },
            context: { diagnostics: main.diagnostics ?? [] }
        })) ?? []).filter((a): a is CodeAction => 'title' in a);

        console.log('\n--- actions ---');
        acts.forEach(a => console.log(`  ${a.title}`));
        const load = acts.find(a => a.title.startsWith('Load'));
        if (load) {
            const after = TextDocument.applyEdits(main.textDocument, load.edit!.changes![uri]);
            console.log(`--- applied ---\n${after}`);
            fs.writeFileSync(path.join(ws, 'main.jd'), after);
            const s2 = createJpipeServices(NodeFileSystem);
            const d2 = await s2.shared.workspace.LangiumDocuments.getOrCreateDocument(
                URI.parse(pathToFileURL(path.join(ws, 'main.jd')).toString()));
            await s2.shared.workspace.DocumentBuilder.build([d2], { validation: true });
            console.log('--- diagnostics after ---');
            (d2.diagnostics ?? []).forEach(x => console.log(`  ${Diagnostic.getMessageString(x)}`));
        }
        fs.rmSync(ws, { recursive: true, force: true });
        expect(true).toBe(true);
    });
});
