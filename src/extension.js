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
// Same viewer, offered in "Open With..." for every file: HDF5 files often have their own extensions.
const ANY_VIEW_TYPE = 'hdf5NetcdfExplorer.anyFile';
const OPEN_FILTERS = ['h5', 'hdf5', 'he5', 'hdf', 'nc', 'nc4', 'netcdf', 'cdf', 'nxs', 'h5ad', 'mat', 'jld2', 'loom', 'h5mu', 'hf5', 'h5oina', 'h5ebsd', 'edaxh5', 'oh5', 'dream3d', 'geoh5', 'nde', 'cxi'];

/** Our default editor for the known extensions (so a file already open is not opened twice), the any-file editor otherwise. */
function viewTypeFor(uri) {
  const ext = path.extname(uri.fsPath || uri.path).slice(1).toLowerCase();
  return ext !== 'mat' && OPEN_FILTERS.includes(ext) ? VIEW_TYPE : ANY_VIEW_TYPE;
}

/** The file behind the active tab, whatever editor shows it (text, binary or custom). */
function activeTabUri() {
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === 'file') return ed.document.uri;
  const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  const uri = input && (input.uri || input.modified);
  return uri instanceof vscode.Uri ? uri : undefined;
}

/** Save dialog next to the source file. The format follows the extension the user picks. */
async function chooseExportFile(source, defaultName) {
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(source.fsPath), defaultName)),
    filters: { 'CSV': ['csv'], 'JSON': ['json'] },
    saveLabel: 'Export',
    title: 'Export slice',
  });
  if (!target) return null;
  if (target.scheme === 'file' && path.resolve(target.fsPath) === path.resolve(source.fsPath)) {
    throw new Error('Pick a new file name. The export never overwrites the file you are viewing.');
  }
  return { path: target.fsPath, uri: target, format: /\.json$/i.test(target.fsPath) ? 'json' : 'csv' };
}

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
      chooseExportFile: ({ defaultName }) => chooseExportFile(uri, defaultName),
      writeExport: async (file, text) => {
        await vscode.workspace.fs.writeFile(vscode.Uri.file(file), Buffer.from(text, 'utf8'));
        const target = vscode.Uri.file(file);
        vscode.window.showInformationMessage(`Exported to ${path.basename(file)}`, 'Open').then(a => { if (a === 'Open') vscode.commands.executeCommand('vscode.open', target); });
      },
      createWorker: () => new Worker(path.join(this.context.extensionPath, 'dist', 'worker.mjs'), {
        workerData: { filePath: uri.fsPath, opts: { maxReadValues: s.maxReadValues, maxFileSizeMB: s.maxFileSizeMB } },
      }),
    });
    const subs = [webview.onDidReceiveMessage(m => session.handle(m))];
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath)));
    let t;
    const later = () => { clearTimeout(t); t = setTimeout(() => session.reload(), 500); };
    // A rewrite in place fires a change; tools that delete the file and write a new one fire a create.
    watcher.onDidChange(later);
    if (watcher.onDidCreate) watcher.onDidCreate(later);
    subs.push(watcher);
    panel.onDidDispose(() => { clearTimeout(t); session.dispose(); subs.forEach(d => d.dispose()); });
  }
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.hdf5-netcdf-explorer', section: 'hdf5NetcdfExplorer', message: (n) => `HDF5 & NetCDF Explorer has opened ${n} files for you. A rating helps other people find it.` });
  registerSupport({ vscode, context, prefix: 'hdf5NetcdfExplorer', selfId: 'zovo.hdf5-netcdf-explorer' });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new Provider(context), { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: false } }),
    vscode.window.registerCustomEditorProvider(ANY_VIEW_TYPE, new Provider(context), { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: false } }),
    vscode.commands.registerCommand('hdf5NetcdfExplorer.openWith', async uri => {
      const target = uri instanceof vscode.Uri ? uri : activeTabUri();
      if (target) return vscode.commands.executeCommand('vscode.openWith', target, viewTypeFor(target));
      const pick = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'HDF5 / NetCDF': OPEN_FILTERS, 'All files': ['*'] } });
      if (pick && pick[0]) return vscode.commands.executeCommand('vscode.openWith', pick[0], viewTypeFor(pick[0]));
    }),
    vscode.commands.registerCommand('hdf5NetcdfExplorer.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', 'zovo.hdf5-netcdf-explorer#hdf5NetcdfExplorer.start', false)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
