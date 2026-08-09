import type { HostToWebview, WebviewToHost } from '../shared/preview-protocol.js';

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void };

const vscode = acquireVsCodeApi();

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
    void event;
});

vscode.postMessage({ type: 'ready' });
