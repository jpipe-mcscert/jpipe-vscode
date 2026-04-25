export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const ORDER: LogLevel[] = ['off', 'error', 'warn', 'info', 'debug', 'trace'];

export class JpipeServerLogger {
    private readonly rank: number;

    constructor(level: LogLevel = 'info') {
        const idx = ORDER.indexOf(level);
        this.rank = idx === -1 ? ORDER.indexOf('info') : idx;
    }

    shouldLog(level: LogLevel): boolean { return ORDER.indexOf(level) <= this.rank; }

    error(msg: string): void { if (this.rank >= 1) console.error(`[jPipe] ERROR ${msg}`); }
    warn(msg: string):  void { if (this.rank >= 2) console.warn(`[jPipe] WARN  ${msg}`); }
    info(msg: string):  void { if (this.rank >= 3) console.log(`[jPipe] INFO  ${msg}`); }
    debug(msg: string): void { if (this.rank >= 4) console.log(`[jPipe] DEBUG ${msg}`); }
    trace(msg: string): void { if (this.rank >= 5) console.log(`[jPipe] TRACE ${msg}`); }
}
