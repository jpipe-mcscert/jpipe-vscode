import * as vscode from 'vscode';

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const ORDER: LogLevel[] = ['off', 'error', 'warn', 'info', 'debug', 'trace'];

export class JpipeLogger {
    private readonly channel: vscode.OutputChannel;
    private rank: number;

    constructor(context: vscode.ExtensionContext) {
        this.channel = vscode.window.createOutputChannel('jPipe');
        context.subscriptions.push(this.channel);
        this.rank = this.readRank();
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('jpipe.logLevel')) this.rank = this.readRank();
        }, undefined, context.subscriptions);
    }

    private readRank(): number {
        const level = vscode.workspace.getConfiguration('jpipe').get<string>('logLevel', 'info');
        const idx = ORDER.indexOf(level as LogLevel);
        return idx === -1 ? ORDER.indexOf('info') : idx;
    }

    shouldLog(level: LogLevel): boolean { return ORDER.indexOf(level) <= this.rank; }

    trace(msg: string): void { this.write(5, 'TRACE', msg); }
    debug(msg: string): void { this.write(4, 'DEBUG', msg); }
    info(msg: string):  void { this.write(3, 'INFO ', msg); }
    warn(msg: string):  void { this.write(2, 'WARN ', msg); }
    error(msg: string): void { this.write(1, 'ERROR', msg); }

    reveal(): void { this.channel.show(true); }

    private write(rank: number, label: string, msg: string): void {
        if (rank > this.rank) return;
        this.channel.appendLine(`${new Date().toISOString()} [${label}] ${msg}`);
    }
}
