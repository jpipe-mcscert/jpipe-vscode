import * as vscode from 'vscode';
import type { Notice } from '../../shared/run-protocol.js';
import { endedWithout, outOfDateReason, startedRun, type Change, type ShownRun } from './run-state.js';

/** What the session needs to know about the Libraries view: which libraries are checked, and when that changes. */
export interface CheckedLibraries {
    readonly onDidChange: vscode.Event<void>;
    checkedLibraries(): readonly { uri: vscode.Uri }[];
}

/**
 * The last run: the one the run panel draws and the Results view lists (jpipe-vscode
 * ADR-VSC-0031). There is one, so the two views can never show different runs.
 *
 * Each launch of a run is given a token, and only the latest may change what is shown. A run
 * started while another is under way takes over the views, and the earlier one's result is dropped
 * when it arrives, as the preview drops a late render; its terminal stays. A run launched once more
 * (`relaunch`) is told apart from its earlier launch the same way, so what that launch writes late
 * is dropped too.
 */
export class RunSession implements vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    /** Fired whenever what is shown changes. */
    readonly onDidChange = this.changeEmitter.event;

    private shown: ShownRun | undefined;
    private latest = 0;
    private changes = 0;
    private execution: vscode.TaskExecution | undefined;
    private stopRequested = false;
    private output: (() => void) | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(libraries: CheckedLibraries) {
        this.disposables.push(
            this.changeEmitter,
            vscode.workspace.onDidSaveTextDocument(document => this.changed({
                kind: 'saved',
                path: document.uri.fsPath,
                display: vscode.workspace.asRelativePath(document.uri),
                isModel: document.languageId === 'jpipe'
            })),
            libraries.onDidChange(() => this.changed({
                kind: 'checked',
                paths: libraries.checkedLibraries().map(library => library.uri.fsPath)
            }))
        );
    }

    /** The run on show, if there has been one. */
    get run(): ShownRun | undefined {
        return this.shown;
    }

    /** Counts every change, so the page can drop a state older than the one it shows. */
    get revision(): number {
        return this.changes;
    }

    /** Whether the run on show is under way. */
    get running(): boolean {
        return this.shown?.phase === 'running';
    }

    /** Show a run of `name` starting, and give its first launch its token. */
    begin(name: string, uri: string, check: boolean, libraries: ShownRun['libraries']): number {
        this.stopRequested = false;
        this.output = undefined;
        return this.launched(startedRun(name, uri, check, libraries));
    }

    /**
     * Launch the run of `token` once more, and give that launch a token of its own: undefined, and
     * nothing changes, when another run has taken over. The launch starts from nothing shown, as the
     * run did (ADR-VSC-0033); what it is of, whether it is out of date, and a stop asked for stay.
     */
    relaunch(token: number): number | undefined {
        if (!this.isCurrent(token) || !this.shown) return undefined;
        const { name, uri, check, libraries, outOfDate } = this.shown;
        return this.launched({ ...startedRun(name, uri, check, libraries), outOfDate });
    }

    private launched(run: ShownRun): number {
        this.latest++;
        this.execution = undefined;
        this.show(run);
        return this.latest;
    }

    /** The token of the launch on show. */
    get current(): number {
        return this.latest;
    }

    /** Whether `token` is the launch on show: what an ending launch asks before saying anything. */
    isCurrent(token: number): boolean {
        return token === this.latest;
    }

    /** Change what is shown of launch `token`. False, and nothing changes, when another launch has taken over. */
    update(token: number, change: Partial<ShownRun>): boolean {
        if (!this.isCurrent(token) || !this.shown) return false;
        this.show({ ...this.shown, ...change });
        return true;
    }

    /** Say something about the run on show, whatever its phase: what stops it being run again, say. */
    say(notice: Notice): void {
        if (this.shown) this.show({ ...this.shown, notice });
    }

    /** End the run of launch `token` without a report, saying why (`endedWithout`). */
    endWith(token: number, phase: 'blocked' | 'stopped', notice: Notice): void {
        if (!this.isCurrent(token) || !this.shown) return;
        this.show(endedWithout(this.shown, phase, notice, new Date()));
    }

    /** The task launch `token` is executing in, so that it can be stopped. */
    attach(token: number, execution: vscode.TaskExecution, showOutput: () => void): void {
        if (!this.isCurrent(token)) return;
        this.execution = execution;
        this.output = showOutput;
        // Asked for before the task had started.
        if (this.stopRequested) execution.terminate();
    }

    /** Whether the user stopped the run of launch `token`. */
    stopped(token: number): boolean {
        return this.isCurrent(token) && this.stopRequested;
    }

    /** Stop the run under way. */
    stop(): void {
        if (!this.running) return;
        this.stopRequested = true;
        this.execution?.terminate();
    }

    /** Bring forward the terminal the run on show printed in, if it had one. */
    showOutput(): boolean {
        this.output?.();
        return this.output !== undefined;
    }

    private changed(change: Change): void {
        const reason = this.shown && outOfDateReason(this.shown, change);
        if (reason && this.shown && !this.shown.outOfDate) this.show({ ...this.shown, outOfDate: reason });
    }

    private show(run: ShownRun): void {
        this.shown = run;
        this.changes++;
        this.changeEmitter.fire();
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
    }
}
