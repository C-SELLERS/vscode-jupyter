// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from '../platform/vscode-path/path';
import { setCI, setTestExecution, setUnitTestExecution } from '../platform/common/constants';
import { IS_CI_SERVER, IS_CI_SERVER_TEST_DEBUGGER } from './ciConstants.node';

// Activating extension for Multiroot and Debugger CI tests for Windows takes just over 2 minutes sometimes, so 3 minutes seems like a safe margin
export const MAX_EXTENSION_ACTIVATION_TIME = 180_000;
export const TEST_TIMEOUT = 25000;
export const TEST_RETRYCOUNT = 0;
export const IS_SMOKE_TEST = process.env.VSC_JUPYTER_SMOKE_TEST === '1';
export const IS_PERF_TEST = process.env.VSC_JUPYTER_PERF_TEST === '1';
export const IS_REMOTE_NATIVE_TEST = (process.env.VSC_JUPYTER_REMOTE_NATIVE_TEST || '').toLowerCase() === 'true';
export const IS_NON_RAW_NATIVE_TEST = (process.env.VSC_JUPYTER_NON_RAW_NATIVE_TEST || '').toLowerCase() === 'true';
export const IS_MULTI_ROOT_TEST = isMultirootTest();
export const IS_CONDA_TEST = (process.env.VSC_JUPYTER_CI_IS_CONDA || '').toLowerCase() === 'true';

// If running on CI server, then run debugger tests ONLY if the corresponding flag is enabled.
export const TEST_DEBUGGER = IS_CI_SERVER ? IS_CI_SERVER_TEST_DEBUGGER : true;

function isMultirootTest() {
    // No need to run smoke nor perf tests in a multi-root environment.
    if (IS_SMOKE_TEST || IS_PERF_TEST) {
        return false;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode');
        const workspace = vscode.workspace;
        return Array.isArray(workspace.workspaceFolders) && workspace.workspaceFolders.length > 1;
    } catch {
        // being accessed, when VS Code hasn't been launched.
        return false;
    }
}

export const EXTENSION_ROOT_DIR_FOR_TESTS = path.join(__dirname, '..', '..');
export const JVSC_EXTENSION_ID_FOR_TESTS = 'ms-toolsai.jupyter';

export const SMOKE_TEST_EXTENSIONS_DIR = path.join(
    EXTENSION_ROOT_DIR_FOR_TESTS,
    'tmp',
    'ext',
    'smokeTestExtensionsFolder'
);

export const IPYTHON_VERSION_CODE = 'import IPython\nprint(int(IPython.__version__[0]))\n';

// Have to set these values in a '.node' based file.
setCI(process.env.TF_BUILD !== undefined || process.env.GITHUB_ACTIONS === 'true');
setTestExecution(process.env.VSC_JUPYTER_CI_TEST === '1');
setUnitTestExecution(process.env.VSC_JUPYTER_UNIT_TEST === '1');
