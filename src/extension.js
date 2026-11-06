'use strict';
// Read-only custom editor for HDF5 and NetCDF files. The file is parsed in a worker thread;
// the webview gets only JSON values and renders them as text or canvas pixels.
const vscode = require('vscode');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildHtml } = require('./html.js');
const { Session } = require('./core/session.mjs');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

let rating = { success() {} };

const VIEW_TYPE = 'hdf5NetcdfExplorer.viewer';

function settings() {
  const c = vscode.workspace.getConfiguration('hdf5NetcdfExplorer');
  return {
    maxReadValues: Math.max(10000, c.get('maxReadValues', 1000000)),
    maxFileSizeMB: Math.max(0, c.get('maxFileSizeMB', 0)),
    timeoutMs: Math.max(2, c.get('readTimeoutSeconds', 20)) * 1000,
  };
}

class Provider {
  constructor(context) { this.context = context; }
  openCustomDocument(uri) { return { uri, dispose() {} }; }
  resolveCustomEditor(document, panel) {
    const ext = this.context.extensionUri;
    const webview = panel.webview;
    // Command links are limited to the two support commands and the settings page (footer "Hide" link).
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ext, 'dist'), vscode.Uri.joinPath(ext, 'media')], enableCommandUris: commandUris('hdf5NetcdfExplorer') };
    webview.html = buildHtml({
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(ext, 'dist', 'webview.js')),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(ext, 'media', 'webview.css')),
      showSupportLinks: showLinks(vscode, 'hdf5NetcdfExplorer'),
    });
    const uri = document.uri;
    const fileName = path.basename(uri.fsPath || uri.path);
    let counted = false; // one success per opened tab, for the rating prompt
    const post = m => {
      if (!counted && m && m.type === 'init' && !m.error) { counted = true; rating.success(); }
      webview.postMessage(m);
    };
    if (uri.scheme !== 'file') {
      webview.onDidReceiveMessage(m => { if (m && m.type === 'ready') post({ type: 'init', fileName, error: 'Only files on this computer can be opened (this file is on ' + uri.scheme + ').' }); });
      return;
    }
    const s = settings();
    const session = new Session({
      fileName,
      limits: { maxReadValues: s.maxReadValues, maxPathLength: 4096, maxDims: 32, maxPage: 2000 },
      timeoutMs: s.timeoutMs,
      post,
      copy: text => vscode.env.clipboard.writeText(text).then(() => vscode.window.setStatusBarMessage('Copied to clipboard', 2000)),
      createWorker: () => new Worker(path.join(this.context.extensionPath, 'dist', 'worker.mjs'), {
        workerData: { filePath: uri.fsPath, opts: { maxReadValues: s.maxReadValues, maxFileSizeMB: s.maxFileSizeMB } },
      }),
    });
    const subs = [webview.onDidReceiveMessage(m => session.handle(m))];
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath)));
    let t;
    watcher.onDidChange(() => { clearTimeout(t); t = setTimeout(() => session.reload(), 500); });
    subs.push(watcher);
    panel.onDidDispose(() => { clearTimeout(t); session.dispose(); subs.forEach(d => d.dispose()); });
  }
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.hdf5-netcdf-explorer', section: 'hdf5NetcdfExplorer', message: (n) => `HDF5 & NetCDF Explorer has opened ${n} files for you. A rating helps other people find it.` });
  registerSupport({ vscode, context, prefix: 'hdf5NetcdfExplorer', selfId: 'zovo.hdf5-netcdf-explorer' });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new Provider(context), { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: false } }),
    vscode.commands.registerCommand('hdf5NetcdfExplorer.openWith', async uri => {
      const target = uri instanceof vscode.Uri ? uri : (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (target) return vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
      const pick = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'HDF5 / NetCDF': ['h5', 'hdf5', 'he5', 'hdf', 'nc', 'nc4', 'netcdf', 'cdf', 'nxs', 'mat'] } });
      if (pick && pick[0]) return vscode.commands.executeCommand('vscode.openWith', pick[0], VIEW_TYPE);
    }),
    vscode.commands.registerCommand('hdf5NetcdfExplorer.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', 'zovo.hdf5-netcdf-explorer#hdf5NetcdfExplorer.start', false)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
