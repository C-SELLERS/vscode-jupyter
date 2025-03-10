// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import { IVariableViewProvider } from '../../../webviews/extension-side/variablesView/types';
import { VariableView } from '../../../webviews/extension-side/variablesView/variableView.node';

export interface ITestVariableViewProvider extends IVariableViewProvider {
    readonly activeVariableView: Promise<VariableView>;
}
