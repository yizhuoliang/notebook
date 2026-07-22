// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { JupyterFrontEndPlugin } from '@jupyterlab/application';
import {
  Dialog,
  IToolbarWidgetRegistry,
  showDialog,
  ToolbarButton,
} from '@jupyterlab/apputils';
import { CodeCell, MarkdownCell } from '@jupyterlab/cells';
import type { ICodeCellModel } from '@jupyterlab/cells';
import { URLExt } from '@jupyterlab/coreutils';
import type * as nbformat from '@jupyterlab/nbformat';
import {
  INotebookCellExecutor,
  type INotebookModel,
  type NotebookPanel,
} from '@jupyterlab/notebook';
import { ServerConnection } from '@jupyterlab/services';
import { ITranslator, type TranslationBundle } from '@jupyterlab/translation';
import { Widget } from '@lumino/widgets';

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

interface IRayBookConfigResponse {
  registered: boolean;
  config: string | null;
  environment: {
    kind: 'conda' | 'uv' | null;
    digest: string;
  };
  source: string | null;
}

interface IPendingExecution {
  options: INotebookCellExecutor.IRunCellOptions;
  resolve: (success: boolean) => void;
}

const pending = new Map<INotebookModel, IPendingExecution[]>();

function applyBranding(translator: ITranslator): void {
  const logo = document.getElementById('jp-NotebookLogo');
  if (!logo) {
    return;
  }
  const trans = translator.load('notebook');
  logo.replaceChildren(document.createTextNode('RayBook'));
  logo.setAttribute('aria-label', trans.__('RayBook home'));
  logo.setAttribute('title', trans.__('RayBook home'));
}

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

async function requestEnvironment(
  path: string
): Promise<IRayBookConfigResponse> {
  const settings = ServerConnection.makeSettings();
  const response = await ServerConnection.makeRequest(
    URLExt.join(settings.baseUrl, 'raybook/api/v1/config'),
    {
      ...settings.init,
      method: 'POST',
      headers: jsonHeaders(settings),
      body: JSON.stringify({ path }),
    },
    settings
  );
  if (!response.ok) {
    throw new Error(`Unable to load environment: HTTP ${response.status}`);
  }
  return (await response.json()) as IRayBookConfigResponse;
}

function environmentDialogBody(
  config: IRayBookConfigResponse,
  trans: TranslationBundle
): Widget {
  const node = document.createElement('div');
  node.className = 'rb-EnvironmentDialog';

  const status = document.createElement('div');
  status.className = config.registered
    ? 'rb-EnvironmentStatus rb-mod-registered'
    : 'rb-EnvironmentStatus';
  status.textContent = config.registered
    ? trans.__('Notebook environment registered')
    : trans.__('Base environment');
  node.append(status);

  const details = document.createElement('dl');
  details.className = 'rb-EnvironmentDetails';
  const fields: Array<[string, string]> = [
    [
      trans.__('Configuration'),
      config.config ?? trans.__('No sidecar discovered'),
    ],
    [
      trans.__('Provider'),
      config.environment.kind?.toUpperCase() ?? trans.__('Base'),
    ],
    [trans.__('Environment digest'), config.environment.digest],
  ];
  for (const [label, value] of fields) {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    details.append(term, description);
  }
  node.append(details);

  const sourceLabel = document.createElement('div');
  sourceLabel.className = 'rb-EnvironmentSourceLabel';
  sourceLabel.textContent = config.registered
    ? trans.__('Loaded YAML')
    : trans.__('Environment configuration');
  node.append(sourceLabel);

  const source = document.createElement('pre');
  source.className = 'rb-EnvironmentSource';
  source.textContent =
    config.source ??
    trans.__(
      'No .raybook.yaml sidecar is registered. Cell tasks use the base Ray worker environment.'
    );
  node.append(source);
  return new Widget({ node });
}

async function showEnvironment(
  panel: NotebookPanel,
  trans: TranslationBundle
): Promise<void> {
  try {
    const config = await requestEnvironment(panel.context.path);
    await showDialog({
      title: trans.__('RayBook environment'),
      body: environmentDialogBody(config, trans),
      buttons: [Dialog.okButton({ label: trans.__('Close') })],
    });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    await showDialog({
      title: trans.__('Unable to load environment'),
      body: message,
      buttons: [Dialog.okButton({ label: trans.__('Close') })],
    });
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

const executorPlugin: JupyterFrontEndPlugin<INotebookCellExecutor> = {
  id: '@jupyter-notebook/raybook-extension:cell-executor',
  description: 'Executes notebook cells through the RayBook server extension.',
  autoStart: true,
  provides: INotebookCellExecutor,
  requires: [ITranslator],
  activate: (app, translator: ITranslator): INotebookCellExecutor => {
    applyBranding(translator);
    void app.restored.then(() => applyBranding(translator));
    return executor;
  },
};

const environmentPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/raybook-extension:environment-viewer',
  description: 'Shows the Ray runtime environment registered for a notebook.',
  autoStart: true,
  requires: [IToolbarWidgetRegistry, ITranslator],
  activate: (
    _app,
    toolbarRegistry: IToolbarWidgetRegistry,
    translator: ITranslator
  ): void => {
    const trans = translator.load('notebook');
    toolbarRegistry.addFactory<NotebookPanel>(
      'Notebook',
      'raybook-environment',
      (panel) => {
        const button = new ToolbarButton({
          label: trans.__('Environment'),
          tooltip: trans.__('View the registered RayBook environment'),
          onClick: () => {
            void showEnvironment(panel, trans);
          },
        });
        button.addClass('rb-EnvironmentButton');
        return button;
      }
    );
  },
};

export default [executorPlugin, environmentPlugin];
