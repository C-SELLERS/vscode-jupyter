// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { inject, injectable, named } from 'inversify';
import type { Kernel } from '@jupyterlab/services';
import { EventEmitter } from 'vscode';
import { JupyterSessionManager } from './jupyterSessionManager.node';
import { IApplicationShell } from '../../../platform/common/application/types';
import {
    IConfigurationService,
    IOutputChannel,
    IPersistentStateFactory,
    IDisposableRegistry
} from '../../../platform/common/types';
import { JUPYTER_OUTPUT_CHANNEL } from '../../../webviews/webview-side/common/constants';
import { JupyterKernelService } from '../jupyterKernelService.node';
import { IJupyterConnection } from '../../types';
import { IJupyterSessionManagerFactory, IJupyterPasswordConnect, IJupyterSessionManager } from '../types';
import { IFileSystem } from '../../../platform/common/platform/types.node';

@injectable()
export class JupyterSessionManagerFactory implements IJupyterSessionManagerFactory {
    private restartSessionCreatedEvent = new EventEmitter<Kernel.IKernelConnection>();
    private restartSessionUsedEvent = new EventEmitter<Kernel.IKernelConnection>();
    constructor(
        @inject(IJupyterPasswordConnect) private jupyterPasswordConnect: IJupyterPasswordConnect,
        @inject(IConfigurationService) private config: IConfigurationService,
        @inject(IOutputChannel) @named(JUPYTER_OUTPUT_CHANNEL) private jupyterOutput: IOutputChannel,
        @inject(IApplicationShell) private readonly appShell: IApplicationShell,
        @inject(IPersistentStateFactory) private readonly stateFactory: IPersistentStateFactory,
        @inject(IDisposableRegistry) private readonly disposableRegistry: IDisposableRegistry,
        @inject(JupyterKernelService) private readonly kernelService: JupyterKernelService,
        @inject(IFileSystem) private readonly fs: IFileSystem
    ) {}

    /**
     * Creates a new IJupyterSessionManager.
     * @param connInfo - connection information to the server that's already running.
     * @param failOnPassword - whether or not to fail the creation if a password is required.
     */
    public async create(connInfo: IJupyterConnection, failOnPassword?: boolean): Promise<IJupyterSessionManager> {
        const result = new JupyterSessionManager(
            this.jupyterPasswordConnect,
            this.config,
            failOnPassword,
            this.jupyterOutput,
            this.config,
            this.appShell,
            this.stateFactory,
            this.kernelService,
            this.fs
        );
        await result.initialize(connInfo);
        this.disposableRegistry.push(
            result.onRestartSessionCreated(this.restartSessionCreatedEvent.fire.bind(this.restartSessionCreatedEvent))
        );
        this.disposableRegistry.push(
            result.onRestartSessionUsed(this.restartSessionUsedEvent.fire.bind(this.restartSessionUsedEvent))
        );
        return result;
    }

    public get onRestartSessionCreated() {
        return this.restartSessionCreatedEvent.event;
    }

    public get onRestartSessionUsed() {
        return this.restartSessionUsedEvent.event;
    }
}
