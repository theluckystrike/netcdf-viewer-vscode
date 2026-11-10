// Support links: the sponsor field in package.json, the two commands, and the setting that hides the footer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(root + 'package.json', 'utf8'));
const support = require('../src/support.js');
const { buildHtml } = require('../src/html.js');
const P = 'hdf5NetcdfExplorer';

test('support: package.json has the sponsor field, the two commands and the setting', () => {
  assert.equal(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878');
  assert.equal(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878');
  const ids = pkg.contributes.commands.map(c => c.command);
  assert.ok(ids.includes(P + '.supportDeveloper') && ids.includes(P + '.moreViewers'));
  const cfg = Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration];
  const props = Object.assign({}, ...cfg.map(c => c.properties));
  assert.equal(props[P + '.showSupportLinks'].default, true);
  assert.ok(support.fundingLinks().every(l => /^https:\/\//.test(l.url)));
  assert.ok(support.otherProducts('zovo.hdf5-netcdf-explorer').every(p => p.id !== 'zovo.hdf5-netcdf-explorer'));
});

test('support: the webview footer shows by default and showSupportLinks=false hides it', () => {
  const base = { cspSource: 'vscode-webview://x', scriptUri: 'vscode-webview://x/w.js', styleUri: 'vscode-webview://x/s.css', nonce: 'abc123' };
  const on = buildHtml(base);
  assert.match(on, /id="zovo-support"/);
  assert.match(on, /href="command:hdf5NetcdfExplorer\.getPro"[^>]*>Zovo Pro, USD 19</); // EXEC16 footer: Zovo Pro replaces Sponsor
  assert.match(on, /<style nonce="abc123">/);
  const off = buildHtml({ ...base, showSupportLinks: false });
  assert.doesNotMatch(off, /zovo-support|command:/);
});

const bundle = root + 'dist/extension.js';
test('support: the bundled host reads the setting and allows only the support command links', { skip: !fs.existsSync(bundle) && 'not built' }, async () => {
  for (const [settings, shown] of [[{}, true], [{ showSupportLinks: false }, false]]) {
    let provider; const commands = new Map();
    const Uri = { file: p => ({ scheme: 'file', fsPath: p, path: p }), joinPath: (u, ...p) => ({ fsPath: [u.fsPath, ...p].join('/'), path: [u.fsPath, ...p].join('/') }), parse: s => ({ toString: () => s }) };
    const vscode = {
      Uri, RelativePattern: class {},
      window: { registerCustomEditorProvider: (id, p) => { provider = p; return { dispose() {} }; }, setStatusBarMessage() {} },
      commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } },
      workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }), createFileSystemWatcher: () => ({ onDidChange() {}, dispose() {} }) },
      env: { clipboard: { writeText: async () => {} } },
    };
    const orig = Module._load;
    Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : orig.call(this, req, ...rest); };
    try {
      delete require.cache[bundle];
      const ext = require(bundle);
      ext.activate({ subscriptions: [], extensionUri: Uri.file(root.replace(/\/$/, '')), extensionPath: root });
      const webview = { cspSource: 'vscode-webview://t', asWebviewUri: u => 'vscode-webview://t' + u.path, postMessage: () => Promise.resolve(true), onDidReceiveMessage: () => ({ dispose() {} }) };
      provider.resolveCustomEditor(provider.openCustomDocument({ scheme: 'untitled', fsPath: '/x.nc', path: '/x.nc' }), { webview, onDidDispose() {} });
      assert.equal(/id="zovo-support"/.test(webview.html), shown, JSON.stringify(settings));
      assert.deepEqual(webview.options.enableCommandUris, [P + '.supportDeveloper', P + '.moreViewers', 'hdf5NetcdfExplorer.getPro', 'hdf5NetcdfExplorer.payWithPayPal', 'workbench.action.openSettings']);
      assert.ok(commands.has(P + '.supportDeveloper') && commands.has(P + '.moreViewers'));
    } finally { Module._load = orig; }
  }
});
