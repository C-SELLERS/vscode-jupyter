/* eslint-disable local-rules/dont-use-filename */
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires, , , @typescript-eslint/no-explicit-any, prefer-template, no-console */
// Most of the source is in node_modules/vscode/lib/testrunner.js

'use strict';
import * as glob from 'glob';
import * as Mocha from 'mocha';
import * as path from '../platform/vscode-path/path';
import { IS_SMOKE_TEST, MAX_EXTENSION_ACTIVATION_TIME } from './constants.node';
import { noop } from './core';
import { stopJupyterServer } from './datascience/notebook/helper.node';
import { initialize } from './initialize.node';

// Linux: prevent a weird NPE when mocha on Linux requires the window size from the TTY.
// Since we are not running in a tty environment, we just implement the method statically.
const tty = require('tty');
if (!tty.getWindowSize) {
    tty.getWindowSize = function (): number[] {
        return [80, 75];
    };
}

let mocha = new Mocha(<any>{
    ui: 'tdd',
    colors: true
});

export type SetupOptions = Mocha.MochaOptions & {
    testFilesSuffix?: string;
    reporterOptions?: {
        mochaFile?: string;
        properties?: string;
    };
};

let testFilesGlob = 'test';

export function configure(setupOptions: SetupOptions): void {
    if (setupOptions.testFilesSuffix) {
        testFilesGlob = setupOptions.testFilesSuffix;
    }
    // Force Mocha to exit.
    (setupOptions as any).exit = true;
    mocha = new Mocha(setupOptions);
}

export async function run(): Promise<void> {
    const testsRoot = path.join(__dirname);
    // Enable source map support.
    require('source-map-support').install();

    // nteract/transforms-full expects to run in the browser so we have to fake
    // parts of the browser here.
    if (!IS_SMOKE_TEST) {
        const reactHelpers = require('./datascience/reactHelpers') as typeof import('./datascience/reactHelpers');
        reactHelpers.setUpDomEnvironment();
    }

    /**
     * Waits until the Python Extension completes loading or a timeout.
     * When running tests within VSC, we need to wait for the Python Extension to complete loading,
     * this is where `initialize` comes in, we load the PVSC extension using VSC API, wait for it
     * to complete.
     * That's when we know out PVSC extension specific code is ready for testing.
     * So, this code needs to run always for every test running in VS Code (what we call these `system test`) .
     * @returns
     */
    function initializationScript() {
        const ex = new Error('Failed to initialize Python extension for tests after 3 minutes');
        let timer: NodeJS.Timer | undefined;
        const failed = new Promise((_, reject) => {
            timer = setTimeout(() => reject(ex), MAX_EXTENSION_ACTIVATION_TIME);
        });
        const promise = Promise.race([initialize(), failed]);
        promise.then(() => clearTimeout(timer!)).catch(() => clearTimeout(timer!));
        return promise;
    }
    // Run the tests.
    await new Promise<void>((resolve, reject) => {
        glob(
            `**/**.${testFilesGlob}.js`,
            { ignore: ['**/**.unit.test.js', '**/**.functional.test.js'], cwd: testsRoot },
            (error, files) => {
                if (error) {
                    return reject(error);
                }
                try {
                    files.forEach((file) => mocha.addFile(path.join(testsRoot, file)));
                    initializationScript()
                        .then(() =>
                            mocha.run((failures) =>
                                failures > 0 ? reject(new Error(`${failures} total failures`)) : resolve()
                            )
                        )
                        .finally(() => {
                            stopJupyterServer().catch(noop);
                        })
                        .catch(reject);
                } catch (error) {
                    return reject(error);
                }
            }
        );
    });
}
