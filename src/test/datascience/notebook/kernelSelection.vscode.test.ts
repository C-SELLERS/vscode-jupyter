// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { assert } from 'chai';
import * as fs from 'fs-extra';
import * as path from '../../../platform/vscode-path/path';
import * as sinon from 'sinon';
import { commands, Uri, window } from 'vscode';
import { IPythonExtensionChecker } from '../../../platform/api/types';
import { IVSCodeNotebook } from '../../../platform/common/application/types';
import { BufferDecoder } from '../../../platform/common/process/decoder.node';
import { ProcessService } from '../../../platform/common/process/proc.node';
import { IDisposable } from '../../../platform/common/types';
import { IKernelProvider } from '../../../platform/../kernels/types';
import { IInterpreterService } from '../../../platform/interpreter/contracts';
import {
    getInterpreterHash,
    getNormalizedInterpreterPath
} from '../../../platform/pythonEnvironments/info/interpreter';
import { createEventHandler, IExtensionTestApi, waitForCondition } from '../../common.node';
import { EXTENSION_ROOT_DIR_FOR_TESTS, IS_REMOTE_NATIVE_TEST } from '../../constants.node';
import { closeActiveWindows, initialize, IS_CI_SERVER } from '../../initialize.node';
import { openNotebook } from '../helpers';
import {
    closeNotebooksAndCleanUpAfterTests,
    createEmptyPythonNotebook,
    createTemporaryNotebook,
    runAllCellsInActiveNotebook,
    insertCodeCell,
    startJupyterServer,
    waitForExecutionCompletedSuccessfully,
    waitForKernelToChange,
    waitForKernelToGetAutoSelected,
    waitForOutputs,
    waitForTextOutput,
    defaultNotebookTestTimeout
} from './helper.node';
import { getTextOutputValue } from '../../../notebooks/helpers';
import { getOSType, OSType } from '../../../platform/common/utils/platform';

/* eslint-disable no-invalid-this, , , @typescript-eslint/no-explicit-any */
suite('DataScience - VSCode Notebook - Kernel Selection', function () {
    const disposables: IDisposable[] = [];
    const templateIPynbFile = path.join(
        EXTENSION_ROOT_DIR_FOR_TESTS,
        'src/test/datascience/notebook/nbWithKernel.ipynb'
    );
    const executable = getOSType() === OSType.Windows ? 'Scripts/python.exe' : 'bin/python'; // If running locally on Windows box.
    const venvNoKernelPython = Uri.file(
        path.join(EXTENSION_ROOT_DIR_FOR_TESTS, 'src/test/datascience/.venvnokernel', executable)
    );
    const venvKernelPython = Uri.file(
        path.join(EXTENSION_ROOT_DIR_FOR_TESTS, 'src/test/datascience/.venvkernel', executable)
    );
    const venvNoRegPath = Uri.file(
        path.join(EXTENSION_ROOT_DIR_FOR_TESTS, 'src/test/datascience/.venvnoreg', executable)
    );

    let nbFile1: string;
    let api: IExtensionTestApi;
    let activeInterpreterPath: Uri;
    let venvNoKernelPythonPath: Uri;
    let venvKernelPythonPath: Uri;
    let venvNoRegPythonPath: Uri;
    let venvNoKernelDisplayName: string;
    let kernelProvider: IKernelProvider;
    const venvNoKernelSearchString = '.venvnokernel';
    const venvKernelSearchString = '.venvkernel';
    const venvNoRegSearchString = '.venvnoreg';
    let activeInterpreterSearchString = '';
    let vscodeNotebook: IVSCodeNotebook;
    this.timeout(120_000); // Slow test, we need to uninstall/install ipykernel.
    /*
    This test requires a virtual environment to be created & registered as a kernel.
    It also needs to have ipykernel installed in it.
    */
    suiteSetup(async function () {
        this.timeout(120_000);
        // These are slow tests, hence lets run only on linux on CI.
        if (
            (IS_CI_SERVER && getOSType() !== OSType.Linux) ||
            !fs.pathExistsSync(venvNoKernelPython.fsPath) ||
            !fs.pathExistsSync(venvKernelPython.fsPath) ||
            !fs.pathExistsSync(venvNoRegPath.fsPath)
        ) {
            // Virtual env does not exist.
            return this.skip();
        }
        api = await initialize();

        const pythonChecker = api.serviceContainer.get<IPythonExtensionChecker>(IPythonExtensionChecker);
        vscodeNotebook = api.serviceContainer.get<IVSCodeNotebook>(IVSCodeNotebook);
        kernelProvider = api.serviceContainer.get<IKernelProvider>(IKernelProvider);

        if (!pythonChecker.isPythonExtensionInstalled) {
            return this.skip();
        }

        const interpreterService = api.serviceContainer.get<IInterpreterService>(IInterpreterService);
        // Wait for all interpreters so we can make sure we can get details on the paths we have
        await interpreterService.getInterpreters();
        const [activeInterpreter, interpreter1, interpreter2, interpreter3] = await Promise.all([
            interpreterService.getActiveInterpreter(),
            interpreterService.getInterpreterDetails(venvNoKernelPython),
            interpreterService.getInterpreterDetails(venvKernelPython),
            interpreterService.getInterpreterDetails(venvNoRegPath)
        ]);
        if (!activeInterpreter || !interpreter1 || !interpreter2 || !interpreter3) {
            throw new Error('Unable to get information for interpreter 1');
        }
        activeInterpreterPath = activeInterpreter?.uri;
        venvNoKernelPythonPath = interpreter1.uri;
        venvKernelPythonPath = interpreter2.uri;
        venvNoRegPythonPath = interpreter3.uri;
        venvNoKernelDisplayName = interpreter1.displayName || '.venvnokernel';
        activeInterpreterSearchString =
            activeInterpreter.displayName === interpreter1.displayName
                ? venvNoKernelSearchString
                : activeInterpreter.displayName === interpreter2.displayName
                ? venvKernelSearchString
                : activeInterpreter.displayName === interpreter3.displayName
                ? venvNoRegSearchString
                : activeInterpreterPath.fsPath;

        // Ensure IPykernel is in all environments.
        const proc = new ProcessService(new BufferDecoder());
        await Promise.all([
            proc.exec(venvNoKernelPython.fsPath, ['-m', 'pip', 'install', 'ipykernel']),
            proc.exec(venvKernelPython.fsPath, ['-m', 'pip', 'install', 'ipykernel']),
            proc.exec(venvNoRegPythonPath.fsPath, ['-m', 'pip', 'install', 'ipykernel'])
        ]);

        await startJupyterServer();
        sinon.restore();
    });

    setup(async function () {
        console.log(`Start test ${this.currentTest?.title}`);
        // Don't use same file (due to dirty handling, we might save in dirty.)
        // Coz we won't save to file, hence extension will backup in dirty file and when u re-open it will open from dirty.
        nbFile1 = await createTemporaryNotebook(templateIPynbFile, disposables, venvNoKernelDisplayName);
        // Update hash in notebook metadata.
        fs.writeFileSync(
            nbFile1,
            fs
                .readFileSync(nbFile1)
                .toString('utf8')
                .replace('<hash>', getInterpreterHash({ uri: venvNoKernelPythonPath }))
        );
        await closeActiveWindows();
        sinon.restore();
        console.log(`Start Test completed ${this.currentTest?.title}`);
    });
    teardown(async function () {
        console.log(`End test ${this.currentTest?.title}`);
        await closeNotebooksAndCleanUpAfterTests(disposables);
        console.log(`End test completed ${this.currentTest?.title}`);
    });

    test('Ensure we select active interpreter as kernel (when Raw Kernels)', async function () {
        if (IS_REMOTE_NATIVE_TEST) {
            return this.skip();
        }
        await createEmptyPythonNotebook(disposables);
        await insertCodeCell('import sys\nsys.executable', { index: 0 });

        // Run all cells
        const cell = vscodeNotebook.activeNotebookEditor?.document.cellAt(0)!;
        await Promise.all([runAllCellsInActiveNotebook(), waitForExecutionCompletedSuccessfully(cell)]);

        await waitForCondition(
            async () => {
                // Confirm the executable printed as a result of code in cell `import sys;sys.executable`
                const output = getTextOutputValue(cell.outputs[0]);
                if (
                    !output.includes(activeInterpreterSearchString) &&
                    !output.includes(getNormalizedInterpreterPath(activeInterpreterPath).fsPath) &&
                    !output.includes(activeInterpreterPath.fsPath)
                ) {
                    assert.fail(
                        output,
                        `Expected ${getNormalizedInterpreterPath(activeInterpreterPath)} or ${activeInterpreterPath}`,
                        `Interpreter does not match for ${activeInterpreterSearchString}: expected ${getNormalizedInterpreterPath(
                            activeInterpreterPath
                        )} or ${activeInterpreterPath}, but go ${output}`
                    );
                }
                return true;
            },
            defaultNotebookTestTimeout,
            `Interpreter does not match for ${activeInterpreterSearchString}: expected ${getNormalizedInterpreterPath(
                activeInterpreterPath
            )} or ${activeInterpreterPath}, but go ${getTextOutputValue(cell.outputs[0])}`
        );
    });
    test('Ensure kernel is auto selected and interpreter is as expected', async function () {
        if (IS_REMOTE_NATIVE_TEST) {
            return this.skip();
        }
        await openNotebook(nbFile1);
        await waitForKernelToGetAutoSelected(undefined);

        // Run all cells
        const cell = vscodeNotebook.activeNotebookEditor?.document.cellAt(0)!;
        await Promise.all([
            runAllCellsInActiveNotebook(),
            waitForExecutionCompletedSuccessfully(cell),
            // Confirm the executable printed as a result of code in cell `import sys;sys.executable`
            waitForTextOutput(cell, venvNoKernelSearchString, 0, false)
        ]);
    });
    test('Ensure we select a Python kernel for a nb with python language information', async function () {
        if (IS_REMOTE_NATIVE_TEST) {
            return this.skip();
        }
        await createEmptyPythonNotebook(disposables);

        // Run all cells
        await insertCodeCell('import sys\nsys.executable', { index: 0 });
        await insertCodeCell('print("Hello World")', { index: 1 });

        const cell1 = vscodeNotebook.activeNotebookEditor?.document.cellAt(0)!;
        const cell2 = vscodeNotebook.activeNotebookEditor?.document.getCells()![1]!;

        // If it was successfully selected, then we know a Python kernel was correctly selected & managed to run the code.
        await Promise.all([
            runAllCellsInActiveNotebook(),
            waitForExecutionCompletedSuccessfully(cell1),
            waitForExecutionCompletedSuccessfully(cell2)
        ]);
        await waitForTextOutput(cell2, 'Hello World', 0, false);
    });
    test('User kernelspec in notebook metadata', async function () {
        if (IS_REMOTE_NATIVE_TEST) {
            return this.skip();
        }
        await openNotebook(nbFile1);
        await waitForKernelToGetAutoSelected(undefined);

        // Run all cells
        const cell = vscodeNotebook.activeNotebookEditor?.document.cellAt(0)!;
        await Promise.all([
            runAllCellsInActiveNotebook(),
            waitForExecutionCompletedSuccessfully(cell),
            // Confirm the executable printed as a result of code in cell `import sys;sys.executable`
            waitForTextOutput(cell, venvNoKernelSearchString, 0, false)
        ]);

        // Change kernel
        await waitForKernelToChange({ interpreterPath: venvKernelPythonPath });

        // Clear the cells & execute again
        await commands.executeCommand('notebook.clearAllCellsOutputs');
        await waitForCondition(async () => cell.outputs.length === 0, 5_000, 'Cell did not get cleared');
        await Promise.all([runAllCellsInActiveNotebook(), waitForExecutionCompletedSuccessfully(cell)]);

        // Confirm the executable printed as a result of code in cell `import sys;sys.executable`
        await waitForTextOutput(cell, venvKernelSearchString, 0, false);
    });
    test('Switch kernel to an interpreter that is registered as a kernel', async function () {
        if (IS_REMOTE_NATIVE_TEST) {
            return this.skip();
        }
        await createEmptyPythonNotebook(disposables);
        await insertCodeCell('import sys\nsys.executable', { index: 0 });

        // Run all cells
        const cell = vscodeNotebook.activeNotebookEditor?.document.cellAt(0)!;
        await Promise.all([
            runAllCellsInActiveNotebook(),
            waitForExecutionCompletedSuccessfully(cell),
            waitForOutputs(cell, 1)
        ]);

        // Confirm the executable printed is not venvkernel
        assert.ok(cell.outputs.length);
        const outputText = getTextOutputValue(cell.outputs[0]).trim();

        // venvkernel might be the active one (if this test is run more than once)
        if (activeInterpreterSearchString !== venvKernelSearchString) {
            assert.equal(outputText.toLowerCase().indexOf(venvKernelSearchString), -1);
        }

        // Very this kernel gets disposed when we switch the notebook kernel.
        const kernel = kernelProvider.get(window.activeNotebookEditor!.document.uri)!;
        assert.ok(kernel, 'Kernel is not defined');
        const eventListener = createEventHandler(kernel, 'onDisposed');

        // Change kernel to the interpreter venvkernel
        await waitForKernelToChange({ interpreterPath: venvKernelPythonPath });

        // Verify the old kernel is disposed.
        await eventListener.assertFired(5_000);

        // Clear the cells & execute again
        await commands.executeCommand('notebook.clearAllCellsOutputs');
        await waitForCondition(async () => cell.outputs.length === 0, 5_000, 'Cell did not get cleared');
        await Promise.all([
            runAllCellsInActiveNotebook(),
            waitForExecutionCompletedSuccessfully(cell),
            // Confirm the executable printed as a result of code in cell `import sys;sys.executable`
            waitForTextOutput(cell, venvKernelSearchString, 0, false)
        ]);

        // Verify the new kernel is not the same as the old.
        assert.isFalse(
            kernel === kernelProvider.get(window.activeNotebookEditor!.document.uri),
            'Kernels should not be the same'
        );
    });
    test('Switch kernel to an interpreter that is not registered as a kernel', async function () {
        if (IS_REMOTE_NATIVE_TEST) {
            return this.skip();
        }
        await createEmptyPythonNotebook(disposables);
        await insertCodeCell('import sys\nsys.executable', { index: 0 });

        // Run all cells
        const cell = vscodeNotebook.activeNotebookEditor?.document.cellAt(0)!;
        await Promise.all([
            runAllCellsInActiveNotebook(),
            waitForExecutionCompletedSuccessfully(cell),
            waitForOutputs(cell, 1)
        ]);

        // Confirm the executable printed is not venvNoReg
        assert.ok(cell.outputs.length);
        const outputText = getTextOutputValue(cell.outputs[0]).trim();
        assert.equal(outputText.toLowerCase().indexOf(venvNoRegSearchString), -1);

        // Change kernel to the interpreter venvNoReg
        await waitForKernelToChange({ interpreterPath: venvNoRegPythonPath });

        // Clear the cells & execute again
        void commands.executeCommand('notebook.clearAllCellsOutputs');
        await waitForCondition(async () => cell.outputs.length === 0, 5_000, 'Cell did not get cleared');
        await Promise.all([
            runAllCellsInActiveNotebook(),
            waitForExecutionCompletedSuccessfully(cell),
            // Confirm the executable printed as a result of code in cell `import sys;sys.executable`
            waitForTextOutput(cell, venvNoRegSearchString, 0, false)
        ]);
    });
});
