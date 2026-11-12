import * as vscode from 'vscode';
import { JpipeIssue } from 'jpipe-language';
import type { Model } from './models-tree.js';
import {
    appendSeparator,
    chooseFolder,
    fileNameFor,
    joinUri,
    loadInsertionLine,
    loadLine,
    loadsFile,
    modelSnippet,
    nameError,
    nameWarning,
    relativeLoadPath,
    type NewModelKind
} from './new-model.js';

/**
 * The editor half of New Justification…, New Template… and New Justification Implementing….
 *
 * One input box, for the name. Everything else is worked out by `new-model.ts` and shown in the
 * box's prompt, where it can be changed with the box's two buttons rather than being asked about:
 * a different folder, or an existing file to add the model to instead of a new one.
 */

export interface NewModelRequest {
    kind: NewModelKind;
    /** The template a new justification implements. */
    template?: Model;
    /** A model the command was invoked on or that is selected, to place the new one beside. */
    contextUri?: string;
}

type Target = { mode: 'new'; folder: string } | { mode: 'existing'; file: string };

/** How long to wait for the server to say which `@support`s an implementation must override. */
const OVERRIDES_TIMEOUT_MS = 5000;

const CHANGE_FOLDER: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('folder-opened'),
    tooltip: 'Change Folder…'
};
const EXISTING_FILE: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('go-to-file'),
    tooltip: 'Add to an Existing File…'
};
const NEW_FILE: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('new-file'),
    tooltip: 'Create a New File Instead'
};

export async function newModel(models: readonly Model[], request: NewModelRequest): Promise<void> {
    const active = vscode.window.activeTextEditor?.document;
    const folder = chooseFolder({
        contextUri: request.contextUri,
        activeUri: active?.languageId === 'jpipe' ? active.uri.toString() : undefined,
        modelUris: models.map(m => m.uri),
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.toString())
    });
    if (!folder) {
        void vscode.window.showErrorMessage('Open a folder to create a jPipe model in.');
        return;
    }

    const answer = await askName(models, request, { mode: 'new', folder });
    if (!answer) return;
    const { name, target } = answer;
    const template = request.template;

    const editor = target.mode === 'new'
        ? await writeNewFile(joinUri(target.folder, fileNameFor(name)), request.kind, name, template)
        : await appendToFile(target.file, request.kind, name, template);
    if (editor && template) await overrideSupports(editor, name);
}

/** Ask for the name, with the target shown and changeable. `undefined` if dismissed. */
function askName(
    models: readonly Model[],
    request: NewModelRequest,
    initial: Target
): Promise<{ name: string; target: Target } | undefined> {
    const input = vscode.window.createInputBox();
    const kindLabel = request.kind === 'template' ? 'Template' : 'Justification';
    input.title = request.template
        ? `New Justification Implementing ${request.template.name}`
        : `New ${kindLabel}`;
    input.placeholder = request.kind === 'template' ? 'Template name, e.g. Signoff' : 'Justification name, e.g. ReleaseSignoff';
    input.ignoreFocusOut = true;

    let target = initial;
    /** Set while a button's own picker has the screen, so the box hiding is not a cancel. */
    let switching = false;
    /** Ignores answers to a validation that has since been overtaken by typing. */
    let generation = 0;
    let blocked = true;

    const relative = (uri: string) => vscode.workspace.asRelativePath(vscode.Uri.parse(uri));

    const refresh = async (): Promise<void> => {
        const mine = ++generation;
        const name = input.value.trim();
        input.buttons = target.mode === 'new' ? [CHANGE_FOLDER, EXISTING_FILE] : [NEW_FILE, EXISTING_FILE];
        const file = target.mode === 'new' ? joinUri(target.folder, fileNameFor(name || 'name')) : target.file;
        input.prompt = target.mode === 'new'
            ? `Creates ${relative(file)}`
            : `Adds to ${relative(file)}`;

        const inTarget = models.filter(m => m.uri === file).map(m => m.name);
        const elsewhere = models.filter(m => m.uri !== file).map(m => m.name);
        let error = nameError(name, inTarget);
        if (!error && target.mode === 'new' && await exists(file)) {
            error = `${relative(file)} already exists. Choose another name, or add to it with the file button.`;
        }
        if (mine !== generation) return;
        blocked = error !== undefined;
        const warning = error ? undefined : nameWarning(name, elsewhere);
        input.validationMessage = error && name.length > 0
            ? { message: error, severity: vscode.InputBoxValidationSeverity.Error }
            : warning ? { message: warning, severity: vscode.InputBoxValidationSeverity.Warning } : undefined;
    };

    return new Promise(resolve => {
        const done = (result: { name: string; target: Target } | undefined) => {
            disposables.forEach(d => d.dispose());
            input.dispose();
            resolve(result);
        };
        const disposables = [
            input.onDidChangeValue(() => void refresh()),
            input.onDidAccept(async () => {
                await refresh();
                if (!blocked) done({ name: input.value.trim(), target });
            }),
            input.onDidHide(() => { if (!switching) done(undefined); }),
            input.onDidTriggerButton(async button => {
                switching = true;
                const next = await pickTarget(button, target);
                switching = false;
                if (next) target = next;
                input.show();
                await refresh();
            })
        ];
        input.show();
        void refresh();
    });
}

/** The target a box button leads to, or `undefined` if its picker was dismissed. */
async function pickTarget(button: vscode.QuickInputButton, current: Target): Promise<Target | undefined> {
    if (button === NEW_FILE) {
        return { mode: 'new', folder: current.mode === 'existing' ? current.file.slice(0, current.file.lastIndexOf('/')) : current.folder };
    }
    if (button === CHANGE_FOLDER) {
        const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            defaultUri: current.mode === 'new' ? vscode.Uri.parse(current.folder) : undefined,
            openLabel: 'Create Here'
        });
        return picked?.[0] ? { mode: 'new', folder: picked[0].toString() } : undefined;
    }
    const files = await vscode.workspace.findFiles('**/*.jd', '**/{node_modules,out,.git}/**');
    const items = files
        .map(uri => ({ label: vscode.workspace.asRelativePath(uri), uri }))
        .sort((a, b) => a.label.localeCompare(b.label));
    const picked = await vscode.window.showQuickPick(items, {
        title: 'Add the Model to an Existing File',
        placeHolder: 'Choose a .jd file'
    });
    return picked ? { mode: 'existing', file: picked.uri.toString() } : undefined;
}

async function exists(uri: string): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(vscode.Uri.parse(uri));
        return true;
    } catch {
        return false;
    }
}

/** Create the file, open it, and write the model into it. */
async function writeNewFile(
    uri: string,
    kind: NewModelKind,
    name: string,
    template: Model | undefined
): Promise<vscode.TextEditor | undefined> {
    const fileUri = vscode.Uri.parse(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(fileUri, { overwrite: false, ignoreIfExists: false });
    if (!await vscode.workspace.applyEdit(edit)) {
        void vscode.window.showErrorMessage(`Could not create ${vscode.workspace.asRelativePath(fileUri)}.`);
        return undefined;
    }
    const editor = await vscode.window.showTextDocument(fileUri, { preview: false });
    if (template) {
        const text = `${loadLine(relativeLoadPath(uri, template.uri))}\n\n${modelSnippet(kind, name, template)}`;
        await editor.edit(builder => builder.insert(new vscode.Position(0, 0), text));
    } else {
        await editor.insertSnippet(new vscode.SnippetString(modelSnippet(kind, name)), new vscode.Position(0, 0));
    }
    return editor;
}

/** Open an existing file and append the model, adding the template's `load` if it is missing. */
async function appendToFile(
    uri: string,
    kind: NewModelKind,
    name: string,
    template: Model | undefined
): Promise<vscode.TextEditor> {
    const editor = await vscode.window.showTextDocument(vscode.Uri.parse(uri), { preview: false });
    const document = editor.document;
    if (template && !loadsFile(document.getText(), uri, template.uri)) {
        const line = loadInsertionLine(document.getText());
        // A first `load` gets a blank line between it and the models below.
        const trailer = line === 0 && document.getText().trim().length > 0 ? '\n\n' : '\n';
        await editor.edit(builder => builder.insert(
            new vscode.Position(line, 0),
            loadLine(relativeLoadPath(uri, template.uri)) + trailer));
    }
    const end = document.lineAt(document.lineCount - 1).range.end;
    const separator = appendSeparator(document.getText());
    if (template) {
        await editor.edit(builder => builder.insert(end, separator + modelSnippet(kind, name, template)));
    } else {
        await editor.insertSnippet(new vscode.SnippetString(separator + modelSnippet(kind, name)), end);
    }
    return editor;
}

/**
 * Fill a new implementation with the overrides its template demands, using the server's own fix.
 *
 * The body was written empty; the server answers with a `no-abstract-support` diagnostic per
 * `@support` left to override, and its preferred quick fix for them writes them all. If none
 * arrives — the template has no `@support`, or the file is excluded from validation — the body
 * stays empty, and the parser's "a model cannot be empty" says what to do next.
 */
async function overrideSupports(editor: vscode.TextEditor, name: string): Promise<void> {
    const uri = editor.document.uri;
    const header = editor.document.getText().indexOf(`justification ${name} implements`);
    if (header < 0) return;
    const modelLine = editor.document.positionAt(header).line;

    const missing = await waitFor(() => vscode.languages.getDiagnostics(uri).find(d =>
        codeOf(d) === JpipeIssue.NoAbstractSupport && d.range.start.line >= modelLine));
    if (!missing) return;

    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider', uri, missing.range, vscode.CodeActionKind.QuickFix.value);
    const fix = actions?.find(a => a.isPreferred && a.edit);
    if (fix?.edit) await vscode.workspace.applyEdit(fix.edit);
}

function codeOf(diagnostic: vscode.Diagnostic): string | number | undefined {
    const code = diagnostic.code;
    return typeof code === 'object' ? code.value : code;
}

/** Resolve with `probe()`'s first defined answer, re-checked on each diagnostics change. */
function waitFor<T>(probe: () => T | undefined): Promise<T | undefined> {
    const now = probe();
    if (now !== undefined) return Promise.resolve(now);
    return new Promise(resolve => {
        const finish = (value: T | undefined) => {
            clearTimeout(timer);
            subscription.dispose();
            resolve(value);
        };
        const timer = setTimeout(() => finish(undefined), OVERRIDES_TIMEOUT_MS);
        const subscription = vscode.languages.onDidChangeDiagnostics(() => {
            const found = probe();
            if (found !== undefined) finish(found);
        });
    });
}
