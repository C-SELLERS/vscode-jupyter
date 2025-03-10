// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../platform/common/extensions';

import * as fs from 'fs-extra';
import * as path from '../../platform/vscode-path/path';
import { Uri } from 'vscode';
import { IWorkspaceService } from '../../platform/common/application/types';
import { Resource } from '../../platform/common/types';
import { SystemVariables } from '../../platform/common/variables/systemVariables.node';
import { getJupyterConnectionDisplayName } from './launcher/jupyterConnection.node';
import { noop } from '../../platform/common/utils/misc';
import { IJupyterConnection } from '../types';
import { IJupyterServerUri } from './types';

export function expandWorkingDir(
    workingDir: string | undefined,
    launchingFile: string | undefined,
    workspace: IWorkspaceService
): string {
    if (workingDir) {
        const variables = new SystemVariables(
            launchingFile ? Uri.file(launchingFile) : undefined,
            workspace.rootFolder,
            workspace
        );
        return variables.resolve(workingDir);
    }

    // No working dir, just use the path of the launching file.
    if (launchingFile) {
        return path.dirname(launchingFile);
    }

    // No launching file or working dir. Just use the default workspace folder
    const workspaceFolder = workspace.getWorkspaceFolder(undefined);
    if (workspaceFolder) {
        return workspaceFolder.uri.fsPath;
    }

    return process.cwd();
}

export function createRemoteConnectionInfo(
    uri: string,
    getJupyterServerUri: (uri: string) => IJupyterServerUri | undefined
): IJupyterConnection {
    let url: URL;
    try {
        url = new URL(uri);

        // Special case for URI's ending with 'lab'. Remove this from the URI. This is not
        // the location for connecting to jupyterlab
        if (url.pathname === '/lab') {
            uri = uri.replace('lab', '');
        }
        url = new URL(uri);
    } catch (err) {
        // This should already have been parsed when set, so just throw if it's not right here
        throw err;
    }

    const serverUri = getJupyterServerUri(uri);
    const baseUrl = serverUri ? serverUri.baseUrl : `${url.protocol}//${url.host}${url.pathname}`;
    const token = serverUri ? serverUri.token : `${url.searchParams.get('token')}`;
    const hostName = serverUri ? new URL(serverUri.baseUrl).hostname : url.hostname;

    return {
        type: 'jupyter',
        baseUrl,
        token,
        hostName,
        localLaunch: false,
        displayName:
            serverUri && serverUri.displayName
                ? serverUri.displayName
                : getJupyterConnectionDisplayName(token, baseUrl),
        disconnected: (_l) => {
            return { dispose: noop };
        },
        dispose: noop,
        rootDirectory: '',
        getAuthHeader: serverUri ? () => getJupyterServerUri(uri)?.authorizationHeader : undefined,
        url: uri
    };
}

export async function computeWorkingDirectory(resource: Resource, workspace: IWorkspaceService): Promise<string> {
    const fileExists = resource && resource.scheme === 'file' ? await fs.pathExists(resource.fsPath) : false;
    const dirExists =
        resource && resource.scheme === 'file' ? await fs.pathExists(path.dirname(resource.fsPath)) : false;

    // If we have a file with an extension, use the dir of the file
    if (dirExists && resource && resource.fsPath.includes('.')) {
        return path.dirname(resource.fsPath);
    }
    // If we have a dir then use the dir.
    if (fileExists && resource && (await fs.stat(resource.fsPath)).isDirectory()) {
        return resource.fsPath;
    }

    // Otherwise a file without an extension or directory doesn't exist. Just use the workspace root
    return workspace.getWorkspaceFolder(resource)?.uri.fsPath || workspace.rootFolder?.fsPath || process.cwd();
}
