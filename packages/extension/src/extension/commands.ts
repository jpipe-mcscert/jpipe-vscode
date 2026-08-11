import * as vscode from 'vscode';
import {
    ORGANIZE_LOADS_KIND,
    AUTO_INDENT_KIND,
    CONVERT_MODEL_KIND,
    SORT_ELEMENTS_KIND,
    EXTRACT_TEMPLATE_KIND
} from 'jpipe-language';
import type { JpipeLogger } from './logger.js';
import type { ExclusionManager } from './exclusions.js';
import { ImageGenerator, ImageFormat } from './compiler/image-generator.js';
import type { ReleaseManager } from './compiler/release-manager.js';
import type { PreviewProvider } from './preview/preview-provider.js';
import { installFromRelease } from './compiler/managed-install.js';
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
    ['jpipe.autoIndent', AUTO_INDENT_KIND, 'editor.action.sourceAction'],
    ['jpipe.convertModelKind', CONVERT_MODEL_KIND, 'editor.action.refactor'],
    ['jpipe.sortElements', SORT_ELEMENTS_KIND, 'editor.action.refactor'],
    ['jpipe.extractTemplate', EXTRACT_TEMPLATE_KIND, 'editor.action.refactor']
];

export function registerCommands(deps: CommandDeps): void {
    const { context, logger, exclusions, imageGenerator, previewProvider, releaseManager } = deps;

    const exportIn = async (format: ImageFormat): Promise<void> => {
        const { doc, diagramName } = await previewProvider.resolveExportContext();
        imageGenerator.generateAndSave(format, doc, diagramName);
    };

    context.subscriptions.push(
        ...EXPORT_COMMANDS.map(([command, format]) =>
            vscode.commands.registerCommand(command, () => exportIn(format))),

        vscode.commands.registerCommand('jpipe.export', async () => {
            const configured = vscode.workspace.getConfiguration('jpipe')
                .get<string>('defaultExportFormat', 'SVG');
            await exportIn((ImageFormat as Record<string, ImageFormat>)[configured] ?? ImageFormat.SVG);
        }),

        vscode.commands.registerCommand('jpipe.vis.preview', () => previewProvider.openPreview()),

        ...CODE_ACTION_COMMANDS.map(([command, kind, action]) =>
            vscode.commands.registerCommand(command, async () => {
                await vscode.commands.executeCommand(action, { kind, apply: 'first' });
            })),

        vscode.commands.registerCommand('jpipe.addExcludedDirectory', () => addExcludedDirectory(exclusions)),
        vscode.commands.registerCommand('jpipe.excludeResource', (uri?: vscode.Uri) => excludeResource(exclusions, uri)),
        vscode.commands.registerCommand('jpipe.includeResource', (uri?: vscode.Uri) => includeResource(exclusions, uri)),
        vscode.commands.registerCommand('jpipe.removeExcludedPath', () => removeExcludedPath(exclusions)),

        vscode.commands.registerCommand('jpipe.installFromRelease', () =>
            installFromRelease({ releaseManager, logger })),

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
