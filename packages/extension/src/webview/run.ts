import type { RunPanelToHost } from '../shared/run-protocol.js';
import { RunPage, type PersistedRunState } from './run-view.js';

/**
 * The run panel's entry point: connects `RunPage` to the webview, and nothing else.
 *
 * The inbox is not checked by `event.origin`, for the reason the preview's is not: the host is the
 * only party that can post to a webview, whose origin is an opaque per-session identity this code
 * cannot name. What is checked is that the message belongs to the protocol (`RunPage.receive`).
 */

declare function acquireVsCodeApi(): {
    postMessage(msg: RunPanelToHost): void;
    getState(): PersistedRunState | undefined;
    setState(state: PersistedRunState): void;
};

const vscode = acquireVsCodeApi();
const page = new RunPage(document, message => vscode.postMessage(message), vscode.getState() ?? {}, state => vscode.setState(state));

window.addEventListener('message', (event: MessageEvent<unknown>) => page.receive(event.data));

// The host replays the run in response, so a reloaded webview comes back with what it showed.
vscode.postMessage({ type: 'ready' });
