// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

/* eslint-disable no-invalid-this, no-console */

import { expect } from 'chai';
import * as fs from 'fs-extra';
import { EOL } from 'os';
import * as path from '../../platform/vscode-path/path';
import { commands, extensions } from 'vscode';
import { JVSC_EXTENSION_ID } from '../../platform/common/constants';
import { StopWatch } from '../../platform/common/utils/stopWatch';
import {
    ACTIVATION_TIMES_DEV_LANGUAGE_SERVER_LOG_FILE_PATHS,
    ACTIVATION_TIMES_DEV_LOG_FILE_PATHS,
    ACTIVATION_TIMES_EXT_VERSION,
    ACTIVATION_TIMES_LOG_FILE_PATH,
    ACTIVATION_TIMES_RELEASE_LOG_FILE_PATHS
} from './constants.node';

const AllowedIncreaseInActivationDelayInMS = 500;

suite('Activation Times', () => {
    if (ACTIVATION_TIMES_LOG_FILE_PATH) {
        const logFile = ACTIVATION_TIMES_LOG_FILE_PATH;
        const sampleCounter = fs.existsSync(logFile)
            ? fs.readFileSync(logFile, { encoding: 'utf8' }).toString().split(/\r?\n/g).length
            : 1;
        if (sampleCounter > 5) {
            return;
        }
        test(`Capture Extension Activation Times (Version: ${ACTIVATION_TIMES_EXT_VERSION}, sample: ${sampleCounter})`, async () => {
            const pythonExtension = extensions.getExtension(JVSC_EXTENSION_ID);
            if (!pythonExtension) {
                throw new Error('Python Extension not found');
            }
            const stopWatch = new StopWatch();
            await pythonExtension!.activate();
            const elapsedTime = stopWatch.elapsedTime;
            if (elapsedTime > 10) {
                await fs.ensureDir(path.dirname(logFile));
                await fs.appendFile(logFile, `${elapsedTime}${EOL}`, { encoding: 'utf8' });
                console.log(`Loaded in ${elapsedTime}ms`);
            }
            await commands.executeCommand('workbench.action.reloadWindow');
        });
    }

    if (
        ACTIVATION_TIMES_DEV_LOG_FILE_PATHS &&
        ACTIVATION_TIMES_RELEASE_LOG_FILE_PATHS &&
        ACTIVATION_TIMES_DEV_LANGUAGE_SERVER_LOG_FILE_PATHS
    ) {
        test('Test activation times of Dev vs Release Extension', async () => {
            function getActivationTimes(files: string[]) {
                const activationTimes: number[] = [];
                for (const file of files) {
                    fs.readFileSync(file, { encoding: 'utf8' })
                        .toString()
                        .split(/\r?\n/g)
                        .map((line) => line.trim())
                        .filter((line) => line.length > 0)
                        .map((line) => parseInt(line, 10))
                        .forEach((item) => activationTimes.push(item));
                }
                return activationTimes;
            }
            const devActivationTimes = getActivationTimes(JSON.parse(ACTIVATION_TIMES_DEV_LOG_FILE_PATHS!));
            const releaseActivationTimes = getActivationTimes(JSON.parse(ACTIVATION_TIMES_RELEASE_LOG_FILE_PATHS!));
            const languageServerActivationTimes = getActivationTimes(
                JSON.parse(ACTIVATION_TIMES_DEV_LANGUAGE_SERVER_LOG_FILE_PATHS!)
            );
            const devActivationAvgTime =
                devActivationTimes.reduce((sum, item) => sum + item, 0) / devActivationTimes.length;
            const releaseActivationAvgTime =
                releaseActivationTimes.reduce((sum, item) => sum + item, 0) / releaseActivationTimes.length;
            const languageServerActivationAvgTime =
                languageServerActivationTimes.reduce((sum, item) => sum + item, 0) /
                languageServerActivationTimes.length;

            console.log(`Dev version loaded in ${devActivationAvgTime}ms`);
            console.log(`Release version loaded in ${releaseActivationAvgTime}ms`);
            console.log(`Language server loaded in ${languageServerActivationAvgTime}ms`);

            expect(devActivationAvgTime - releaseActivationAvgTime).to.be.lessThan(
                AllowedIncreaseInActivationDelayInMS,
                'Activation times have increased above allowed threshold.'
            );
        });
    }
});
