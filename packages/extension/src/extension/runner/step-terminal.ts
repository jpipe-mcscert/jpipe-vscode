import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import { messageOf } from '../../shared/errors.js';
import { planLaunchHere } from '../process-launcher.js';
import type { FixStep } from './python-environment.js';

/**
 * Run one step of an environment fix where the user can watch it, with exactly `env`; resolves to
 * whether it succeeded.
 *
 * The program is started here, not by VS Code. A task's own process gets its environment laid
 * over VS Code's, so a variable can be changed but never removed — and a fix must run without the
 * `VIRTUAL_ENV` VS Code may have inherited, or Pipenv and Poetry install into that other project's
 * environment (jpipe-vscode ADR-VSC-0026). So the task only lends its terminal: what the program
 * prints is written to it, and closing it stops the program.
 */
export function runInTerminal(
    { name, program, args }: FixStep,
    options: { folder: vscode.WorkspaceFolder | undefined; env: NodeJS.ProcessEnv }
): Promise<{ ok: boolean; exitCode?: number }> {
    return new Promise(resolve => {
        const written = new vscode.EventEmitter<string>();
        const closed = new vscode.EventEmitter<number>();
        let child: ChildProcess | undefined;
        let ended = false;
        // A terminal wants CRLF; programs print LF.
        const show = (text: string): void => written.fire(text.replace(/\r?\n/g, '\r\n'));
        const end = (exitCode: number | undefined, note?: string): void => {
            if (ended) return;
            ended = true;
            if (note) show(`\n${note}\n`);
            closed.fire(exitCode ?? 1);
            written.dispose();
            closed.dispose();
            resolve({ ok: exitCode === 0, exitCode });
        };

        const terminal: vscode.Pseudoterminal = {
            onDidWrite: written.event,
            onDidClose: closed.event,
            open: () => {
                show(`> ${program} ${args.join(' ')}\n\n`);
                const plan = planLaunchHere(program, [...args], options.env);
                child = spawn(plan.file, plan.args, {
                    cwd: options.folder?.uri.fsPath,
                    env: options.env,
                    windowsHide: true,
                    windowsVerbatimArguments: plan.windowsVerbatimArguments,
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                // Decoded here rather than with `setEncoding`, which VS Code 1.139+ can break; see `execFileText`.
                for (const stream of [child.stdout, child.stderr]) {
                    const decoder = new TextDecoder('utf-8');
                    stream?.on('data', (chunk: Buffer) => show(decoder.decode(chunk, { stream: true })));
                }
                child.on('error', err => end(undefined, `${name} could not start: ${messageOf(err)}`));
                child.on('close', code => end(code ?? undefined, failure(name, code)));
            },
            close: () => {
                child?.kill();
                end(undefined);
            }
        };

        const task = new vscode.Task(
            { type: 'jpipe', model: name },
            options.folder ?? vscode.TaskScope.Workspace,
            name,
            'jPipe',
            new vscode.CustomExecution(() => Promise.resolve(terminal))
        );
        task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared, clear: false };
        vscode.tasks.executeTask(task).then(undefined, (err: unknown) => {
            void vscode.window.showErrorMessage(`${name} could not start: ${messageOf(err)}`);
            end(undefined);
        });
    });
}

/** What to say of a step that ended with `code`, or nothing when it succeeded. */
function failure(name: string, code: number | null): string | undefined {
    if (code === 0) return undefined;
    return code === null ? `${name} failed.` : `${name} failed (exit code ${code}).`;
}
