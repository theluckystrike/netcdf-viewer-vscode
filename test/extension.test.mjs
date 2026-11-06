// Loads the bundled dist/extension.js with a mock vscode module, opens a sample in the custom editor,
// and runs the webview protocol through the bundled dist/worker.mjs. Run `npm run build` first.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { S } from './helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = root + 'dist/extension.js';

test('bundled extension: activate, open a NetCDF file, list and read', { skip: !fs.existsSync(bundle) && 'not built' }, async () => {
  let provider, fromHost = [], onMsg, disposeCb;
  const Uri = { file: p => ({ scheme: 'file', fsPath: p, path: p }), joinPath: (u, ...p) => ({ fsPath: [u.fsPath, ...p].join('/'), path: [u.fsPath, ...p].join('/') }) };
  const vscode = {
    Uri, RelativePattern: class {},
    window: { registerCustomEditorProvider: (id, p) => { provider = p; return { dispose() {} }; }, setStatusBarMessage() {} },
    commands: { registerCommand: () => ({ dispose() {} }) },
    workspace: { getConfiguration: () => ({ get: (k, d) => d }), createFileSystemWatcher: () => ({ onDidChange() {}, dispose() {} }) },
    env: { clipboard: { writeText: async () => {} } },
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : orig.call(this, req, ...rest); };
  try {
    const ext = createRequire(import.meta.url)(bundle);
    ext.activate({ subscriptions: [], extensionUri: Uri.file(root.replace(/\/$/, '')), extensionPath: root });
    assert.ok(provider);
    const webview = { cspSource: 'vscode-webview://t', asWebviewUri: u => 'vscode-webview://t' + u.path, postMessage: m => { fromHost.push(m); return Promise.resolve(true); }, onDidReceiveMessage: cb => { onMsg = cb; return { dispose() {} }; } };
    const panel = { webview, onDidDispose: cb => { disposeCb = cb; } };
    const doc = provider.openCustomDocument(Uri.file(S('era5-t2m-sample.nc')));
    provider.resolveCustomEditor(doc, panel);
    assert.match(webview.html, /Content-Security-Policy/);
    const wait = async n => { for (let i = 0; i < 200 && fromHost.length < n; i++) await new Promise(r => setTimeout(r, 25)); };
    onMsg({ type: 'ready' }); await wait(1);
    assert.equal(fromHost[0].label, 'NetCDF-4 (HDF5)');
    onMsg({ type: 'read', reqId: 7, path: '/time', view: { rowCount: 1 } }); await wait(2);
    assert.deepEqual([fromHost[1].reqId, fromHost[1].ok, fromHost[1].data.times[0][0]], [7, true, '2024-12-01']);
    disposeCb();
  } finally { Module._load = orig; }
});
