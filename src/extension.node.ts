'use strict';

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */

// This line should always be right on top.
/* eslint-disable @typescript-eslint/no-explicit-any */
if ((Reflect as any).metadata === undefined) {
    require('reflect-metadata');
}

// Initialize the logger first.
require('./platform/logging');

//===============================================
// We start tracking the extension's startup time at this point.  The
// locations at which we record various Intervals are marked below in
// the same way as this.

const durations: Record<string, number> = {};
import { StopWatch } from './platform/common/utils/stopWatch';
// Do not move this line of code (used to measure extension load times).
const stopWatch = new StopWatch();

//===============================================
// loading starts here

import {
    commands,
    Disposable,
    env,
    ExtensionMode,
    extensions,
    Memento,
    OutputChannel,
    ProgressLocation,
    ProgressOptions,
    UIKind,
    version,
    window,
    workspace
} from 'vscode';
import * as fsExtra from 'fs-extra';
import * as path from './platform/vscode-path/path';
import { buildApi, IExtensionApi } from './platform/api';
import { IApplicationEnvironment, ICommandManager } from './platform/common/application/types';
import { setHomeDirectory, traceError } from './platform/logging';
import {
    GLOBAL_MEMENTO,
    IAsyncDisposableRegistry,
    IConfigurationService,
    IDisposableRegistry,
    IExperimentService,
    IExtensionContext,
    IFeatureDeprecationManager,
    IMemento,
    IOutputChannel,
    IsCodeSpace,
    IsDevMode,
    IsPreRelease,
    WORKSPACE_MEMENTO
} from './platform/common/types';
import { createDeferred } from './platform/common/utils/async';
import { Common, OutputChannelNames } from './platform/common/utils/localize';
import { IServiceContainer, IServiceManager } from './platform/ioc/types';
import { sendErrorTelemetry, sendStartupTelemetry } from './platform/startupTelemetry';
import { noop } from './platform/common/utils/misc';
import { JUPYTER_OUTPUT_CHANNEL, PythonExtension } from './webviews/webview-side/common/constants';
import { registerTypes as registerPlatformTypes } from './platform/serviceRegistry.node';
import { registerTypes as registerKernelTypes } from './kernels/serviceRegistry.node';
import { registerTypes as registerNotebookTypes } from './notebooks/serviceRegistry.node';
import { registerTypes as registerInteractiveTypes } from './interactive-window/serviceRegistry.node';
import { registerTypes as registerWebviewTypes } from './webviews/extension-side/serviceRegistry.node';
import { registerTypes as registerTelemetryTypes } from './telemetry/serviceRegistry.node';
import { registerTypes as registerIntellisenseTypes } from './intellisense/serviceRegistry.node';
import { IExtensionActivationManager } from './platform/activation/types';
import { isCI, isTestExecution, STANDARD_OUTPUT_CHANNEL } from './platform/common/constants';
import { getDisplayPath } from './platform/common/platform/fs-paths';
import { IFileSystem } from './platform/common/platform/types.node';
import { getJupyterOutputChannel } from './platform/devTools/jupyterOutputChannel';
import { registerLogger, setLoggingLevel } from './platform/logging';
import { setExtensionInstallTelemetryProperties } from './telemetry/extensionInstallTelemetry.node';
import { Container } from 'inversify/lib/container/container';
import { ServiceContainer } from './platform/ioc/container';
import { ServiceManager } from './platform/ioc/serviceManager';
import { OutputChannelLogger } from './platform/logging/outputChannelLogger';
import { ConsoleLogger } from './platform/logging/consoleLogger';
import { FileLogger } from './platform/logging/fileLogger.node';
import { createWriteStream } from 'fs-extra';
import { initializeGlobals as initializeTelemetryGlobals } from './telemetry/telemetry';

durations.codeLoadingTime = stopWatch.elapsedTime;

//===============================================
// loading ends here

// These persist between activations:
let activatedServiceContainer: IServiceContainer | undefined;

/////////////////////////////
// public functions

export async function activate(context: IExtensionContext): Promise<IExtensionApi> {
    try {
        let api: IExtensionApi;
        let ready: Promise<void>;
        let serviceContainer: IServiceContainer;
        [api, ready, serviceContainer] = await activateUnsafe(context, stopWatch, durations);
        // Send the "success" telemetry only if activation did not fail.
        // Otherwise Telemetry is send via the error handler.
        sendStartupTelemetry(ready, durations, stopWatch, serviceContainer)
            // Run in the background.
            .ignoreErrors();
        await ready;
        return api;
    } catch (ex) {
        // We want to completely handle the error
        // before notifying VS Code.
        await handleError(ex, durations);
        traceError('Failed to active the Jupyter Extension', ex);
        // Disable this, as we don't want Python extension or any other extensions that depend on this to fall over.
        // Return a dummy object, to ensure other extension do not fall over.
        return {
            createBlankNotebook: () => Promise.resolve(),
            ready: Promise.resolve(),
            registerPythonApi: noop,
            registerRemoteServerProvider: noop,
            showDataViewer: () => Promise.resolve(),
            getKernelService: () => Promise.resolve(undefined)
        };
    }
}

export function deactivate(): Thenable<void> {
    // Make sure to shutdown anybody who needs it.
    if (activatedServiceContainer) {
        const registry = activatedServiceContainer.get<IAsyncDisposableRegistry>(IAsyncDisposableRegistry);
        if (registry) {
            return registry.dispose();
        }
    }

    return Promise.resolve();
}

/////////////////////////////
// activation helpers

// eslint-disable-next-line
async function activateUnsafe(
    context: IExtensionContext,
    startupStopWatch: StopWatch,
    startupDurations: Record<string, number>
): Promise<[IExtensionApi, Promise<void>, IServiceContainer]> {
    const activationDeferred = createDeferred<void>();
    try {
        displayProgress(activationDeferred.promise);
        startupDurations.startActivateTime = startupStopWatch.elapsedTime;

        //===============================================
        // activation starts here

        const [serviceManager, serviceContainer] = initializeGlobals(context);
        activatedServiceContainer = serviceContainer;
        initializeTelemetryGlobals(serviceContainer);
        const activationPromise = activateComponents(context, serviceManager, serviceContainer);

        //===============================================
        // activation ends here

        startupDurations.endActivateTime = startupStopWatch.elapsedTime;
        activationDeferred.resolve();

        const api = buildApi(activationPromise, serviceManager, serviceContainer, context);
        return [api, activationPromise, serviceContainer];
    } finally {
        // Make sure that we clear our status message
        if (!activationDeferred.completed) {
            activationDeferred.reject();
        }
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function displayProgress(promise: Promise<any>) {
    const progressOptions: ProgressOptions = { location: ProgressLocation.Window, title: Common.loadingExtension() };
    window.withProgress(progressOptions, () => promise).then(noop, noop);
}

/////////////////////////////
// error handling

async function handleError(ex: Error, startupDurations: Record<string, number>) {
    notifyUser(
        "Extension activation failed, run the 'Developer: Toggle Developer Tools' command for more information."
    );
    // Possible logger hasn't initialized either.
    console.error('extension activation failed', ex);
    traceError('extension activation failed', ex);
    await sendErrorTelemetry(ex, startupDurations, activatedServiceContainer);
}

function notifyUser(msg: string) {
    try {
        void window.showErrorMessage(msg);
    } catch (ex) {
        traceError('failed to notify user', ex);
    }
}

async function activateComponents(
    context: IExtensionContext,
    serviceManager: IServiceManager,
    serviceContainer: IServiceContainer
) {
    // We will be pulling code over from activateLegacy().
    return activateLegacy(context, serviceManager, serviceContainer);
}

function addConsoleLogger() {
    if (process.env.VSC_JUPYTER_FORCE_LOGGING) {
        let label = undefined;
        // In CI there's no need for the label.
        if (!isCI) {
            label = 'Jupyter Extension:';
        }

        registerLogger(new ConsoleLogger(label));
    }

    // For tests also log to a file.
    if (isCI && process.env.VSC_JUPYTER_LOG_FILE) {
        const fileLogger = new FileLogger(createWriteStream(process.env.VSC_JUPYTER_LOG_FILE));
        registerLogger(fileLogger);
    }
}

function addOutputChannel(context: IExtensionContext, serviceManager: IServiceManager, isDevMode: boolean) {
    const standardOutputChannel = window.createOutputChannel(OutputChannelNames.jupyter());
    registerLogger(new OutputChannelLogger(standardOutputChannel));
    serviceManager.addSingletonInstance<OutputChannel>(IOutputChannel, standardOutputChannel, STANDARD_OUTPUT_CHANNEL);
    serviceManager.addSingletonInstance<OutputChannel>(
        IOutputChannel,
        getJupyterOutputChannel(isDevMode, context.subscriptions, standardOutputChannel),
        JUPYTER_OUTPUT_CHANNEL
    );
    serviceManager.addSingletonInstance<boolean>(IsCodeSpace, env.uiKind == UIKind.Web);

    // Log env info.
    standardOutputChannel.appendLine(`${env.appName} (${version}, ${env.remoteName}, ${env.appHost})`);
    standardOutputChannel.appendLine(`Jupyter Extension Version: ${context.extension.packageJSON['version']}.`);
    const pythonExtension = extensions.getExtension(PythonExtension);
    if (pythonExtension) {
        standardOutputChannel.appendLine(`Python Extension Version: ${pythonExtension.packageJSON['version']}.`);
    } else {
        standardOutputChannel.appendLine('Python Extension not installed.');
    }
    if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
        standardOutputChannel.appendLine(`No workspace folder opened.`);
    } else if (workspace.workspaceFolders.length === 1) {
        standardOutputChannel.appendLine(`Workspace folder ${getDisplayPath(workspace.workspaceFolders[0].uri)}`);
    } else {
        standardOutputChannel.appendLine(
            `Multiple Workspace folders opened ${workspace.workspaceFolders
                .map((item) => getDisplayPath(item.uri))
                .join(', ')}`
        );
    }
}

/////////////////////////////
// old activation code

// eslint-disable-next-line
// TODO: Gradually move simple initialization
// and DI registration currently in this function over
// to initializeComponents().  Likewise with complex
// init and activation: move them to activateComponents().
// See https://github.com/microsoft/vscode-python/issues/10454.

async function activateLegacy(
    context: IExtensionContext,
    serviceManager: IServiceManager,
    serviceContainer: IServiceContainer
) {
    // register "services"
    const isDevMode =
        !isTestExecution() &&
        (context.extensionMode === ExtensionMode.Development ||
            workspace.getConfiguration('jupyter').get<boolean>('development', false));
    serviceManager.addSingletonInstance<boolean>(IsDevMode, isDevMode);
    const isPreReleasePromise = fsExtra
        .readFile(path.join(context.extensionPath, 'package.json'), { encoding: 'utf-8' })
        .then((contents) => {
            const packageJSONLive = JSON.parse(contents);
            return isDevMode || packageJSONLive?.__metadata?.preRelease;
        });
    serviceManager.addSingletonInstance<Promise<boolean>>(IsPreRelease, isPreReleasePromise);
    if (isDevMode) {
        void commands.executeCommand('setContext', 'jupyter.development', true);
    }
    void commands.executeCommand('setContext', 'jupyter.webExtension', false);

    // Set the logger home dir (we can compute this in a node app)
    setHomeDirectory(require('untildify')('~') || '');

    // Setup the console logger if asked to
    addConsoleLogger();
    // Output channel is special. We need it before everything else
    addOutputChannel(context, serviceManager, isDevMode);

    // Register the rest of the types (platform is first because it's needed by others)
    registerPlatformTypes(context, serviceManager, isDevMode);
    registerTelemetryTypes(serviceManager);
    registerKernelTypes(serviceManager, isDevMode);
    registerNotebookTypes(serviceManager);
    registerInteractiveTypes(serviceManager);
    registerWebviewTypes(serviceManager, isDevMode);
    registerIntellisenseTypes(serviceManager, isDevMode);

    // We need to setup this property before any telemetry is sent
    const fs = serviceManager.get<IFileSystem>(IFileSystem);
    await setExtensionInstallTelemetryProperties(fs);

    // Load the two data science experiments that we need to register types
    // Await here to keep the register method sync
    const experimentService = serviceContainer.get<IExperimentService>(IExperimentService);
    // This must be done first, this guarantees all experiment information has loaded & all telemetry will contain experiment info.
    await experimentService.activate();
    experimentService.logExperiments();

    const applicationEnv = serviceManager.get<IApplicationEnvironment>(IApplicationEnvironment);
    const configuration = serviceManager.get<IConfigurationService>(IConfigurationService);

    // We should start logging using the log level as soon as possible, so set it as soon as we can access the level.
    // `IConfigurationService` may depend any of the registered types, so doing it after all registrations are finished.
    // XXX Move this *after* abExperiments is activated?
    const settings = configuration.getSettings();
    setLoggingLevel(settings.logging.level);
    settings.onDidChange(() => {
        setLoggingLevel(settings.logging.level);
    });

    // "initialize" "services"
    const cmdManager = serviceContainer.get<ICommandManager>(ICommandManager);
    cmdManager.executeCommand('setContext', 'jupyter.vscode.channel', applicationEnv.channel).then(noop, noop);

    // "activate" everything else
    const manager = serviceContainer.get<IExtensionActivationManager>(IExtensionActivationManager);
    context.subscriptions.push(manager);
    manager.activateSync();
    const activationPromise = manager.activate();

    const deprecationMgr = serviceContainer.get<IFeatureDeprecationManager>(IFeatureDeprecationManager);
    deprecationMgr.initialize();
    context.subscriptions.push(deprecationMgr);

    return activationPromise;
}

function initializeGlobals(context: IExtensionContext): [IServiceManager, IServiceContainer] {
    const cont = new Container({ skipBaseClassChecks: true });
    const serviceManager = new ServiceManager(cont);
    const serviceContainer = new ServiceContainer(cont);

    serviceManager.addSingletonInstance<IServiceContainer>(IServiceContainer, serviceContainer);
    serviceManager.addSingletonInstance<IServiceManager>(IServiceManager, serviceManager);

    serviceManager.addSingletonInstance<Disposable[]>(IDisposableRegistry, context.subscriptions);
    serviceManager.addSingletonInstance<Memento>(IMemento, context.globalState, GLOBAL_MEMENTO);
    serviceManager.addSingletonInstance<Memento>(IMemento, context.workspaceState, WORKSPACE_MEMENTO);
    serviceManager.addSingletonInstance<IExtensionContext>(IExtensionContext, context);

    return [serviceManager, serviceContainer];
}
