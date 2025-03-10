// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

/* eslint-disable  */

import { expect, use } from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import { FileSystem } from '../../../platform/common/platform/fileSystem.node';
import { EnvironmentVariablesService } from '../../../platform/common/variables/environment.node';
import { IEnvironmentVariablesService } from '../../../platform/common/variables/types';

use(chaiAsPromised);

// Functional tests that run code using the VS Code API are found
// in envVarsService.test.ts.

suite('Environment Variables Service', () => {
    let variablesService: IEnvironmentVariablesService;
    setup(() => {
        const fs = new FileSystem();
        variablesService = new EnvironmentVariablesService(fs);
    });

    suite('parseFile()', () => {
        test('Custom variables should be undefined with no argument', async () => {
            const vars = await variablesService.parseFile(undefined);
            expect(vars).to.equal(undefined, 'Variables should be undefined');
        });
    });
});
