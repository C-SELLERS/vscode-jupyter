// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { inject, injectable } from 'inversify';
import { JupyterCommandLineSelector } from '../../kernels/jupyter/launcher/commandLineSelector.node';
import { ICommandManager } from '../../platform/common/application/types';
import { IDisposable } from '../../platform/common/types';
import { Commands } from '../common/constants';

@injectable()
export class JupyterCommandLineSelectorCommand implements IDisposable {
    private readonly disposables: IDisposable[] = [];
    constructor(
        @inject(ICommandManager) private readonly commandManager: ICommandManager,
        @inject(JupyterCommandLineSelector) private readonly commandSelector: JupyterCommandLineSelector
    ) {}
    public register() {
        this.disposables.push(
            this.commandManager.registerCommand(
                Commands.SelectJupyterCommandLine,
                this.commandSelector.selectJupyterCommandLine,
                this.commandSelector
            )
        );
    }
    public dispose() {
        this.disposables.forEach((d) => d.dispose());
    }
}
