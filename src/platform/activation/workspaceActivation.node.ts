import { inject, injectable } from 'inversify';
import { TextDocument } from 'vscode';
import { sendActivationTelemetry } from '../../telemetry/envFileTelemetry.node';
import { IPythonExtensionChecker } from '../api/types';
import { IWorkspaceService, IActiveResourceService, IDocumentManager } from '../common/application/types';
import { PYTHON_LANGUAGE } from '../common/constants';
import { IFileSystem } from '../common/platform/types.node';
import { IDisposable, Resource } from '../common/types';
import { Deferred } from '../common/utils/async';
import { IInterpreterService } from '../interpreter/contracts';
import { traceDecoratorError } from '../logging';
import { IExtensionSingleActivationService } from './types';

@injectable()
export class WorkspaceActivation implements IExtensionSingleActivationService {
    public readonly activatedWorkspaces = new Set<string>();
    protected readonly isInterpreterSetForWorkspacePromises = new Map<string, Deferred<void>>();
    private readonly disposables: IDisposable[] = [];
    private docOpenedHandler?: IDisposable;

    constructor(
        @inject(IDocumentManager) private readonly documentManager: IDocumentManager,
        @inject(IInterpreterService) private readonly interpreterService: IInterpreterService,
        @inject(IWorkspaceService) private readonly workspaceService: IWorkspaceService,
        @inject(IFileSystem) private readonly fileSystem: IFileSystem,
        @inject(IActiveResourceService) private readonly activeResourceService: IActiveResourceService,
        @inject(IPythonExtensionChecker) private readonly extensionChecker: IPythonExtensionChecker
    ) {}

    public async activate(): Promise<void> {
        this.addHandlers();
        this.addRemoveDocOpenedHandlers();
        return this.activateWorkspace(this.activeResourceService.getActiveResource());
    }

    @traceDecoratorError('Failed to activate a workspace')
    public async activateWorkspace(resource: Resource) {
        const key = this.getWorkspaceKey(resource);
        if (this.activatedWorkspaces.has(key)) {
            return;
        }
        this.activatedWorkspaces.add(key);

        // Get latest interpreter list in the background.
        if (this.extensionChecker.isPythonExtensionActive) {
            this.interpreterService.getInterpreters(resource).ignoreErrors();
        }

        await sendActivationTelemetry(this.fileSystem, this.workspaceService, resource);
    }

    public onDocOpened(doc: TextDocument) {
        if (doc.languageId !== PYTHON_LANGUAGE) {
            return;
        }
        const key = this.getWorkspaceKey(doc.uri);
        // If we have opened a doc that does not belong to workspace, then do nothing.
        if (key === '' && this.workspaceService.hasWorkspaceFolders) {
            return;
        }
        if (this.activatedWorkspaces.has(key)) {
            return;
        }
        const folder = this.workspaceService.getWorkspaceFolder(doc.uri);
        this.activateWorkspace(folder ? folder.uri : undefined).ignoreErrors();
    }

    protected addHandlers() {
        this.disposables.push(this.workspaceService.onDidChangeWorkspaceFolders(this.onWorkspaceFoldersChanged, this));
    }
    protected addRemoveDocOpenedHandlers() {
        if (this.hasMultipleWorkspaces()) {
            if (!this.docOpenedHandler) {
                this.docOpenedHandler = this.documentManager.onDidOpenTextDocument(this.onDocOpened, this);
            }
            return;
        }
        if (this.docOpenedHandler) {
            this.docOpenedHandler.dispose();
            this.docOpenedHandler = undefined;
        }
    }
    protected onWorkspaceFoldersChanged() {
        //If an activated workspace folder was removed, delete its key
        const workspaceKeys = this.workspaceService.workspaceFolders!.map((workspaceFolder) =>
            this.getWorkspaceKey(workspaceFolder.uri)
        );
        const activatedWkspcKeys = Array.from(this.activatedWorkspaces.keys());
        const activatedWkspcFoldersRemoved = activatedWkspcKeys.filter((item) => workspaceKeys.indexOf(item) < 0);
        if (activatedWkspcFoldersRemoved.length > 0) {
            for (const folder of activatedWkspcFoldersRemoved) {
                this.activatedWorkspaces.delete(folder);
            }
        }
        this.addRemoveDocOpenedHandlers();
    }
    protected hasMultipleWorkspaces() {
        return this.workspaceService.hasWorkspaceFolders && this.workspaceService.workspaceFolders!.length > 1;
    }
    protected getWorkspaceKey(resource: Resource) {
        return this.workspaceService.getWorkspaceFolderIdentifier(resource, '');
    }
}
