/**
 * When a view of the jPipe activity asks the language server again: what the Models view and its
 * Outline share. No VS Code, so it stays loadable outside an extension host (jpipe-vscode
 * ADR-VSC-0004).
 *
 * A refresh requested while the view is hidden is only remembered, and made when the view is
 * shown, or when its rows are asked for: there is no point keeping a tree nobody is looking at up
 * to date. A refresh caused by typing waits for a pause in it.
 */

/**
 * How long to wait after the last edit before asking the server again. Long enough that typing
 * a name does not send a request per keystroke, short enough that a renamed model looks renamed.
 */
export const REFRESH_DELAY_MS = 500;

export class TreeLoader {
    private stale = true;
    /** The load in progress, which the view's rows wait on so it shows progress, not emptiness. */
    private loading: Promise<void> | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;

    /**
     * @param load asks the server and keeps the answer.
     * @param isVisible whether the view is showing.
     * @param onStarted a load was started for a refresh: the view fires its change, and asks for
     *   the rows, which wait on it.
     */
    constructor(
        private readonly load: () => Promise<void>,
        private readonly isVisible: () => boolean,
        private readonly onStarted: () => void
    ) {}

    /** Whether the rows are out of date and not being loaded again yet. */
    get isStale(): boolean {
        return this.stale;
    }

    /** Ask the server again, now if the view is showing, otherwise the next time it is. */
    refresh(): void {
        this.stale = true;
        if (!this.isVisible()) return;
        this.start();
        this.onStarted();
    }

    /** `refresh`, once the edits have paused. */
    scheduleRefresh(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.refresh();
        }, REFRESH_DELAY_MS);
    }

    /**
     * Count a refresh still waiting out its pause as due now: what is asked right after an edit
     * must see it, not the answer from before it.
     */
    flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
            this.stale = true;
        }
    }

    /** Once the rows are up to date: loaded again first if they are not, whether or not the view is showing. */
    async loaded(): Promise<void> {
        if (this.stale) this.start();
        await this.loading;
    }

    private start(): void {
        this.stale = false;
        this.loading = this.load();
    }

    dispose(): void {
        if (this.timer) clearTimeout(this.timer);
    }
}
