import * as vscode from 'vscode';
import { messageOf } from '../../shared/errors.js';
import { joinUri } from '../models-view/new-model.js';
import type { Model } from '../models-view/models-tree.js';
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
    await createLibrary(libraries, model, 'New Step Library', () => librarySkeleton(model?.name));
}

/**
 * Scaffold Step Library…, from a justification's row in Models: the compiler writes a stub for
 * every element (`jpipe -f python`, the same call as Download as Python), and the stubs become a
 * new library, created as New Library… creates one.
 *
 * The model is compiled before anything is asked, so a model that does not compile says so at
 * once rather than after a name has been typed for nothing.
 */
export async function scaffoldLibrary(
    libraries: LibrariesView,
    model: Model,
    compile: (document: vscode.TextDocument) => Promise<string>
): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(model.uri));
    if (document.isDirty) await document.save();
    let code: string;
    try {
        code = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Generating steps for ${model.name}…` },
            () => compile(document));
    } catch (err: unknown) {
        void vscode.window.showErrorMessage(`Could not generate steps for ${model.name}: ${messageOf(err)}`);
        return;
    }
    await createLibrary(libraries, model, `Scaffold Step Library for ${model.name}`, () => code);
}

async function createLibrary(
    libraries: LibrariesView,
    model: Model | undefined,
    title: string,
    contents: () => string
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
        input.prompt = `Creates ${vscode.workspace.asRelativePath(vscode.Uri.parse(file))}`;
        let error = moduleNameError(input.value);
        if (!error && await exists(file)) {
            error = `${vscode.workspace.asRelativePath(vscode.Uri.parse(file))} already exists. Choose another name.`;
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
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: false, contents: new TextEncoder().encode(contents()) });
    if (!await vscode.workspace.applyEdit(edit)) {
        void vscode.window.showErrorMessage(`Could not create ${vscode.workspace.asRelativePath(uri)}.`);
        return;
    }
    await libraries.add(uri);
    const editor = await vscode.window.showTextDocument(uri, { preview: false });
    const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(end, end);
}

async function exists(uri: string): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(vscode.Uri.parse(uri));
        return true;
    } catch {
        return false;
    }
}
