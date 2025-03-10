// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { inject, injectable } from 'inversify';
import {
    NotebookDocument,
    CancellationToken,
    Disposable,
    NotebookEditor,
    Uri,
    EventEmitter,
    CancellationTokenSource
} from 'vscode';
import { IVSCodeNotebook } from '../../platform/common/application/types';
import { Cancellation } from '../../platform/common/cancellation';
import { disposeAllDisposables } from '../../platform/common/helpers';
import { traceVerbose, traceInfoIfCI } from '../../platform/logging';
import { getDisplayPath } from '../../platform/common/platform/fs-paths';
import { IDisposableRegistry, IAsyncDisposableRegistry, IDisposable } from '../../platform/common/types';
import { createDeferred } from '../../platform/common/utils/async';
import { noop } from '../../platform/common/utils/misc';
import { InteractiveWindowMessages, IPyWidgetMessages } from '../../platform/messageTypes';
import { IServiceContainer } from '../../platform/ioc/types';
import { CommonMessageCoordinator } from './commonMessageCoordinator';
import { INotebookCommunication, INotebookControllerManager } from '../../notebooks/types';
import { ConsoleForegroundColors } from '../../platform/logging/types';
import { IVSCodeNotebookController } from '../../notebooks/controllers/types';

class NotebookCommunication implements INotebookCommunication, IDisposable {
    private eventHandlerListening?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private pendingMessages: any[] = [];
    private readonly disposables: IDisposable[] = [];
    private controllerMessageHandler?: IDisposable;
    private controller!: IVSCodeNotebookController;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly _onDidReceiveMessage = new EventEmitter<any>();
    constructor(public readonly editor: NotebookEditor, controller: IVSCodeNotebookController) {
        this.changeController(controller);
    }
    public changeController(controller: IVSCodeNotebookController) {
        if (this.controller === controller) {
            return;
        }
        this.controllerMessageHandler?.dispose();
        this.controller = controller;
        this.controllerMessageHandler = controller.onDidReceiveMessage(
            (e) => {
                // Handle messages from this only if its still the active controller.
                if (e.editor === this.editor && this.controller === controller) {
                    // If the listeners haven't been hooked up, then dont fire the event (nothing listening).
                    // Instead buffer the messages and fire the events later.
                    if (this.eventHandlerListening) {
                        this.sendPendingMessages();
                        this._onDidReceiveMessage.fire(e.message);
                    } else {
                        this.pendingMessages.push(e.message);
                    }
                }
            },
            this,
            this.disposables
        );
    }
    public dispose() {
        disposeAllDisposables(this.disposables);
    }
    public get onDidReceiveMessage() {
        this.eventHandlerListening = true;
        // Immeidately after the event handler is added, send the pending messages.
        setTimeout(() => this.sendPendingMessages(), 0);
        return this._onDidReceiveMessage.event;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public postMessage(message: any): Thenable<boolean> {
        return this.controller.postMessage(message, this.editor);
    }
    public asWebviewUri(localResource: Uri): Uri {
        return this.controller.asWebviewUri(localResource);
    }
    private sendPendingMessages() {
        if (this.pendingMessages.length) {
            let message = this.pendingMessages.shift();
            while (message) {
                this._onDidReceiveMessage.fire(message);
                message = this.pendingMessages.shift();
            }
        }
    }
}

/**
 * This class wires up VSC notebooks to ipywidget communications.
 */
@injectable()
export class NotebookIPyWidgetCoordinator {
    private readonly messageCoordinators = new WeakMap<NotebookDocument, Promise<CommonMessageCoordinator>>();
    private readonly attachedEditors = new WeakMap<NotebookDocument, WeakSet<NotebookEditor>>();
    private readonly notebookDisposables = new WeakMap<NotebookDocument, Disposable[]>();
    private readonly previouslyInitialized = new WeakSet<NotebookEditor>();
    /**
     * Public for testing purposes
     */
    public readonly notebookCommunications = new WeakMap<NotebookEditor, NotebookCommunication>();
    private readonly notebookEditors = new WeakMap<NotebookDocument, NotebookEditor[]>();
    constructor(
        @inject(IServiceContainer) private readonly serviceContainer: IServiceContainer,
        @inject(IDisposableRegistry) disposableRegistry: IDisposableRegistry,
        @inject(IAsyncDisposableRegistry) private readonly asyncDisposableRegistry: IAsyncDisposableRegistry,
        @inject(IVSCodeNotebook) private readonly notebook: IVSCodeNotebook,
        @inject(INotebookControllerManager) private readonly controllerManager: INotebookControllerManager
    ) {
        notebook.onDidChangeVisibleNotebookEditors(this.onDidChangeVisibleNotebookEditors, this, disposableRegistry);
        notebook.onDidCloseNotebookDocument(this.onDidCloseNotebookDocument, this, disposableRegistry);
        controllerManager.onNotebookControllerSelected(this.onDidSelectController, this, disposableRegistry);
    }
    public onDidSelectController(e: { notebook: NotebookDocument; controller: IVSCodeNotebookController }) {
        // Dispost previous message coordinators.
        traceVerbose(`Setting setActiveController for ${getDisplayPath(e.notebook.uri)}`);
        const previousCoordinators = this.messageCoordinators.get(e.notebook);
        if (previousCoordinators) {
            this.messageCoordinators.delete(e.notebook);
            this.attachedEditors.delete(e.notebook);
            this.notebook.notebookEditors
                .filter((editor) => editor.document === e.notebook)
                .forEach((editor) => {
                    const comms = this.notebookCommunications.get(editor);
                    this.previouslyInitialized.delete(editor);
                    this.notebookCommunications.delete(editor);
                    if (comms) {
                        comms.dispose();
                    }
                });
            previousCoordinators.then((item) => item.dispose()).catch(noop);
        }
        // Swap the controller in the communication objects (if we have any).
        const editors = this.notebookEditors.get(e.notebook) || [];
        const notebookComms = editors
            .filter((editor) => this.notebookCommunications.has(editor))
            .map((editor) => this.notebookCommunications.get(editor)!);
        notebookComms.forEach((comm) => comm.changeController(e.controller));

        // Possible user has split the notebook editor, if that's the case we need to hookup comms with this new editor as well.
        this.notebook.notebookEditors.forEach((editor) => this.initializeNotebookCommunication(editor, e.controller));
    }
    private initializeNotebookCommunication(editor: NotebookEditor, controller: IVSCodeNotebookController | undefined) {
        const notebook = editor.document;
        if (!controller) {
            traceVerbose(
                `No controller, hence notebook communications cannot be initialized for editor ${getDisplayPath(
                    editor.document.uri
                )}`
            );
            return;
        }
        if (this.notebookCommunications.has(editor)) {
            traceVerbose(
                `notebook communications already initialized for editor ${getDisplayPath(editor.document.uri)}`
            );
            return;
        }
        traceVerbose(`Intiailize notebook communications for editor ${getDisplayPath(editor.document.uri)}`);
        const comms = new NotebookCommunication(editor, controller);
        this.addNotebookDiposables(notebook, [comms]);
        this.notebookCommunications.set(editor, comms);
        const { token } = new CancellationTokenSource();
        this.resolveKernel(notebook, comms, token).catch(noop);
    }
    private resolveKernel(
        document: NotebookDocument,
        webview: INotebookCommunication,
        token: CancellationToken
    ): Promise<void> {
        // Create a handler for this notebook if we don't already have one. Since there's one of the notebookMessageCoordinator's for the
        // entire VS code session, we have a map of notebook document to message coordinator
        traceVerbose(`Resolving notebook UI Comms (resolve) for ${getDisplayPath(document.uri)}`);
        let promise = this.messageCoordinators.get(document);
        if (promise === undefined) {
            promise = CommonMessageCoordinator.create(document, this.serviceContainer);
            this.messageCoordinators.set(document, promise);
            this.asyncDisposableRegistry.push({
                dispose: async () => promise?.then((item) => item.dispose()).catch(noop)
            });
        }
        return Cancellation.race(() => promise!.then(this.attachCoordinator.bind(this, document, webview)), token);
    }
    private addNotebookDiposables(notebook: NotebookDocument, disposables: IDisposable[]) {
        const currentDisposables: IDisposable[] = this.notebookDisposables.get(notebook) || [];
        currentDisposables.push(...disposables);
        this.notebookDisposables.set(notebook, currentDisposables);
    }
    private async onDidChangeVisibleNotebookEditors(e: readonly NotebookEditor[]) {
        // Find any new editors that may be associated with the current notebook.
        // This can happen when users split editors.
        e.forEach((editor) => {
            const controller = this.controllerManager.getSelectedNotebookController(editor.document);
            this.initializeNotebookCommunication(editor, controller);
        });
    }
    private onDidCloseNotebookDocument(notebook: NotebookDocument) {
        const editors = this.notebookEditors.get(notebook) || [];
        disposeAllDisposables(this.notebookDisposables.get(notebook) || []);
        editors.forEach((editor) => this.notebookCommunications.get(editor)?.dispose());

        const coordinator = this.messageCoordinators.get(notebook);
        void coordinator?.then((c) => c.dispose());
        this.messageCoordinators.delete(notebook);

        this.attachedEditors.delete(notebook);
    }
    private attachCoordinator(
        document: NotebookDocument,
        webview: INotebookCommunication,
        c: CommonMessageCoordinator
    ): Promise<void> {
        const promise = createDeferred<void>();
        const attachedEditors = this.attachedEditors.get(document) || new Set<NotebookEditor>();
        this.attachedEditors.set(document, attachedEditors);
        if (attachedEditors.has(webview.editor) || this.previouslyInitialized.has(webview.editor)) {
            traceVerbose(`Coordinator already attached for ${getDisplayPath(document.uri)}`);
            promise.resolve();
        } else {
            attachedEditors.add(webview.editor);
            const disposables: IDisposable[] = [];
            traceVerbose(`Attach Coordinator for ${getDisplayPath(document.uri)}`);
            // Attach message requests to this webview (should dupe to all of them)
            c.postMessage(
                (e) => {
                    traceInfoIfCI(`${ConsoleForegroundColors.Green}Widget Coordinator sent ${e.message}`);
                    // Special case for webview URI translation
                    if (e.message === InteractiveWindowMessages.ConvertUriForUseInWebViewRequest) {
                        c.onMessage(InteractiveWindowMessages.ConvertUriForUseInWebViewResponse, {
                            request: e.payload,
                            response: webview.asWebviewUri(e.payload)
                        });
                    } else {
                        void webview.postMessage({ type: e.message, payload: e.payload });
                    }
                },
                this,
                disposables
            );
            webview.onDidReceiveMessage(
                (m) => {
                    traceInfoIfCI(`${ConsoleForegroundColors.Green}Widget Coordinator received ${m.type}`);
                    c.onMessage(m.type, m.payload);

                    // Special case the WidgetManager loaded message. It means we're ready
                    // to use a kernel. (IPyWidget Dispatcher uses this too)
                    if (m.type === IPyWidgetMessages.IPyWidgets_Ready) {
                        promise.resolve();
                        this.previouslyInitialized.add(webview.editor);
                    }
                },
                this,
                disposables
            );
            // In case the webview loaded earlier and it already sent the IPyWidgetMessages.IPyWidgets_Ready message
            // This way we don't make assumptions, we just query widgets and ask its its ready (avoids timing issues etc).
            webview
                .postMessage({ type: IPyWidgetMessages.IPyWidgets_IsReadyRequest, payload: undefined })
                .then(noop, noop);
            this.addNotebookDiposables(document, disposables);
        }
        return promise.promise;
    }
}
