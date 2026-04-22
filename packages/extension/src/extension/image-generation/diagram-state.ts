export enum DiagramState {
    READY,
    UNSAVED
}

export class DiagramStateMachine {
    private state: DiagramState = DiagramState.READY;
    private currentUri: string | undefined;

    onFileSaved(uri: string): void {
        if (this.currentUri === uri) {
            this.state = DiagramState.READY;
        }
    }

    onFileChanged(uri: string): void {
        if (this.currentUri === uri) {
            this.state = DiagramState.UNSAVED;
        }
    }

    onFileOpened(uri: string): void {
        this.currentUri = uri;
        this.state = DiagramState.READY;
    }

    canRender(): boolean {
        return this.state === DiagramState.READY;
    }

    getMessage(): string | null {
        if (this.state === DiagramState.UNSAVED) {
            return 'Save file to update diagram';
        }
        return null;
    }
}
