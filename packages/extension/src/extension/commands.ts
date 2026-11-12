import * as vscode from 'vscode';
import {
    ORGANIZE_LOADS_KIND,
    CONVERT_MODEL_KIND,
    SORT_ELEMENTS_KIND,
    EXTRACT_TEMPLATE_KIND
} from 'jpipe-language';
import type { JpipeLogger } from './logger.js';
import type { ExclusionManager } from './exclusions.js';
import { ImageGenerator, ImageFormat } from './compiler/image-generator.js';
import type { ReleaseManager } from './compiler/release-manager.js';
import type { PreviewProvider } from './preview/preview-provider.js';
import type { ModelsView } from './models-view/models-view.js';
import type { Model, ModelNode, TreeNode } from './models-view/models-tree.js';
import { newModel } from './models-view/new-model-flow.js';
import type { LibrariesView } from './runner/libraries-view.js';
import { runModel } from './runner/run-model.js';
import { newLibrary, scaffoldLibrary } from './runner/new-library-flow.js';
import type { RunnerEnvironment } from './runner/environment.js';
import { installFromRelease } from './compiler/managed-install.js';
import { selectJarFile } from './compiler/jar-selection.js';
import { accessMethodHeader } from './compiler/release-presentation.js';
import {
    addExcludedDirectory,
    excludeResource,
    includeResource,
    removeExcludedPath
} from './exclusion-commands.js';

/**
 * Every command the extension contributes.
 *
 * Split out of `activate()`, which had grown to 264 lines and was doing three jobs at once:
 * constructing collaborators, wiring events, and this. Registration is the bulk of it and the
 * part that grows with every feature, so it is the part that moves.
 *
 * The handlers here stay thin on purpose. Anything with a decision in it belongs in the module
 * that owns the concern — `exclusion-commands.ts`, `managed-install.ts` — so that this file can
 * be read as a table of what the extension offers.
 */

/** The collaborators the commands act on. */
export interface CommandDeps {
    context: vscode.ExtensionContext;
    logger: JpipeLogger;
    exclusions: ExclusionManager;
    imageGenerator: ImageGenerator;
    previewProvider: PreviewProvider;
    releaseManager: ReleaseManager;
    modelsView: ModelsView;
    librariesView: LibrariesView;
    runnerEnvironment: RunnerEnvironment;
}

/**
 * Export formats reachable by their own command.
 *
 * Written out rather than derived as `jpipe.download${format}`, because the ids and the enum do
 * not agree: `ImageFormat.PYTHON` is `'PYTHON'` while the contributed command is
 * `jpipe.downloadPython`. A template would have registered a handler for a command nothing
 * declares, and left the declared one with nothing behind it — a menu entry that does nothing,
 * which neither the compiler nor the test suite can see. `test/commands.test.ts` checks these
 * against package.json.
 */
const EXPORT_COMMANDS: ReadonlyArray<readonly [command: string, format: ImageFormat]> = [
    ['jpipe.downloadPNG', ImageFormat.PNG],
    ['jpipe.downloadSVG', ImageFormat.SVG],
    ['jpipe.downloadJSON', ImageFormat.JSON],
    ['jpipe.downloadJPEG', ImageFormat.JPEG],
    ['jpipe.downloadDOT', ImageFormat.DOT],
    ['jpipe.downloadPython', ImageFormat.PYTHON],
    ['jpipe.downloadJPIPE', ImageFormat.JPIPE]
];

/**
 * Commands that only ask the editor to run a code action of a given kind.
 *
 * These already appear in the lightbulb and under Source Action… or Refactor…, but both routes
 * ask the user to know they are there. A named command is the one answer to "what can jPipe do
 * here?" that needs no shortcut.
 */
const CODE_ACTION_COMMANDS: ReadonlyArray<readonly [command: string, kind: string, action: string]> = [
    ['jpipe.organizeLoads', ORGANIZE_LOADS_KIND, 'editor.action.sourceAction'],
    ['jpipe.convertModelKind', CONVERT_MODEL_KIND, 'editor.action.refactor'],
    ['jpipe.sortElements', SORT_ELEMENTS_KIND, 'editor.action.refactor'],
    ['jpipe.extractTemplate', EXTRACT_TEMPLATE_KIND, 'editor.action.refactor']
];

export function registerCommands(deps: CommandDeps): void {
    const { context, logger, exclusions, imageGenerator, previewProvider, releaseManager, modelsView, librariesView, runnerEnvironment } = deps;

    /**
     * Where a new model goes is decided beside "the model in question": the row the command was
     * invoked on, or failing that the row selected in the view. A group row names no file.
     */
    const contextOf = (node?: TreeNode): string | undefined =>
        node?.type === 'model' ? node.model.uri : modelsView.selectedModel?.uri;

    /**
     * Run an export, and stay pending until it has finished.
     *
     * The `await` matters even though `generateAndSave` handles its own failures: a command
     * whose promise resolves early tells VS Code the work is done while the compiler is still
     * running, which is what the editor uses to decide whether a command is still in flight.
     */
    const exportIn = async (format: ImageFormat): Promise<void> => {
        const { doc, diagramName } = await previewProvider.resolveExportContext();
        await imageGenerator.generateAndSave(format, doc, diagramName);
    };

    /** The Models row a command was invoked on, if it was. */
    const modelOf = (arg: unknown): ModelNode | undefined =>
        typeof arg === 'object' && arg !== null && (arg as TreeNode).type === 'model' ? arg as ModelNode : undefined;

    /**
     * The model a jPipe-submenu command acts on, or `'editor'` for the one at the editor's cursor.
     *
     * The submenu is the same in the editor, on a `.jd` file in the Explorer and on a Models row
     * (jpipe-vscode ADR-VSC-0027), so its commands receive a tree node, or a file's URI. A row
     * names its model. A URI from the editor means the model at the cursor, as it always has. A
     * URI from the Explorer names a file: its one model, or the one picked when it has several.
     * `undefined` when there is none, or the pick was dismissed.
     */
    const targetOf = async (arg: unknown): Promise<Model | 'editor' | undefined> => {
        const node = modelOf(arg);
        if (node) return node.model;
        if (!(arg instanceof vscode.Uri)) return 'editor';
        if (vscode.window.activeTextEditor?.document.uri.toString() === arg.toString()) return 'editor';
        const inFile = modelsView.knownModels.filter(m => vscode.Uri.parse(m.uri).toString() === arg.toString());
        if (inFile.length <= 1) {
            if (inFile.length === 0) void vscode.window.showWarningMessage(`${vscode.workspace.asRelativePath(arg)} declares no model.`);
            return inFile[0];
        }
        const picked = await vscode.window.showQuickPick(
            inFile.map(model => ({ label: model.name, description: model.kind, model })),
            { title: `Which model of ${vscode.workspace.asRelativePath(arg)}?` });
        return picked?.model;
    };

    /** The file a command should act on: a row's model's file, or the URI the editor or Explorer passed. */
    const resourceOf = (arg: unknown): vscode.Uri | undefined => {
        const node = modelOf(arg);
        if (node) return vscode.Uri.parse(node.model.uri);
        return arg instanceof vscode.Uri ? arg : undefined;
    };

    /** Export the model the command targets: a row's, an Explorer file's, or the editor's. */
    const exportFrom = async (arg: unknown, format: ImageFormat): Promise<void> => {
        const target = await targetOf(arg);
        if (target === 'editor') return exportIn(format);
        if (!target) return;
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
        await imageGenerator.generateAndSave(format, document, target.name);
    };

    context.subscriptions.push(
        ...EXPORT_COMMANDS.map(([command, format]) =>
            vscode.commands.registerCommand(command, (arg?: unknown) => exportFrom(arg, format))),

        vscode.commands.registerCommand('jpipe.export', async () => {
            const configured = vscode.workspace.getConfiguration('jpipe')
                .get<string>('defaultExportFormat', 'SVG');
            await exportIn((ImageFormat as Record<string, ImageFormat>)[configured] ?? ImageFormat.SVG);
        }),

        // The preview draws the model under the cursor, so from a row, putting the cursor on the
        // row's model is the whole of choosing which one.
        vscode.commands.registerCommand('jpipe.vis.preview', async (arg?: unknown) => {
            const target = await targetOf(arg);
            if (!target) return;
            if (target !== 'editor') await modelsView.openModel(target);
            await previewProvider.openPreview();
        }),

        vscode.commands.registerCommand('jpipe.models.refresh', () => modelsView.refresh()),

        // ▶: the model of the Models row it was clicked on, or the one the cursor is in.
        vscode.commands.registerCommand('jpipe.run', (node?: TreeNode) =>
            runModel({ context, logger, imageGenerator, libraries: librariesView, models: modelsView, environment: runnerEnvironment },
                node?.type === 'model' ? node.model : undefined)),
        vscode.commands.registerCommand('jpipe.libraries.checkAll', () => librariesView.checkAll()),
        vscode.commands.registerCommand('jpipe.libraries.uncheckAll', () => librariesView.uncheckAll()),
        vscode.commands.registerCommand('jpipe.libraries.refresh', () => librariesView.rescanAll()),
        vscode.commands.registerCommand('jpipe.libraries.new', () => newLibrary(librariesView, modelsView)),
        vscode.commands.registerCommand('jpipe.runner.fixEnvironment', () => runnerEnvironment.fix()),
        vscode.commands.registerCommand('jpipe.models.newJustification', (node?: TreeNode) =>
            newModel(modelsView.knownModels, { kind: 'justification', contextUri: contextOf(node) })),
        vscode.commands.registerCommand('jpipe.models.newTemplate', (node?: TreeNode) =>
            newModel(modelsView.knownModels, { kind: 'template', contextUri: contextOf(node) })),
        vscode.commands.registerCommand('jpipe.models.newImplementation', (node: ModelNode) =>
            newModel(modelsView.knownModels, { kind: 'justification', template: node.model, contextUri: node.model.uri })),
        vscode.commands.registerCommand('jpipe.models.scaffoldLibrary', (node: ModelNode) =>
            scaffoldLibrary(librariesView, node.model,
                document => imageGenerator.generate(false, ImageFormat.PYTHON, document, node.model.name))),

        ...CODE_ACTION_COMMANDS.map(([command, kind, action]) =>
            vscode.commands.registerCommand(command, async () => {
                await vscode.commands.executeCommand(action, { kind, apply: 'first' });
            })),

        // Laying a model out is Format Document — the language server provides the formatter. The
        // command survives its move out of the list above so that a keybinding people already
        // have keeps working, and so that the palette answers "auto indent" under jPipe.
        vscode.commands.registerCommand('jpipe.autoIndent', () =>
            vscode.commands.executeCommand('editor.action.formatDocument')),

        vscode.commands.registerCommand('jpipe.addExcludedDirectory', () => addExcludedDirectory(exclusions)),
        vscode.commands.registerCommand('jpipe.excludeResource', (arg?: unknown) => excludeResource(exclusions, resourceOf(arg))),
        vscode.commands.registerCommand('jpipe.includeResource', (arg?: unknown) => includeResource(exclusions, resourceOf(arg))),
        vscode.commands.registerCommand('jpipe.removeExcludedPath', () => removeExcludedPath(exclusions)),

        vscode.commands.registerCommand('jpipe.installFromRelease', () =>
            installFromRelease({ releaseManager, logger })),

        vscode.commands.registerCommand('jpipe.selectJarFile', () => selectJarFile(logger)),

        vscode.commands.registerCommand('jpipe.checkInstallation', async () => {
            const { ok, message } = await imageGenerator.check();
            const mode = vscode.workspace.getConfiguration('jpipe').get<string>('executionMode', 'cli');
            const detail = `${accessMethodHeader(mode, releaseManager.getInstalled())}\n\n${message}`;
            if (ok) {
                vscode.window.showInformationMessage('jPipe is accessible.', { modal: true, detail });
            } else {
                vscode.window.showErrorMessage('Cannot access jPipe.', { modal: true, detail });
            }
        })
    );
}
