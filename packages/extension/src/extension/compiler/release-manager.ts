import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { JpipeLogger } from '../logger.js';
import { messageOf } from '../../shared/errors.js';
import { isStrictlyNewer, selectInstallableReleases, type JpipeRelease } from './release-selection.js';
import {
    DEFAULT_RELEASE_REPO,
    DEFAULT_UPDATE_INTERVAL_HOURS,
    compilerRootIn,
    downloadJar,
    httpsGetJson,
    isDueForUpdateCheck,
    releasesUrl,
    resolveRepo
} from './release-download.js';

/** globalState keys. */
const KEY_INSTALLED = 'jpipe.managedCompiler';
const KEY_LAST_CHECK = 'jpipe.managedCompiler.lastUpdateCheck';

interface InstalledCompiler {
    tag: string;
    jarPath: string;
}

// Re-exported so `import { JpipeRelease } from './release-manager.js'` keeps working.
export type { JpipeRelease };

/**
 * The editor-facing half of managed compiler installs.
 *
 * Deliberately thin. Everything this class does is something only an extension host can do —
 * read settings, own `globalState`, ask the user a question — and everything else (HTTP,
 * redirects, host validation, file placement, the update-due arithmetic) lives in
 * `release-download.ts`, which no `vscode` import reaches and which is therefore testable.
 *
 * The split is the point: this file is excluded from coverage because it cannot be loaded
 * outside VS Code, so anything left in it is untestable by construction rather than by accident
 * (jpipe-vscode ADR-VSC-0004, ADR-VSC-0010).
 */
export class ReleaseManager {

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly logger: JpipeLogger
    ) {}

    /**
     * List installable releases (v2.0.0+ with a `jpipe-cli-*.jar` asset), newest first.
     * Excludes pre-releases unless `jpipe.managedIncludePrereleases` is enabled; the rolling
     * non-semver `unstable` tag is always excluded. Throws on network/API failure.
     */
    public async listReleases(): Promise<JpipeRelease[]> {
        const config = vscode.workspace.getConfiguration('jpipe');
        const includePrereleases = config.get<boolean>('managedIncludePrereleases', false);
        const raw = await httpsGetJson(releasesUrl(this.repo()));
        const releases = selectInstallableReleases(raw, includePrereleases);
        this.logger.debug(`Found ${releases.length} installable jPipe release(s)`);
        return releases;
    }

    /**
     * Download the jar for `release` into hidden global storage and return its path.
     * Idempotent: an already-present jar with the expected byte size is reused.
     */
    public download(
        release: JpipeRelease,
        onProgress?: (fraction: number) => void
    ): Promise<string> {
        const root = compilerRootIn(this.context.globalStorageUri.fsPath);
        return downloadJar(release, root, this.logger, onProgress);
    }

    /** The currently installed managed compiler, or undefined if none / the file vanished. */
    public getInstalled(): InstalledCompiler | undefined {
        const installed = this.context.globalState.get<InstalledCompiler>(KEY_INSTALLED);
        if (!installed?.jarPath) return undefined;
        if (!fs.existsSync(installed.jarPath)) {
            this.logger.warn(`Managed jPipe jar missing on disk: ${installed.jarPath}`);
            return undefined;
        }
        return installed;
    }

    /** Record the active managed compiler. */
    public async setInstalled(tag: string, jarPath: string): Promise<void> {
        await this.context.globalState.update(KEY_INSTALLED, { tag, jarPath } satisfies InstalledCompiler);
    }

    /**
     * If the extension is in managed mode with a compiler installed and a strictly-newer
     * release exists, show a non-blocking notification offering to update. Throttled and
     * silent on any failure (this runs opportunistically at activation).
     */
    public async maybeNotifyUpdate(runInstall: (preselectTag: string) => Promise<void>): Promise<void> {
        const config = vscode.workspace.getConfiguration('jpipe');
        // Managed-mode only: don't prompt when the user is running cli/jar even if a
        // managed jar happens to be installed (matches jpipe.managedCheckForUpdates' scope).
        if (config.get<string>('executionMode', 'cli') !== 'managed') return;
        if (!config.get<boolean>('managedCheckForUpdates', true)) return;

        const installed = this.getInstalled();
        if (!installed) return;

        const hours = config.get<number>('managedUpdateCheckIntervalHours', DEFAULT_UPDATE_INTERVAL_HOURS);
        const last = this.context.globalState.get<number>(KEY_LAST_CHECK, 0);
        if (!isDueForUpdateCheck(last, Date.now(), hours)) return;
        await this.context.globalState.update(KEY_LAST_CHECK, Date.now());

        try {
            const releases = await this.listReleases();
            const latest = releases[0]; // sorted newest-first
            if (!latest || !isStrictlyNewer(latest.tag, installed.tag)) return;

            const sel = await vscode.window.showInformationMessage(
                `A newer jPipe compiler (${latest.tag}) is available. You have ${installed.tag}.`,
                'Update'
            );
            if (sel === 'Update') await runInstall(latest.tag);
        } catch (err) {
            this.logger.debug(`Update check skipped: ${messageOf(err)}`);
        }
    }

    /** The `owner/repo` releases are pulled from (configurable for forks/testing). */
    private repo(): string {
        const configured = vscode.workspace.getConfiguration('jpipe')
            .get<string>('managedRepository', DEFAULT_RELEASE_REPO);
        return resolveRepo(configured, this.logger);
    }
}
