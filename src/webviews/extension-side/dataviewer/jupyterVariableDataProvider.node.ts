// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../../platform/common/extensions';

import { inject, injectable, named } from 'inversify';

import { DataViewerDependencyService } from './dataViewerDependencyService.node';
import { ColumnType, IDataFrameInfo, IJupyterVariableDataProvider, IRowsResponse } from './types';
import { IKernel } from '../../../kernels/types';
import { IJupyterVariable, IJupyterVariables } from '../../../kernels/variables/types';
import { traceError } from '../../../platform/logging';
import { Identifiers } from '../../webview-side/common/constants';

@injectable()
export class JupyterVariableDataProvider implements IJupyterVariableDataProvider {
    private initialized: boolean = false;
    private _kernel: IKernel | undefined;
    private variable: IJupyterVariable | undefined;

    constructor(
        @inject(IJupyterVariables) @named(Identifiers.ALL_VARIABLES) private variableManager: IJupyterVariables,
        @inject(DataViewerDependencyService) private dependencyService: DataViewerDependencyService
    ) {}

    public get kernel(): IKernel | undefined {
        return this._kernel;
    }

    /**
     * Normalizes column types to the types the UI component understands.
     * Defaults to 'string'.
     * @param columns
     * @returns Array of columns with normalized type
     */
    private static getNormalizedColumns(columns: { key: string; type: string }[]): { key: string; type: ColumnType }[] {
        return columns.map((column: { key: string; type: string }) => {
            let normalizedType: ColumnType;
            switch (column.type) {
                case 'bool':
                    normalizedType = ColumnType.Bool;
                    break;
                case 'integer':
                case 'int32':
                case 'int64':
                case 'float':
                case 'float32':
                case 'float64':
                case 'number':
                    normalizedType = ColumnType.Number;
                    break;
                default:
                    normalizedType = ColumnType.String;
            }
            return {
                key: column.key,
                type: normalizedType
            };
        });
    }

    // Parse a string of the form (1, 2, 3)
    private static parseShape(shape: string) {
        try {
            if (shape.startsWith('(') && shape.endsWith(')')) {
                return shape
                    .substring(1, shape.length - 1)
                    .split(',')
                    .map((shapeEl) => parseInt(shapeEl));
            }
        } catch (e) {
            traceError(`Could not parse IJupyterVariable with malformed shape: ${shape}`);
        }
        return undefined;
    }

    public dispose(): void {
        return;
    }

    public setDependencies(variable: IJupyterVariable, kernel?: IKernel): void {
        this._kernel = kernel;
        this.variable = variable;
    }

    public async getDataFrameInfo(sliceExpression?: string, isRefresh?: boolean): Promise<IDataFrameInfo> {
        let dataFrameInfo: IDataFrameInfo = {};
        await this.ensureInitialized();
        let variable = this.variable;
        if (variable) {
            if (sliceExpression || isRefresh) {
                variable = await this.variableManager.getDataFrameInfo(
                    variable,
                    this._kernel,
                    sliceExpression,
                    isRefresh
                );
            }
            dataFrameInfo = {
                columns: variable.columns
                    ? JupyterVariableDataProvider.getNormalizedColumns(variable.columns)
                    : variable.columns,
                indexColumn: variable.indexColumn,
                rowCount: variable.rowCount,
                dataDimensionality: variable.dataDimensionality,
                shape: JupyterVariableDataProvider.parseShape(variable.shape),
                sliceExpression,
                type: variable.type,
                maximumRowChunkSize: variable.maximumRowChunkSize,
                name: variable.name,
                fileName: variable.fileName
            };
        }
        if (isRefresh) {
            this.variable = variable;
        }
        return dataFrameInfo;
    }

    public async getAllRows(sliceExpression?: string) {
        let allRows: IRowsResponse = [];
        await this.ensureInitialized();
        if (this.variable && this.variable.rowCount) {
            const dataFrameRows = await this.variableManager.getDataFrameRows(
                this.variable,
                0,
                this.variable.rowCount,
                this._kernel,
                sliceExpression
            );
            allRows = dataFrameRows.data;
        }
        return allRows;
    }

    public async getRows(start: number, end: number, sliceExpression?: string) {
        let rows: IRowsResponse = [];
        await this.ensureInitialized();
        if (this.variable && this.variable.rowCount) {
            const dataFrameRows = await this.variableManager.getDataFrameRows(
                this.variable,
                start,
                end,
                this._kernel,
                sliceExpression
            );
            rows = dataFrameRows.data;
        }
        return rows;
    }

    private async ensureInitialized(): Promise<void> {
        // Postpone pre-req and variable initialization until data is requested.
        if (!this.initialized && this.variable) {
            this.initialized = true;
            if (this._kernel?.kernelConnectionMetadata.interpreter) {
                await this.dependencyService.checkAndInstallMissingDependencies(
                    this._kernel?.kernelConnectionMetadata.interpreter
                );
            }
            this.variable = await this.variableManager.getDataFrameInfo(this.variable, this._kernel);
        }
    }
}
