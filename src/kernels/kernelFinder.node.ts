// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { injectable, inject, named } from 'inversify';
import { Memento } from 'vscode';
import { IPythonExtensionChecker } from '../platform/api/types';
import { IFileSystem } from '../platform/common/platform/types.node';
import { GLOBAL_MEMENTO, IConfigurationService, IMemento } from '../platform/common/types';
import { IInterpreterService } from '../platform/interpreter/contracts';
import { IJupyterServerUriStorage } from './jupyter/types';
import { BaseKernelFinder } from './kernelFinder.base';
import { PreferredRemoteKernelIdProvider } from './raw/finder/preferredRemoteKernelIdProvider';
import { ILocalKernelFinder, IRemoteKernelFinder } from './raw/types';
import { INotebookProvider, KernelConnectionMetadata } from './types';

@injectable()
export class KernelFinder extends BaseKernelFinder {
    constructor(
        @inject(ILocalKernelFinder) localKernelFinder: ILocalKernelFinder,
        @inject(IRemoteKernelFinder) remoteKernelFinder: IRemoteKernelFinder,
        @inject(IPythonExtensionChecker) extensionChecker: IPythonExtensionChecker,
        @inject(IInterpreterService) interpreterService: IInterpreterService,
        @inject(PreferredRemoteKernelIdProvider) preferredRemoteFinder: PreferredRemoteKernelIdProvider,
        @inject(INotebookProvider) notebookProvider: INotebookProvider,
        @inject(IConfigurationService) configurationService: IConfigurationService,
        @inject(IMemento) @named(GLOBAL_MEMENTO) globalState: Memento,
        @inject(IFileSystem) private readonly fs: IFileSystem,
        @inject(IJupyterServerUriStorage) private readonly serverUriStorage: IJupyterServerUriStorage
    ) {
        super(
            extensionChecker,
            interpreterService,
            configurationService,
            preferredRemoteFinder,
            notebookProvider,
            localKernelFinder,
            remoteKernelFinder,
            globalState
        );
    }

    protected async isValidCachedKernel(kernel: KernelConnectionMetadata): Promise<boolean> {
        switch (kernel.kind) {
            case 'startUsingRemoteKernelSpec':
            case 'connectToLiveRemoteKernel':
                // If this is a a remote kernel, it's valid if the URI is still active
                const uri = await this.serverUriStorage.getUri();
                return uri.includes(kernel.baseUrl);

            case 'startUsingPythonInterpreter':
                // Interpreters have to still exist
                return this.fs.localFileExists(kernel.interpreter.uri.fsPath);

            case 'startUsingLocalKernelSpec':
                // Spec files have to still exist and interpreters have to exist
                const promiseSpec = kernel.kernelSpec.specFile
                    ? this.fs.localFileExists(kernel.kernelSpec.specFile)
                    : Promise.resolve(true);
                return promiseSpec.then((r) => {
                    return r && kernel.interpreter
                        ? this.fs.localFileExists(kernel.interpreter.uri.fsPath)
                        : Promise.resolve(true);
                });
        }

        return true;
    }
}
