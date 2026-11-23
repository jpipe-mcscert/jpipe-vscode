import * as vscode from 'vscode';
import { JpipeIssue } from 'jpipe-language';
import type { Model } from './models-tree.js';
import { templateReach } from './elements-tree.js';
import {
    appendSeparator,
    chooseFolder,
    dirnameOf,
    fileNameFor,
    joinUri,
    loadsFile,
    modelSnippet,
    nameError,
    nameWarning,
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

/** The box button that changes the folder a new file goes in. Shared with New Library…. */
export const CHANGE_FOLDER: vscode.QuickInputButton = {
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

    const written = target.mode === 'new'
        ? { editor: await writeNewFile(joinUri(target.folder, fileNameFor(name)), request.kind, name, template), reached: false }
        : await appendToFile(target.file, request.kind, name, template);
    if (!written.editor || !template) return;
    // A file that reaches the template already has no error to wait for.
    if (!written.reached) await loadTemplate(written.editor, name, template);
    await overrideSupports(written.editor, name);
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

    const relative = (uri: string) => vscode.workspace.asRelativePath(vscode.Uri.parse(uri));

    const validate = async (): Promise<Validation> => {
        const name = input.value.trim();
        input.buttons = target.mode === 'new' ? [CHANGE_FOLDER, EXISTING_FILE] : [NEW_FILE, EXISTING_FILE];
        const file = target.mode === 'new' ? joinUri(target.folder, fileNameFor(name || 'name')) : target.file;
        input.prompt = target.mode === 'new'
            ? `Creates ${relative(file)}`
            : `Adds to ${relative(file)}`;

        const inTarget = models.filter(m => m.uri === file).map(m => m.name);
        const elsewhere = models.filter(m => m.uri !== file).map(m => m.name);
        let error = nameError(name, inTarget);
        if (!error && target.mode === 'new' && await fileExists(file)) {
            error = `${relative(file)} already exists. Choose another name, or add to it with the file button.`;
        }
        return { blocked: error !== undefined, message: validationOf(name, error, elsewhere) };
    };

    return askValidated(
        input,
        validate,
        async button => {
            const next = await pickTarget(button, target);
            if (next) target = next;
        },
        () => ({ name: input.value.trim(), target }));
}

/** What a box's value was found to be: whether it can be accepted, and what is said under it. */
export interface Validation {
    blocked: boolean;
    message: vscode.InputBoxValidationMessage | undefined;
}

/**
 * Show `input` until a value `validate` lets through is accepted, and give what `accepted` makes
 * of it; `undefined` if the box is dismissed. Shared with New Library…, which asks the same way.
 *
 * `validate` runs on every keystroke and may take a moment, looking for a file: an answer
 * overtaken by typing is ignored. A button runs `onButton`, whose picker hides the box without
 * that being a cancel; the box is then shown again and validated afresh.
 */
export function askValidated<T>(
    input: vscode.InputBox,
    validate: () => Promise<Validation>,
    onButton: (button: vscode.QuickInputButton) => Promise<void>,
    accepted: () => T
): Promise<T | undefined> {
    /** Set while a button's own picker has the screen, so the box hiding is not a cancel. */
    let switching = false;
    /** Ignores answers to a validation that has since been overtaken by typing. */
    let generation = 0;
    let blocked = true;

    const refresh = async (): Promise<void> => {
        const mine = ++generation;
        const validation = await validate();
        if (mine !== generation) return;
        blocked = validation.blocked;
        input.validationMessage = validation.message;
    };

    return new Promise(resolve => {
        const done = (result: T | undefined) => {
            disposables.forEach(d => d.dispose());
            input.dispose();
            resolve(result);
        };
        const disposables = [
            input.onDidChangeValue(() => void refresh()),
            input.onDidAccept(async () => {
                await refresh();
                if (!blocked) done(accepted());
            }),
            input.onDidHide(() => { if (!switching) done(undefined); }),
            input.onDidTriggerButton(async button => {
                switching = true;
                await onButton(button);
                switching = false;
                input.show();
                await refresh();
            })
        ];
        input.show();
        void refresh();
    });
}

/** What the box says under the name: the error blocking it, else a warning, else nothing. */
function validationOf(
    name: string,
    error: string | undefined,
    namesElsewhere: readonly string[]
): vscode.InputBoxValidationMessage | undefined {
    if (error) {
        return name.length > 0 ? { message: error, severity: vscode.InputBoxValidationSeverity.Error } : undefined;
    }
    const warning = nameWarning(name, namesElsewhere);
    return warning ? { message: warning, severity: vscode.InputBoxValidationSeverity.Warning } : undefined;
}

/** The target a box button leads to, or `undefined` if its picker was dismissed. */
async function pickTarget(button: vscode.QuickInputButton, current: Target): Promise<Target | undefined> {
    if (button === NEW_FILE) {
        return { mode: 'new', folder: current.mode === 'existing' ? dirnameOf(current.file) : current.folder };
    }
    if (button === CHANGE_FOLDER) {
        const folder = await pickFolder(current.mode === 'new' ? current.folder : undefined);
        return folder ? { mode: 'new', folder } : undefined;
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

/**
 * The folder picked to create a file in, starting from `current`; `undefined` if the dialog was
 * dismissed. What `CHANGE_FOLDER` opens, here and in New Library….
 */
export async function pickFolder(current: string | undefined): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        defaultUri: current === undefined ? undefined : vscode.Uri.parse(current),
        openLabel: 'Create Here'
    });
    return picked?.[0]?.toString();
}

/** Whether something is at `uri`. Shared with New Library…, which asks the same question. */
export async function fileExists(uri: string): Promise<boolean> {
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
        await editor.edit(builder => builder.insert(new vscode.Position(0, 0), modelSnippet(kind, name, template)));
    } else {
        await editor.insertSnippet(new vscode.SnippetString(modelSnippet(kind, name)), new vscode.Position(0, 0));
    }
    return editor;
}

/**
 * Open an existing file and append the model. A template the file already reaches is implemented
 * under the name it reaches it by, `lib:Signoff` through a `load … as lib`; one it does not is
 * loaded afterwards, by `loadTemplate`.
 */
async function appendToFile(
    uri: string,
    kind: NewModelKind,
    name: string,
    template: Model | undefined
): Promise<{ editor: vscode.TextEditor; reached: boolean }> {
    const editor = await vscode.window.showTextDocument(vscode.Uri.parse(uri), { preview: false });
    const document = editor.document;
    const end = document.lineAt(document.lineCount - 1).range.end;
    const separator = appendSeparator(document.getText());
    if (!template) {
        await editor.insertSnippet(new vscode.SnippetString(separator + modelSnippet(kind, name)), end);
        return { editor, reached: false };
    }
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
        'vscode.executeDocumentSymbolProvider', document.uri);
    const reach = templateReach(symbols ?? [], template.name);
    await editor.edit(builder => builder.insert(end, separator + modelSnippet(kind, name, template, reach?.alias)));
    return { editor, reached: reach !== undefined };
}

/**
 * Load the template a new implementation names, if its file does not yet, with the server's own
 * "add missing load" fix (#121): the one the author would pick from the lightbulb, so the `load`
 * is written as every other is, `load "./lib/signoff.jd"`, where the server puts loads.
 *
 * The model was written naming its template; if the file does not reach it, the server answers
 * with an unresolved reference there, and offers a `load` for each file declaring a template of
 * that name. The one whose path names the template's file is applied. If no diagnostic arrives,
 * the template resolved, and there is nothing to load.
 */
async function loadTemplate(editor: vscode.TextEditor, name: string, template: Model): Promise<void> {
    const document = editor.document;
    const header = new RegExp(`justification\\s+${name}\\s+implements\\s+`).exec(document.getText());
    if (!header) return;
    const start = document.positionAt(header.index + header[0].length);
    const reference = document.getWordRangeAtPosition(start, /[\w:]+/) ?? new vscode.Range(start, start);

    const unresolved = await waitFor(() => vscode.languages.getDiagnostics(document.uri)
        .find(d => d.severity === vscode.DiagnosticSeverity.Error && d.range.intersection(reference) !== undefined));
    if (!unresolved) return;

    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider', document.uri, reference, vscode.CodeActionKind.QuickFix.value);
    const load = actions?.find(action => action.edit?.get(document.uri)
        .some(edit => loadsFile(edit.newText, document.uri.toString(), template.uri)));
    if (load?.edit) await vscode.workspace.applyEdit(load.edit);
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
