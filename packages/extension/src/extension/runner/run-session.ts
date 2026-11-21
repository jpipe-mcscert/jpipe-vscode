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
 * Each run is given a token when it starts, and only the latest may change what is shown. A run
 * started while another is under way takes over the views, and the earlier one's result is dropped
 * when it arrives, as the preview drops a late render; its terminal stays.
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

    /** Show a run of `name` starting, and give it its token. */
    begin(name: string, uri: string, check: boolean, libraries: ShownRun['libraries']): number {
        this.latest++;
        this.execution = undefined;
        this.stopRequested = false;
        this.output = undefined;
        this.show(startedRun(name, uri, check, libraries));
        return this.latest;
    }

    /** The token of the run on show. */
    get current(): number {
        return this.latest;
    }

    /** Whether `token` is the run on show: what an ending run asks before saying anything. */
    isCurrent(token: number): boolean {
        return token === this.latest;
    }

    /** Change what is shown of run `token`. False, and nothing changes, when another run has taken over. */
    update(token: number, change: Partial<ShownRun>): boolean {
        if (!this.isCurrent(token) || !this.shown) return false;
        this.show({ ...this.shown, ...change });
        return true;
    }

    /** Say something about the run on show, whatever its phase: what stops it being run again, say. */
    say(notice: Notice): void {
        if (this.shown) this.show({ ...this.shown, notice });
    }

    /** End run `token` without a report, saying why (`endedWithout`). */
    endWith(token: number, phase: 'blocked' | 'stopped', notice: Notice): void {
        if (!this.isCurrent(token) || !this.shown) return;
        this.show(endedWithout(this.shown, phase, notice, new Date()));
    }

    /** The task run `token` is executing in, so that it can be stopped. */
    attach(token: number, execution: vscode.TaskExecution, showOutput: () => void): void {
        if (!this.isCurrent(token)) return;
        this.execution = execution;
        this.output = showOutput;
        // Asked for before the task had started.
        if (this.stopRequested) execution.terminate();
    }

    /** Whether the user stopped run `token`. */
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
