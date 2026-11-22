import * as vscode from 'vscode';
import { messageOf } from '../../shared/errors.js';
import { CompilerTooOldError } from '../requirements.js';
import { joinUri } from '../models-view/new-model.js';
import type { Model } from '../models-view/models-tree.js';
import { fileExists } from '../models-view/new-model-flow.js';
import type { ModelsView } from '../models-view/models-view.js';
import type { LibrariesView } from './libraries-view.js';
import { defaultLibraryName, libraryFileName, libraryFolder, librarySkeleton, moduleNameError } from './new-library.js';

/**
 * New Library…, from the Libraries view: a blank library, named after the model in question.
 *
 * One input box for the module name, the target folder in its prompt and changeable with its
 * button, then the file is created, opened and checked — it was created to be used, and an
 * unchecked library is one the next run would quietly leave out.
 */
export async function newLibrary(libraries: LibrariesView, models: ModelsView): Promise<void> {
    const current = models.currentModel;
    // A composition has no elements of its own to write steps for.
    const model = current?.operator ? undefined : current;
    await createLibrary(libraries, model, 'New Step Library', async uri => {
        const edit = new vscode.WorkspaceEdit();
        edit.createFile(uri, { overwrite: false, contents: new TextEncoder().encode(librarySkeleton(model?.name)) });
        if (await vscode.workspace.applyEdit(edit)) return true;
        void vscode.window.showErrorMessage(`Could not create ${vscode.workspace.asRelativePath(uri)}.`);
        return false;
    });
}

/**
 * Scaffold Step Library…, from a justification's row in Models: once the name and folder are
 * chosen, the compiler writes the library there itself — `jpipe process -f PYTHON -o <file>`, a
 * stub for every element — and it is listed, checked and opened as New Library… does.
 */
export async function scaffoldLibrary(
    libraries: LibrariesView,
    model: Model,
    compileTo: (document: vscode.TextDocument, file: vscode.Uri) => Promise<unknown>
): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(model.uri));
    // The compiler reads files, not editors: stubs from what was saved last would miss the
    // elements added since, in the justification or in a template it loads. So every jPipe file
    // with unsaved changes is saved first, as a run does.
    const unsaved = [document, ...vscode.workspace.textDocuments.filter(open => open.languageId === 'jpipe' && open !== document)]
        .filter(input => input.isDirty);
    const saved = await Promise.all(unsaved.map(input => input.save()));
    const failed = unsaved.find((_, i) => !saved[i]);
    if (failed) {
        void vscode.window.showErrorMessage(
            `No library was generated: ${vscode.workspace.asRelativePath(failed.uri)} could not be saved, and the compiler reads the files as they are saved.`);
        return;
    }
    await createLibrary(libraries, model, `Scaffold Step Library for ${model.name}`, async uri => {
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: `Generating steps for ${model.name}…` },
                () => compileTo(document, uri));
            return true;
        } catch (err: unknown) {
            // A compiler too old has said so already, with its update button.
            if (!(err instanceof CompilerTooOldError)) {
                void vscode.window.showErrorMessage(`Could not generate steps for ${model.name}: ${messageOf(err)}`);
            }
            return false;
        }
    });
}

async function createLibrary(
    libraries: LibrariesView,
    model: Model | undefined,
    title: string,
    write: (file: vscode.Uri) => Promise<boolean>
): Promise<void> {
    let folder = libraryFolder(
        libraries.allLibraries().map(l => l.uri.toString()),
        model?.uri,
        (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.toString()));
    if (!folder) {
        void vscode.window.showErrorMessage('Open a folder to create a step library in.');
        return;
    }

    const changeFolder: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('folder-opened'), tooltip: 'Change Folder…' };
    const input = vscode.window.createInputBox();
    input.title = title;
    input.placeholder = 'Python module name, e.g. release_steps';
    input.value = defaultLibraryName(model?.name);
    input.valueSelection = [0, input.value.length];
    input.buttons = [changeFolder];
    input.ignoreFocusOut = true;

    const target = () => joinUri(folder!, libraryFileName(input.value || 'name'));
    let generation = 0;
    let blocked = true;
    const refresh = async () => {
        const mine = ++generation;
        const file = target();
        const relative = vscode.workspace.asRelativePath(vscode.Uri.parse(file));
        input.prompt = `Creates ${relative}`;
        let error = moduleNameError(input.value);
        // A library is checked for runs by its place in the workspace: outside every folder of
        // it, it could be created but never checked, and runs would leave it out.
        if (!error && !vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(folder!))) {
            error = `${vscode.Uri.parse(folder!).fsPath} is outside the workspace, where a library cannot be checked for runs. Choose a folder inside it.`;
        }
        if (!error && await fileExists(file)) {
            error = `${relative} already exists. Choose another name.`;
        }
        if (mine !== generation) return;
        blocked = error !== undefined;
        input.validationMessage = error && input.value.trim()
            ? { message: error, severity: vscode.InputBoxValidationSeverity.Error }
            : undefined;
    };

    const file = await new Promise<string | undefined>(resolve => {
        let switching = false;
        const done = (value: string | undefined) => {
            subscriptions.forEach(s => s.dispose());
            input.dispose();
            resolve(value);
        };
        const subscriptions = [
            input.onDidChangeValue(() => void refresh()),
            input.onDidAccept(async () => {
                await refresh();
                if (!blocked) done(target());
            }),
            input.onDidHide(() => { if (!switching) done(undefined); }),
            input.onDidTriggerButton(async () => {
                switching = true;
                const picked = await vscode.window.showOpenDialog({
                    canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
                    defaultUri: vscode.Uri.parse(folder!), openLabel: 'Create Here'
                });
                switching = false;
                if (picked?.[0]) folder = picked[0].toString();
                input.show();
                await refresh();
            })
        ];
        input.show();
        void refresh();
    });
    if (!file) return;

    const uri = vscode.Uri.parse(file);
    if (!await write(uri)) return;
    await libraries.add(uri);
    const editor = await vscode.window.showTextDocument(uri, { preview: false });
    const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(end, end);
}
