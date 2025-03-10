// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../../platform/common/extensions';

import { inject, injectable } from 'inversify';
import * as path from '../../../platform/vscode-path/path';
import { Event, EventEmitter, Uri, ViewColumn } from 'vscode';

import { traceError, traceInfo } from '../../../platform/logging';
import { createDeferred } from '../../../platform/common/utils/async';
import { PlotViewerMessageListener } from './plotViewerMessageListener.node';
import { IExportPlotRequest, IPlotViewer, IPlotViewerMapping, PlotViewerMessages } from './types';
import {
    IWebviewPanelProvider,
    IWorkspaceService,
    IApplicationShell
} from '../../../platform/common/application/types';
import { IFileSystem } from '../../../platform/common/platform/types.node';
import { IConfigurationService, IDisposable } from '../../../platform/common/types';
import * as localize from '../../../platform/common/utils/localize';
import { EXTENSION_ROOT_DIR } from '../../../platform/constants.node';
import { ICodeCssGenerator, IThemeFinder } from '../types';
import { WebviewPanelHost } from '../webviewPanelHost.node';

const plotDir = path.join(EXTENSION_ROOT_DIR, 'out', 'webviews', 'webview-side', 'viewers');
@injectable()
export class PlotViewer extends WebviewPanelHost<IPlotViewerMapping> implements IPlotViewer, IDisposable {
    private closedEvent: EventEmitter<IPlotViewer> = new EventEmitter<IPlotViewer>();
    private removedEvent: EventEmitter<number> = new EventEmitter<number>();

    constructor(
        @inject(IWebviewPanelProvider) provider: IWebviewPanelProvider,
        @inject(IConfigurationService) configuration: IConfigurationService,
        @inject(ICodeCssGenerator) cssGenerator: ICodeCssGenerator,
        @inject(IThemeFinder) themeFinder: IThemeFinder,
        @inject(IWorkspaceService) workspaceService: IWorkspaceService,
        @inject(IApplicationShell) private applicationShell: IApplicationShell,
        @inject(IFileSystem) private fs: IFileSystem
    ) {
        super(
            configuration,
            provider,
            cssGenerator,
            themeFinder,
            workspaceService,
            (c, v, d) => new PlotViewerMessageListener(c, v, d),
            plotDir,
            [path.join(plotDir, 'plotViewer.js')],
            localize.DataScience.plotViewerTitle(),
            ViewColumn.One
        );
        // Load the web panel using our current directory as we don't expect to load any other files
        super.loadWebview(process.cwd()).catch(traceError);
    }

    public get closed(): Event<IPlotViewer> {
        return this.closedEvent.event;
    }

    public get removed(): Event<number> {
        return this.removedEvent.event;
    }

    public override async show(): Promise<void> {
        if (!this.isDisposed) {
            // Then show our web panel.
            return super.show(true);
        }
    }

    public addPlot = async (imageHtml: string): Promise<void> => {
        if (!this.isDisposed) {
            // Make sure we're shown
            await super.show(false);

            // Send a message with our data
            this.postMessage(PlotViewerMessages.SendPlot, imageHtml).ignoreErrors();
        }
    };

    public override dispose() {
        super.dispose();
        if (this.closedEvent) {
            this.closedEvent.fire(this);
        }
    }

    protected get owningResource() {
        return undefined;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected override onMessage(message: string, payload: any) {
        switch (message) {
            case PlotViewerMessages.CopyPlot:
                this.copyPlot(payload.toString()).ignoreErrors();
                break;

            case PlotViewerMessages.ExportPlot:
                this.exportPlot(payload).ignoreErrors();
                break;

            case PlotViewerMessages.RemovePlot:
                this.removePlot(payload);
                break;

            default:
                break;
        }

        super.onMessage(message, payload);
    }

    private removePlot(payload: number) {
        this.removedEvent.fire(payload);
    }

    private copyPlot(_svg: string): Promise<void> {
        // This should be handled actually in the web view. Leaving
        // this here for now in case need node to handle it.
        return Promise.resolve();
    }

    private async exportPlot(payload: IExportPlotRequest): Promise<void> {
        traceInfo('exporting plot...');
        const filtersObject: Record<string, string[]> = {};
        filtersObject[localize.DataScience.pdfFilter()] = ['pdf'];
        filtersObject[localize.DataScience.pngFilter()] = ['png'];
        filtersObject[localize.DataScience.svgFilter()] = ['svg'];

        // Ask the user what file to save to
        const file = await this.applicationShell.showSaveDialog({
            saveLabel: localize.DataScience.exportPlotTitle(),
            filters: filtersObject
        });
        try {
            if (file) {
                const ext = path.extname(file.fsPath);
                switch (ext.toLowerCase()) {
                    case '.pdf':
                        await saveSvgToPdf(payload.svg, this.fs, file);
                        break;

                    case '.png':
                        const buffer = Buffer.from(payload.png.replace('data:image/png;base64', ''), 'base64');
                        await this.fs.writeLocalFile(file.fsPath, buffer);
                        break;

                    default:
                    case '.svg':
                        // This is the easy one:
                        await this.fs.writeLocalFile(file.fsPath, payload.svg);
                        break;
                }
            }
        } catch (e) {
            traceError(e);
            void this.applicationShell.showErrorMessage(localize.DataScience.exportImageFailed().format(e));
        }
    }
}

export async function saveSvgToPdf(svg: string, fs: IFileSystem, file: Uri) {
    traceInfo('Attempting pdf write...');
    // Import here since pdfkit is so huge.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SVGtoPDF = require('svg-to-pdfkit');
    const deferred = createDeferred<void>();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfkit = require('pdfkit/js/pdfkit.standalone') as typeof import('pdfkit');
    const doc = new pdfkit();
    const ws = fs.createLocalWriteStream(file.fsPath);
    traceInfo(`Writing pdf to ${file.fsPath}`);
    ws.on('finish', () => deferred.resolve);
    // See docs or demo from source https://cdn.statically.io/gh/alafr/SVG-to-PDFKit/master/examples/demo.htm
    // How to resize to fit (fit within the height & width of page).
    SVGtoPDF(doc, svg, 0, 0, { preserveAspectRatio: 'xMinYMin meet' });
    doc.pipe(ws);
    doc.end();
    traceInfo(`Finishing pdf to ${file.fsPath}`);
    await deferred.promise;
    traceInfo(`Completed pdf to ${file.fsPath}`);
}
