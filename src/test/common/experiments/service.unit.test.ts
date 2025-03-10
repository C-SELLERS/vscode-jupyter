// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import * as tasClient from 'vscode-tas-client';
import { ApplicationEnvironment } from '../../../platform/common/application/applicationEnvironment.node';
import { Channel, IApplicationEnvironment, IWorkspaceService } from '../../../platform/common/application/types';
import { WorkspaceService } from '../../../platform/common/application/workspace';
import { ConfigurationService } from '../../../platform/common/configuration/service.node';
import { ExperimentService } from '../../../platform/common/experiments/service';
import { IConfigurationService } from '../../../platform/common/types';
import * as Telemetry from '../../../telemetry';
import { EventName } from '../../../telemetry/constants';
import { JVSC_EXTENSION_ID_FOR_TESTS } from '../../constants.node';
import { MockOutputChannel } from '../../mockClasses';
import { MockMemento } from '../../mocks/mementos';
suite('Experimentation service', () => {
    const extensionVersion = '1.2.3';

    let configurationService: IConfigurationService;
    let appEnvironment: IApplicationEnvironment;
    let globalMemento: MockMemento;
    let outputChannel: MockOutputChannel;
    let workspace: IWorkspaceService;

    setup(() => {
        configurationService = mock(ConfigurationService);
        appEnvironment = mock(ApplicationEnvironment);
        globalMemento = new MockMemento();
        outputChannel = new MockOutputChannel('');
        workspace = mock(WorkspaceService);
        when(workspace.getConfiguration(anything(), anything())).thenReturn({
            get: () => [],
            has: () => false,
            inspect: () => undefined,
            update: () => Promise.resolve()
        });
    });

    teardown(() => {
        sinon.restore();
        Telemetry._resetSharedProperties();
    });

    function configureSettings(enabled: boolean, optInto: string[], optOutFrom: string[]) {
        when(configurationService.getSettings(undefined)).thenReturn({
            experiments: {
                enabled,
                optInto,
                optOutFrom
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
    }

    function configureApplicationEnvironment(channel: Channel, version: string) {
        when(appEnvironment.channel).thenReturn(channel);
        when(appEnvironment.extensionName).thenReturn(JVSC_EXTENSION_ID_FOR_TESTS);
        when(appEnvironment.packageJson).thenReturn({ version });
    }

    suite('Initialization', () => {
        test('Users with a release version of the extension should be in the Public target population', () => {
            const getExperimentationServiceStub = sinon.stub(tasClient, 'getExperimentationService');

            configureSettings(true, [], []);
            configureApplicationEnvironment('stable', extensionVersion);

            // eslint-disable-next-line @typescript-eslint/no-unused-expressions
            new ExperimentService(
                instance(configurationService),
                instance(appEnvironment),
                globalMemento,
                outputChannel
            );

            sinon.assert.calledWithExactly(
                getExperimentationServiceStub,
                JVSC_EXTENSION_ID_FOR_TESTS,
                extensionVersion,
                tasClient.TargetPopulation.Public,
                sinon.match.any,
                globalMemento
            );
        });

        test('Users with an Insiders version of the extension should be the Insiders target population', () => {
            const getExperimentationServiceStub = sinon.stub(tasClient, 'getExperimentationService');

            configureSettings(true, [], []);
            configureApplicationEnvironment('insiders', extensionVersion);

            // eslint-disable-next-line @typescript-eslint/no-unused-expressions
            new ExperimentService(
                instance(configurationService),
                instance(appEnvironment),
                globalMemento,
                outputChannel
            );

            sinon.assert.calledWithExactly(
                getExperimentationServiceStub,
                JVSC_EXTENSION_ID_FOR_TESTS,
                extensionVersion,
                tasClient.TargetPopulation.Insiders,
                sinon.match.any,
                globalMemento
            );
        });

        test('Users can only opt into experiment groups', () => {
            sinon.stub(tasClient, 'getExperimentationService');

            configureSettings(true, ['Foo - experiment', 'Bar - control'], []);
            configureApplicationEnvironment('stable', extensionVersion);

            const experimentService = new ExperimentService(
                instance(configurationService),
                instance(appEnvironment),
                globalMemento,
                outputChannel
            );

            assert.deepEqual(experimentService._optInto, ['Foo - experiment']);
        });

        test('Users can only opt out of experiment groups', () => {
            sinon.stub(tasClient, 'getExperimentationService');
            configureSettings(true, [], ['Foo - experiment', 'Bar - control']);
            configureApplicationEnvironment('stable', extensionVersion);

            const experimentService = new ExperimentService(
                instance(configurationService),
                instance(appEnvironment),
                globalMemento,
                outputChannel
            );

            assert.deepEqual(experimentService._optOutFrom, ['Foo - experiment']);
        });
    });

    suite('In-experiment check', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const experiment: any = 'Test Experiment - experiment';
        let telemetryEvents: { eventName: string; properties: object | undefined }[] = [];
        let isCachedFlightEnabledStub: sinon.SinonStub;
        let sendTelemetryEventStub: sinon.SinonStub;

        setup(() => {
            sendTelemetryEventStub = sinon
                .stub(Telemetry, 'sendTelemetryEvent')
                .callsFake((eventName: string, _, properties: object | undefined) => {
                    const telemetry = { eventName, properties };
                    telemetryEvents.push(telemetry);
                });

            isCachedFlightEnabledStub = sinon.stub().returns(Promise.resolve(true));
            sinon.stub(tasClient, 'getExperimentationService').returns({
                isCachedFlightEnabled: isCachedFlightEnabledStub
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any);

            configureApplicationEnvironment('stable', extensionVersion);
        });

        teardown(() => {
            telemetryEvents = [];
        });

        test('If the opt-in and opt-out arrays are empty, return the value from the experimentation framework for a given experiment', async () => {
            configureSettings(true, [], []);

            const experimentService = new ExperimentService(
                instance(configurationService),
                instance(appEnvironment),
                globalMemento,
                outputChannel
            );
            const result = await experimentService.inExperiment(experiment);

            assert.isTrue(result);
            sinon.assert.notCalled(sendTelemetryEventStub);
            sinon.assert.calledOnce(isCachedFlightEnabledStub);
        });

        test('If the experiment setting is disabled, inExperiment should return false', async () => {
            configureSettings(false, [], []);

            const experimentService = new ExperimentService(
                instance(configurationService),
                instance(appEnvironment),
                globalMemento,
                outputChannel
            );
            const result = await experimentService.inExperiment(experiment);

            assert.isFalse(result);
            sinon.assert.notCalled(sendTelemetryEventStub);
            sinon.assert.notCalled(isCachedFlightEnabledStub);
        });

        test('If the opt-in setting contains the experiment name, inExperiment should return true', async () => {
            configureSettings(true, [experiment], []);

            const experimentService = new ExperimentService(
                instance(configurationService),
                instance(appEnvironment),
                globalMemento,
                outputChannel
            );
            const result = await experimentService.inExperiment(experiment);

            assert.isTrue(result);
            assert.equal(telemetryEvents.length, 1);
            assert.deepEqual(telemetryEvents[0], {
                eventName: EventName.JUPYTER_EXPERIMENTS_OPT_IN_OUT,
                properties: { expNameOptedInto: experiment }
            });
            sinon.assert.calledOnce(isCachedFlightEnabledStub);
        });

        test('If the opt-out setting contains the experiment name, inExperiment should return false', async () => {
            configureSettings(true, [], [experiment]);

            const experimentService = new ExperimentService(
                instance(configurationService),
                instance(appEnvironment),
                globalMemento,
                outputChannel
            );
            const result = await experimentService.inExperiment(experiment);

            assert.isFalse(result);
            assert.equal(telemetryEvents.length, 1);
            assert.deepEqual(telemetryEvents[0], {
                eventName: EventName.JUPYTER_EXPERIMENTS_OPT_IN_OUT,
                properties: { expNameOptedOutOf: experiment }
            });
            sinon.assert.notCalled(isCachedFlightEnabledStub);
        });
    });

    suite('Experiment value retrieval', () => {
        const experiment = 'Test Experiment - experiment';
        let getTreatmentVariableAsyncStub: sinon.SinonStub;

        setup(() => {
            getTreatmentVariableAsyncStub = sinon.stub().returns(Promise.resolve('value'));
            sinon.stub(tasClient, 'getExperimentationService').returns({
                getTreatmentVariableAsync: getTreatmentVariableAsyncStub
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any);

            configureApplicationEnvironment('stable', extensionVersion);
        });

        test('If the service is enabled and the opt-out array is empty,return the value from the experimentation framework for a given experiment', async () => {
            configureSettings(true, [], []);

            const experimentService = new ExperimentService(
                instance(configurationService),
                instance(appEnvironment),
                globalMemento,
                outputChannel
            );
            const result = await experimentService.getExperimentValue(experiment);

            assert.equal(result, 'value');
            sinon.assert.calledOnce(getTreatmentVariableAsyncStub);
        });

        test('If the experiment setting is disabled, getExperimentValue should return undefined', async () => {
            configureSettings(false, [], []);

            const experimentService = new ExperimentService(
                instance(configurationService),
                instance(appEnvironment),
                globalMemento,
                outputChannel
            );
            const result = await experimentService.getExperimentValue(experiment);

            assert.isUndefined(result);
            sinon.assert.notCalled(getTreatmentVariableAsyncStub);
        });

        test('If the opt-out setting contains the experiment name, igetExperimentValue should return undefined', async () => {
            configureSettings(true, [], [experiment]);

            const experimentService = new ExperimentService(
                instance(configurationService),
                instance(appEnvironment),
                globalMemento,
                outputChannel
            );
            const result = await experimentService.getExperimentValue(experiment);

            assert.isUndefined(result);
            sinon.assert.notCalled(getTreatmentVariableAsyncStub);
        });
    });
});
