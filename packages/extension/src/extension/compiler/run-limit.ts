/**
 * At most so many runs at a time, the others waiting their turn in the order they came.
 *
 * Every file with a composed model asks the compiler for its report when the workspace is first
 * checked, and each answer starts a JVM: without a limit, a workspace of many such files starts
 * them all at once. vscode-free, so it is tested (jpipe-vscode ADR-VSC-0004).
 */
export class RunLimit {
    private running = 0;
    private readonly waiting: Array<() => void> = [];

    constructor(private readonly max: number) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        while (this.running >= this.max) {
            await new Promise<void>(resolve => this.waiting.push(resolve));
        }
        this.running++;
        try {
            return await task();
        } finally {
            this.running--;
            this.waiting.shift()?.();
        }
    }
}
