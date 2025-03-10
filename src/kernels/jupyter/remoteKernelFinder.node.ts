// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import { Kernel } from '@jupyterlab/services';
import * as url from 'url';
import { injectable, inject } from 'inversify';
import { CancellationToken, Uri } from 'vscode';
import { getKernelId } from '../helpers';
import {
    IJupyterKernelSpec,
    INotebookProviderConnection,
    KernelConnectionMetadata,
    LiveRemoteKernelConnectionMetadata,
    RemoteKernelSpecConnectionMetadata
} from '../types';
import { IDisposableRegistry, Resource } from '../../platform/common/types';
import { IInterpreterService } from '../../platform/interpreter/contracts';
import { captureTelemetry } from '../../telemetry';
import { Telemetry } from '../../webviews/webview-side/common/constants';
import { IRemoteKernelFinder } from '../raw/types';
import { IJupyterSessionManagerFactory, IJupyterSessionManager } from './types';
import { sendKernelSpecTelemetry } from '../raw/finder/helper';

// This class searches for a kernel that matches the given kernel name.
// First it searches on a global persistent state, then on the installed python interpreters,
// and finally on the default locations that jupyter installs kernels on.
@injectable()
export class RemoteKernelFinder implements IRemoteKernelFinder {
    /**
     * List of ids of kernels that should be hidden from the kernel picker.
     */
    private readonly kernelIdsToHide = new Set<string>();
    constructor(
        @inject(IDisposableRegistry) disposableRegistry: IDisposableRegistry,
        @inject(IJupyterSessionManagerFactory) private jupyterSessionManagerFactory: IJupyterSessionManagerFactory,
        @inject(IInterpreterService) private interpreterService: IInterpreterService
    ) {
        disposableRegistry.push(
            this.jupyterSessionManagerFactory.onRestartSessionCreated(this.addKernelToIgnoreList.bind(this))
        );
        disposableRegistry.push(
            this.jupyterSessionManagerFactory.onRestartSessionUsed(this.removeKernelFromIgnoreList.bind(this))
        );
    }

    // Talk to the remote server to determine sessions
    @captureTelemetry(Telemetry.KernelListingPerf, { kind: 'remote' })
    public async listKernels(
        _resource: Resource,
        connInfo: INotebookProviderConnection | undefined,
        _cancelToken: CancellationToken
    ): Promise<KernelConnectionMetadata[]> {
        // Get a jupyter session manager to talk to
        let sessionManager: IJupyterSessionManager | undefined;

        // This should only be used when doing remote.
        if (connInfo && connInfo.type === 'jupyter') {
            try {
                sessionManager = await this.jupyterSessionManagerFactory.create(connInfo);

                // Get running and specs at the same time
                const [running, specs, sessions] = await Promise.all([
                    sessionManager.getRunningKernels(),
                    sessionManager.getKernelSpecs(),
                    sessionManager.getRunningSessions()
                ]);

                // Turn them both into a combined list
                const mappedSpecs = await Promise.all(
                    specs.map(async (s) => {
                        sendKernelSpecTelemetry(s, 'remote');
                        const kernel: RemoteKernelSpecConnectionMetadata = {
                            kind: 'startUsingRemoteKernelSpec',
                            interpreter: await this.getInterpreter(s, connInfo.baseUrl),
                            kernelSpec: s,
                            id: getKernelId(s, undefined, connInfo.baseUrl),
                            baseUrl: connInfo.baseUrl
                        };
                        return kernel;
                    })
                );
                const mappedLive = sessions.map((s) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const liveKernel = s.kernel as any;
                    const lastActivityTime = liveKernel.last_activity
                        ? new Date(Date.parse(liveKernel.last_activity.toString()))
                        : new Date();
                    const numberOfConnections = liveKernel.connections
                        ? parseInt(liveKernel.connections.toString(), 10)
                        : 0;
                    const activeKernel = running.find((active) => active.id === s.kernel?.id) || {};
                    const matchingSpec: Partial<IJupyterKernelSpec> =
                        specs.find((spec) => spec.name === s.kernel?.name) || {};

                    const kernel: LiveRemoteKernelConnectionMetadata = {
                        kind: 'connectToLiveRemoteKernel',
                        kernelModel: {
                            ...s.kernel,
                            ...matchingSpec,
                            ...activeKernel,
                            name: s.kernel?.name || '',
                            lastActivityTime,
                            numberOfConnections,
                            model: s
                        },
                        baseUrl: connInfo.baseUrl,
                        id: s.kernel?.id || ''
                    };
                    return kernel;
                });

                // Filter out excluded ids
                const filtered = mappedLive.filter((k) => !this.kernelIdsToHide.has(k.kernelModel.id || ''));
                const items = [...filtered, ...mappedSpecs];
                return items;
            } finally {
                if (sessionManager) {
                    await sessionManager.dispose();
                }
            }
        }
        return [];
    }

    /**
     * Ensure kernels such as those associated with the restart session are not displayed in the kernel picker.
     */
    private addKernelToIgnoreList(kernel: Kernel.IKernelConnection): void {
        this.kernelIdsToHide.add(kernel.id);
        this.kernelIdsToHide.add(kernel.clientId);
    }
    /**
     * Opposite of the add counterpart.
     */
    private removeKernelFromIgnoreList(kernel: Kernel.IKernelConnection): void {
        this.kernelIdsToHide.delete(kernel.id);
        this.kernelIdsToHide.delete(kernel.clientId);
    }

    private async getInterpreter(spec: IJupyterKernelSpec, baseUrl: string) {
        const parsed = new url.URL(baseUrl);
        if (parsed.hostname.toLocaleLowerCase() === 'localhost' || parsed.hostname === '127.0.0.1') {
            // Interpreter is possible. Same machine as VS code
            return this.interpreterService.getInterpreterDetails(Uri.file(spec.argv[0]));
        }
    }
}
