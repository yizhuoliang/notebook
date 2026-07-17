// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { JupyterFrontEndPlugin } from '@jupyterlab/application';
import { CodeCell, MarkdownCell } from '@jupyterlab/cells';
import type { ICodeCellModel } from '@jupyterlab/cells';
import { URLExt } from '@jupyterlab/coreutils';
import type * as nbformat from '@jupyterlab/nbformat';
import {
  INotebookCellExecutor,
  type INotebookModel,
} from '@jupyterlab/notebook';
import { ServerConnection } from '@jupyterlab/services';

interface IRayBookCell {
  index: number;
  id: string;
  execution_count: number | null;
  outputs: nbformat.IOutput[];
  status: 'executed' | 'reused' | 'failed';
}

interface IRayBookResponse {
  status: 'completed' | 'failed';
  cells: IRayBookCell[];
}

interface IPendingExecution {
  options: INotebookCellExecutor.IRunCellOptions;
  resolve: (success: boolean) => void;
}

const pending = new Map<INotebookModel, IPendingExecution[]>();

function jsonHeaders(settings: ServerConnection.ISettings): Headers {
  const headers = new Headers(settings.init.headers);
  headers.set('Content-Type', 'application/json');
  return headers;
}

async function saveNotebook(
  notebook: INotebookModel,
  path: string,
  settings: ServerConnection.ISettings
): Promise<void> {
  const url = URLExt.join(
    settings.baseUrl,
    'api/contents',
    URLExt.encodeParts(path)
  );
  const response = await ServerConnection.makeRequest(
    url,
    {
      ...settings.init,
      method: 'PUT',
      headers: jsonHeaders(settings),
      body: JSON.stringify({
        type: 'notebook',
        format: 'json',
        content: notebook.toJSON(),
      }),
    },
    settings
  );
  if (!response.ok) {
    throw new Error(`Unable to save notebook: HTTP ${response.status}`);
  }
}

function applyOutputs(
  notebook: INotebookModel,
  response: IRayBookResponse
): void {
  for (const result of response.cells) {
    const model = notebook.cells.get(result.index);
    if (!model || model.type !== 'code') {
      continue;
    }
    const code = model as ICodeCellModel;
    code.outputs.clear();
    for (const output of result.outputs) {
      code.outputs.add(output);
    }
    code.executionCount = result.execution_count;
    code.executionState = 'idle';
  }
}

async function executeBatch(
  notebook: INotebookModel,
  items: IPendingExecution[]
): Promise<void> {
  const path = items[0].options.sessionContext?.path;
  if (!path) {
    throw new Error('RayBook execution requires a saved notebook path');
  }

  const settings = ServerConnection.makeSettings();
  await saveNotebook(notebook, path, settings);
  const cellIds = items.map((item) => item.options.cell.model.id);
  const response = await ServerConnection.makeRequest(
    URLExt.join(settings.baseUrl, 'raybook/api/v1/execute'),
    {
      ...settings.init,
      method: 'POST',
      headers: jsonHeaders(settings),
      body: JSON.stringify({ path, cell_ids: cellIds }),
    },
    settings
  );
  if (!response.ok) {
    throw new Error(`RayBook execution failed: HTTP ${response.status}`);
  }

  const result = (await response.json()) as IRayBookResponse;
  applyOutputs(notebook, result);
  const completed = new Set(
    result.cells
      .filter((cell) => cell.status !== 'failed')
      .map((cell) => cell.id)
  );
  for (const item of items) {
    const success =
      result.status === 'completed' &&
      completed.has(item.options.cell.model.id);
    item.options.onCellExecuted({ cell: item.options.cell, success });
    item.resolve(success);
  }
}

function flush(notebook: INotebookModel): void {
  const items = pending.get(notebook);
  pending.delete(notebook);
  if (!items) {
    return;
  }
  void executeBatch(notebook, items).catch((reason) => {
    console.error('RayBook execution failed', reason);
    for (const item of items) {
      if (item.options.cell instanceof CodeCell) {
        item.options.cell.model.executionState = 'idle';
      }
      item.options.onCellExecuted({
        cell: item.options.cell,
        success: false,
      });
      item.resolve(false);
    }
  });
}

const executor: INotebookCellExecutor = {
  runCell(options): Promise<boolean> {
    if (options.cell instanceof MarkdownCell) {
      options.cell.rendered = true;
      options.cell.inputHidden = false;
      options.onCellExecuted({ cell: options.cell, success: true });
      return Promise.resolve(true);
    }
    if (!(options.cell instanceof CodeCell)) {
      options.onCellExecuted({ cell: options.cell, success: true });
      return Promise.resolve(true);
    }

    options.onCellExecutionScheduled({ cell: options.cell });
    options.cell.model.executionState = 'running';
    return new Promise<boolean>((resolve) => {
      const items = pending.get(options.notebook);
      if (items) {
        items.push({ options, resolve });
      } else {
        pending.set(options.notebook, [{ options, resolve }]);
        queueMicrotask(() => flush(options.notebook));
      }
    });
  },
};

const plugin: JupyterFrontEndPlugin<INotebookCellExecutor> = {
  id: '@jupyter-notebook/raybook-extension:cell-executor',
  description: 'Executes notebook cells through the RayBook server extension.',
  autoStart: true,
  provides: INotebookCellExecutor,
  activate: (): INotebookCellExecutor => executor,
};

export default plugin;
