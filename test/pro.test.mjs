// Zovo Pro tools: block plan, compare two files, subset export (NetCDF-3 writer, CSV), free tries, the bundled
// extension end to end with the real worker thread, and package.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { S, libs } from './helpers.mjs';
import { openFile } from '../src/core/open.mjs';
import { planBlocks, fullSelection, toBlock, walk, indexLabel } from '../src/core/blocks.mjs';
import { compareFiles, attrDiff } from '../src/core/ncompare.mjs';
import { parseRange, writeSubset, CSV_MAX_VALUES } from '../src/core/subset.mjs';
import { buildHeader, encode, ncName, ncAttr } from '../src/core/nc3write.mjs';
import { validateRequest } from '../src/core/protocol.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pro-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The worker's ops, called directly on a backend (same code path as the worker, without the thread). */
async function reader(file) {
  const o = await openFile(file, libs, { maxReadValues: 1_000_000 });
  const b = o.backend;
  const call = async (op, p) => {
    if (op === 'list') return b.list(p.path);
    if (op === 'info') return b.info(p.path);
    if (op === 'read') return b.read(p.path, p.view, p.decode);
    if (op === 'block') return toBlock(b.read(p.path, p.view, p.decode !== false));
    throw new Error('op ' + op);
  };
  return { call, close: () => b.close(), b };
}

/** A small NetCDF-3 file written with our writer: dims time x lat, coordinates, one variable. */
function writeNc(file, { values, extraVar = false, units = 'K', title = 'test' }) {
  const spec = {
    dims: [{ name: 'time', size: 3 }, { name: 'lat', size: 4 }],
    atts: [{ name: 'title', type: 'char', values: Buffer.from(title) }],
    vars: [
      { name: 'time', dims: [0], type: 'double', atts: [{ name: 'units', type: 'char', values: Buffer.from('days since 2020-01-01') }] },
      { name: 'lat', dims: [1], type: 'double', atts: [{ name: 'units', type: 'char', values: Buffer.from('degrees_north') }] },
      { name: 'temp', dims: [0, 1], type: 'float', atts: [{ name: 'units', type: 'char', values: Buffer.from(units) }, { name: '_FillValue', type: 'float', values: [NaN] }] },
    ],
  };
  if (extraVar) spec.vars.push({ name: 'extra', dims: [1], type: 'int', atts: [] });
  const { header, vars } = buildHeader(spec);
  const buf = Buffer.alloc(vars[vars.length - 1].begin + vars[vars.length - 1].vsize);
  header.copy(buf, 0);
  encode('double', [0, 1, 2]).copy(buf, vars[0].begin);
  encode('double', [-45, -15, 15, 45]).copy(buf, vars[1].begin);
  encode('float', values).copy(buf, vars[2].begin);
  if (extraVar) encode('int', [1, 2, 3, 4]).copy(buf, vars[3].begin);
  fs.writeFileSync(file, buf);
  return file;
}
const BASE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

test('block plan covers every value of a selection once, in row-major order', () => {
  const shape = [3, 5, 7];
  for (const max of [1, 4, 7, 10, 35, 1000]) {
    const sel = [{ start: 1, count: 2, step: 1 }, { start: 0, count: 3, step: 2 }, { start: 2, count: 5, step: 1 }];
    const seen = new Set();
    for (const b of planBlocks(shape, sel, max)) {
      assert.ok(b.rows * b.cols <= max || b.cols === Math.min(sel[2].count, max));
      for (let i = 0; i < b.rows; i++) for (let j = 0; j < b.cols; j++) {
        const flat = b.out + i * sel[2].count + j;
        assert.ok(!seen.has(flat), `max ${max}: ${flat} twice`);
        seen.add(flat);
      }
      assert.equal(b.view.index[0], sel[0].start + b.lead[0] * sel[0].step);
    }
    assert.equal(seen.size, 2 * 3 * 5);
  }
  assert.equal([...planBlocks([10], fullSelection([10]), 4)].length, 3);
  assert.equal([...planBlocks([], [], 4)].length, 1);
  assert.equal(indexLabel(23, [2, 3, 4], ['t', 'y', 'x']), 't=1, y=2, x=3');
});

test('worker reads become numbers with a fill mask', () => {
  const b = toBlock({ values: [[1, null, 'NaN'], ['Inf', '-Inf', '9007199254740993']] });
  assert.deepEqual(Array.from(b.fill), [0, 1, 0, 0, 0, 0]);
  assert.ok(Number.isNaN(b.values[2]) && b.values[3] === Infinity && b.values[4] === -Infinity);
  assert.equal(b.values[5], 9007199254740992);
  assert.equal(toBlock({ values: [['abc']] }).text, true);
});

test('ranges: all, index, index ranges with step and from the end, values, dates', () => {
  const lat = { values: [-45, -15, 15, 45], times: null };
  assert.deepEqual(parseRange('', 4, lat).count, 4);
  assert.deepEqual([parseRange('2', 4).start, parseRange('2', 4).count], [2, 1]);
  assert.deepEqual([parseRange('-1', 4).start], [3]);
  const r = parseRange('0:9:3', 10);
  assert.deepEqual([r.start, r.count, r.step], [0, 4, 3]);
  assert.deepEqual([parseRange(':5', 10).count, parseRange('5:', 10).count], [6, 5]);
  assert.equal(parseRange('5:2', 10).ok, false);
  assert.equal(parseRange('0:10', 10).ok, false);
  const v = parseRange('-20..20', 4, lat);
  assert.deepEqual([v.start, v.count], [1, 2]);
  assert.deepEqual([parseRange('20..-20', 4, lat).start], [1], 'either order');
  assert.match(parseRange('0..1', 4, lat).error, /nearest is 15 at index 2/);
  assert.match(parseRange('1..2', 4, null).error, /no coordinate/);
  assert.match(parseRange('0..50', 3, { values: [10, 40, 20], times: null }).ok ? 'ok' : 'x', /ok/);
  assert.match(parseRange('15..45', 4, { values: [10, 40, 5, 20], times: null }).error, /not sorted/);
  const t = { values: [0, 1, 2, 3], times: ['2023-07-31', '2023-08-01', '2023-08-01 06:00', '2023-08-02'] };
  const d = parseRange('2023-08-01..2023-08-01', 4, t);
  assert.deepEqual([d.start, d.count], [1, 2], 'a bare end date takes the whole day');
  assert.match(parseRange('x', 4).error, /index/);
});

test('NetCDF-3 writer: names, attributes, header offsets, readable by our reader', async () => {
  assert.equal(ncName('/group/2m temp'), '_2m_temp');
  assert.deepEqual(ncAttr([1, 2]).type, 'int');
  assert.deepEqual(ncAttr(0.5).type, 'double');
  assert.equal(ncAttr({ truncated: 100 }), null);
  const f = writeNc(path.join(tmp, 'w.nc'), { values: BASE });
  const r = await reader(f);
  try {
    assert.match(r.b.label, /64-bit offset/);
    const x = await r.call('read', { path: '/temp', view: { rowAxis: 0, colAxis: 1, index: [0, 0], rowCount: 3, colCount: 4 }, decode: true });
    assert.deepEqual(x.values, [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]);
    const lat = await r.call('read', { path: '/lat', view: { rowAxis: 0, colAxis: -1, index: [0], rowCount: 4 }, decode: true });
    assert.deepEqual(lat.values.map(v => v[0]), [-45, -15, 15, 45]);
  } finally { r.close(); }
});

test('compare: identical, changed value with its index, attributes, extra variable, tolerance', async () => {
  const a = writeNc(path.join(tmp, 'a.nc'), { values: BASE });
  const changed = BASE.slice(); changed[6] = 7.75; // time=1, lat=2
  const b = writeNc(path.join(tmp, 'b.nc'), { values: changed, extraVar: true, units: 'degC', title: 'other' });
  const ra = await reader(a), rb = await reader(b), ra2 = await reader(a);
  try {
    const same = await compareFiles({ callA: ra.call, callB: ra2.call, nameA: 'a.nc', nameB: 'a.nc' });
    assert.equal(same.summary.changed, 0);
    assert.equal(same.summary.identical, 3);
    const r = await compareFiles({ callA: ra.call, callB: rb.call, nameA: 'a.nc', nameB: 'b.nc', maxValues: 5 });
    const row = p => r.rows.find(x => x.path === p);
    assert.equal(row('/temp').status, 'changed');
    assert.equal(row('/temp').maxAbs, 0.75);
    assert.equal(row('/temp').differing, 1);
    assert.equal(row('/temp').maxAt, 'time=1, lat=2');
    assert.equal(row('/temp').attrs, 'units');
    assert.equal(row('/extra').status, 'only in B');
    assert.equal(row('/ (global attributes)').attrs, 'title');
    assert.equal(r.rows[0].path, '/temp', 'changes first');
    const tol = await compareFiles({ callA: ra.call, callB: rb.call, nameA: 'a.nc', nameB: 'b.nc', tolerance: 1 });
    assert.equal(tol.rows.find(x => x.path === '/temp').status, 'attrs differ');
    assert.match(tol.rows.find(x => x.path === '/temp').note, /within the tolerance/);
  } finally { ra.close(); rb.close(); ra2.close(); }
  assert.deepEqual(attrDiff([{ name: 'a', value: 1 }, { name: 'NAME', value: 'x', internal: true }], [{ name: 'b', value: 2 }]), ['-a', '+b']);
});

test('compare: an HDF5 (NetCDF-4) file with itself reads every value, fill aware', async () => {
  const ra = await reader(S('era5-t2m-sample.nc')), rb = await reader(S('era5-t2m-sample.nc'));
  try {
    const r = await compareFiles({ callA: ra.call, callB: rb.call, nameA: 'A', nameB: 'B', maxValues: 5000 });
    assert.equal(r.summary.changed, 0);
    assert.equal(r.summary.identical, 5);
    const t2m = r.rows.find(x => x.path === '/t2m');
    assert.equal(t2m.compared, 24 * 73 * 144);
  } finally { ra.close(); rb.close(); }
});

test('compare stops on cancel and marks the rest', async () => {
  const ra = await reader(S('era5-t2m-sample.nc')), rb = await reader(S('era5-t2m-sample.nc'));
  try {
    let n = 0;
    const r = await compareFiles({ callA: ra.call, callB: rb.call, nameA: 'A', nameB: 'B', maxValues: 1000, cancelled: () => ++n > 3 });
    assert.ok(r.stopped);
    assert.ok(r.summary.notCompared >= 1);
  } finally { ra.close(); rb.close(); }
});

test('subset to NetCDF: packed t2m by value and date ranges, decoded, coordinates and attributes kept', async () => {
  const r = await reader(S('era5-t2m-sample.nc'));
  const out = path.join(tmp, 't2m_subset.nc');
  try {
    const info = await r.call('info', { path: '/t2m' });
    const coord = async p => { const x = await r.call('read', { path: p, view: { rowAxis: 0, colAxis: -1, index: [0], rowCount: 1000 }, decode: true }); return { values: x.values.map(v => v[0]), times: x.times ? x.times.map(v => v[0]) : null }; };
    const coords = [await coord('/time'), await coord('/latitude'), await coord('/longitude')];
    const sel = [parseRange('2:5', 24, coords[0]), parseRange('60..40', 73, coords[1]), parseRange('0:20:5', 144, coords[2])];
    assert.ok(sel.every(s => s.ok));
    const res = await writeSubset(r.call, info, sel, coords, { path: out, format: 'nc' }, { maxValues: 7, sourceName: 'era5-t2m-sample.nc', now: () => Date.UTC(2026, 10, 9) });
    assert.equal(res.values, sel[0].count * sel[1].count * sel[2].count);
    const w = await reader(out);
    try {
      const wi = await w.call('info', { path: '/t2m' });
      assert.deepEqual(wi.shape, [4, sel[1].count, 5]);
      assert.deepEqual(wi.dims, ['time', 'latitude', 'longitude']);
      assert.equal(wi.cf.units, 'K');
      assert.ok(!wi.attrs.some(a => a.name === 'scale_factor'), 'packing removed: values are decoded');
      for (const [t, y, x] of [[0, 0, 0], [3, sel[1].count - 1, 4], [2, 1, 3]]) {
        const got = await w.call('read', { path: '/t2m', view: { rowAxis: 1, colAxis: 2, index: [t, 0, 0], rowStart: y, rowCount: 1, colStart: x, colCount: 1 }, decode: true });
        const src = await r.call('read', { path: '/t2m', view: { rowAxis: 1, colAxis: 2, index: [sel[0].start + t, 0, 0], rowStart: sel[1].start + y, rowCount: 1, colStart: sel[2].start + x * 5, colCount: 1 }, decode: true });
        assert.equal(got.values[0][0], src.values[0][0]);
      }
      const tw = await w.call('read', { path: '/time', view: { rowAxis: 0, colAxis: -1, index: [0], rowCount: 4 }, decode: true });
      assert.deepEqual(tw.times.map(v => v[0]), coords[0].times.slice(2, 6), 'time keeps its units and decodes to the same dates');
      const root = await w.call('info', { path: '/' });
      assert.match(root.attrs.find(a => a.name === 'history').value, /subset of \/t2m \[time=2:5, latitude=\d+:\d+, longitude=0:20:5\] from era5-t2m-sample.nc/);
    } finally { w.close(); }
    // scipy (if installed) reads the file as a standard NetCDF-3 64-bit offset file.
    let py = null;
    try { py = execFileSync('python3', ['-c', 'import sys; from scipy.io import netcdf_file as f; d=f(sys.argv[1],"r",mmap=False); v=d.variables["t2m"]; print(d.version_byte, v.shape, d.variables["latitude"][0], round(float(v[0,0,0]),4))', out], { encoding: 'utf8', cwd: tmp }).trim(); } catch { py = null; }
    if (py) assert.match(py, /^2 \(4, \d+, 5\) [\d.]+ [\d.]+$/);
  } finally { r.close(); }
});

test('subset to CSV: tidy rows with dates and coordinates, fill as empty, formula guard', async () => {
  const r = await reader(S('era5-t2m-sample.nc'));
  const out = path.join(tmp, 'tp.csv');
  try {
    const info = await r.call('info', { path: '/tp' });
    const coords = [{ values: [], times: Array.from({ length: 24 }, (_, i) => `2024-12-${String(1 + i).padStart(2, '0')}`), units: null }, { values: Array.from({ length: 73 }, (_, i) => 90 - 2.5 * i), times: null, units: 'degrees_north' }, null];
    const sel = [parseRange('0', 24, coords[0]), parseRange('71:72', 73, coords[1]), parseRange('2:4', 144, null)];
    await writeSubset(r.call, info, sel, coords, { path: out, format: 'csv' }, { maxValues: 4 });
    const lines = fs.readFileSync(out, 'utf8').trim().split('\r\n');
    assert.equal(lines[0], 'time,latitude (degrees_north),longitude,tp (m)');
    assert.equal(lines.length, 1 + 1 * 2 * 3);
    assert.match(lines[1], /^2024-12-01,-87.5,2,/);
  } finally { r.close(); }
  await assert.rejects(writeSubset(async () => ({}), { shape: [CSV_MAX_VALUES + 1], name: 'x', path: '/x' }, [{ start: 0, count: CSV_MAX_VALUES + 1, step: 1 }], [null], { path: path.join(tmp, 'x.csv'), format: 'csv' }), /CSV export stops/);
  assert.ok(!fs.existsSync(path.join(tmp, 'x.csv')));
});

test('a cancelled subset leaves no file', async () => {
  const r = await reader(S('era5-t2m-sample.nc'));
  try {
    const info = await r.call('info', { path: '/t2m' });
    const out = path.join(tmp, 'cancel.nc');
    const res = await writeSubset(r.call, info, info.shape.map(n => ({ start: 0, count: n, step: 1 })), [null, null, null], { path: out, format: 'nc' }, { maxValues: 100, cancelled: () => true });
    assert.equal(res.cancelled, true);
    assert.ok(!fs.existsSync(out));
    assert.ok(!fs.readdirSync(tmp).some(f => f.startsWith('cancel.nc.part')));
  } finally { r.close(); }
});

test('webview may ask for the Pro tools only by name', () => {
  assert.deepEqual(validateRequest({ type: 'pro', action: 'compare' }).req, { type: 'pro', action: 'compare' });
  assert.deepEqual(validateRequest({ type: 'pro', action: 'subset', path: '/t2m' }).req, { type: 'pro', action: 'subset', path: '/t2m' });
  assert.equal(validateRequest({ type: 'pro', action: 'unlock' }).ok, false);
  assert.equal(validateRequest({ type: 'pro', action: 'subset', path: 'no-slash' }).ok, false);
});

test('3 free tries per tool, then one explanation with the ways to unlock; licensed never asks', async () => {
  const { createPro, TRIAL_USES } = require('../src/pro');
  const store = new Map(), status = [], asked = [];
  const vscode = {
    EventEmitter: class { constructor() { this.l = []; this.event = f => { this.l.push(f); return { dispose() {} }; }; } fire(v) { this.l.forEach(f => f(v)); } dispose() {} },
    window: { setStatusBarMessage: t => status.push(t) }, commands: { executeCommand: async () => {} },
  };
  const context = { globalState: { get: k => store.get(k), update: async (k, v) => store.set(k, v) }, subscriptions: [] };
  let licensed = false;
  const license = { isPro: () => licensed, onDidChange: () => ({ dispose() {} }), ready: Promise.resolve(), refresh: () => Promise.resolve(), handleUri: () => false, requirePro: async (t, d) => { asked.push(d); return false; } };
  const p = createPro({ vscode, context, license });
  assert.equal(TRIAL_USES, 3);
  for (let i = 0; i < 3; i++) { assert.equal(await p.allowed('subset'), true); await p.useTrial('subset'); }
  assert.equal(await p.allowed('subset'), false);
  assert.equal(p.trialLeft('compare'), 3);
  assert.match(asked[0], /used the 3 free tries/);
  assert.match(asked[0], /USD 19 once/);
  assert.match(asked[0], /Export slice/);
  licensed = true;
  assert.equal(await p.allowed('subset'), true);
  assert.equal(asked.length, 1);
});

test('bundled extension: Pro commands register, and a subset export and a compare run through the real worker', { skip: !fs.existsSync(root + 'dist/extension.js') && 'not built' }, async () => {
  const registered = {};
  const answers = { input: [], quick: [], save: [], open: [] };
  const shown = [], panels = [];
  let provider;
  const Uri = { file: p => ({ scheme: 'file', fsPath: p, path: p, toString() { return 'file://' + p; } }), joinPath: (u, ...p) => ({ fsPath: [u.fsPath, ...p].join('/'), path: [u.fsPath, ...p].join('/') }), parse: s => ({ toString: () => s }) };
  const store = new Map(), secrets = new Map();
  const vscode = {
    Uri, RelativePattern: class {}, ProgressLocation: { Notification: 15 }, ViewColumn: { Active: -1 },
    EventEmitter: class { constructor() { this.l = []; this.event = f => { this.l.push(f); return { dispose() {} }; }; } fire(v) { this.l.forEach(f => f(v)); } dispose() {} },
    authentication: { getSession: async () => undefined, onDidChangeSessions: () => ({ dispose() {} }) },
    window: {
      registerCustomEditorProvider: (id, p) => { provider = provider || p; return { dispose() {} }; }, registerUriHandler: () => ({ dispose() {} }),
      onDidChangeWindowState: () => ({ dispose() {} }), state: { focused: true },
      setStatusBarMessage() {}, showInformationMessage: async (m) => { shown.push(m); return undefined; }, showErrorMessage: async m => { shown.push('ERR ' + m); }, showWarningMessage: async m => { shown.push('WARN ' + m); },
      showInputBox: async o => { const a = answers.input.shift(); assert.equal(typeof o.validateInput(a), 'object', `${a} should be valid for ${o.title}`); return a; },
      showQuickPick: async items => items.find(i => i.format === answers.quick.shift()),
      showSaveDialog: async () => answers.save.shift(), showOpenDialog: async () => answers.open.shift(),
      withProgress: async (o, fn) => fn({ report() {} }, { isCancellationRequested: false }),
      createWebviewPanel: (type, title) => { const p = { type, title, webview: { cspSource: 'x', html: '', onDidReceiveMessage: () => ({ dispose() {} }) } }; panels.push(p); return p; },
    },
    commands: { registerCommand: (id, fn) => { registered[id] = fn; return { dispose() {} }; }, executeCommand: async () => {} },
    workspace: { getConfiguration: () => ({ get: (k, d) => d }), createFileSystemWatcher: () => ({ onDidChange() {}, dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }), fs: { writeFile: async () => {} } },
    env: { clipboard: { writeText: async () => {} }, openExternal: async () => true },
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : orig.call(this, req, ...rest); };
  try {
    const ext = require(root + 'dist/extension.js');
    ext.activate({ subscriptions: [], extensionUri: Uri.file(root.replace(/\/$/, '')), extensionPath: root,
      globalState: { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => { store.set(k, v); }, keys: () => [...store.keys()], setKeysForSync() {} },
      secrets: { get: async k => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async k => { secrets.delete(k); }, onDidChange: () => ({ dispose() {} }) } });
    const pkg = JSON.parse(fs.readFileSync(root + 'package.json', 'utf8'));
    for (const c of pkg.contributes.commands) assert.ok(registered[c.command], 'registered: ' + c.command);
    // Subset from the command: variable given by the webview path, ranges, NetCDF format, a file.
    const out = path.join(tmp, 'e2e.nc');
    answers.input.push('0:1', '', '10:12'); answers.quick.push('nc'); answers.save.push(Uri.file(out));
    const fromHost = []; let onMsg;
    const webview = { cspSource: 'x', asWebviewUri: u => 'x' + u.path, postMessage: m => { fromHost.push(m); return Promise.resolve(true); }, onDidReceiveMessage: cb => { onMsg = cb; return { dispose() {} }; } };
    let disposeCb;
    provider.resolveCustomEditor(provider.openCustomDocument(Uri.file(S('era5-t2m-sample.nc'))), { webview, onDidDispose: cb => { disposeCb = cb; } });
    await onMsg({ type: 'ready' });
    assert.deepEqual(fromHost[0].pro, { show: true, licensed: false, trials: { compare: 3, subset: 3 } });
    await onMsg({ type: 'pro', action: 'subset', path: '/t2m' });
    assert.ok(fs.existsSync(out), 'subset written: ' + shown.join(' | '));
    assert.equal(store.get('hdf5NetcdfExplorer.proTrial').subset, 1);
    // Compare the file with itself from the header button.
    answers.open.push([Uri.file(S('era5-t2m-sample.nc'))]);
    await onMsg({ type: 'pro', action: 'compare' });
    assert.equal(panels.length, 1, shown.join(' | '));
    assert.match(panels[0].webview.html, /Every variable and attribute is the same in both files/);
    disposeCb();
  } finally { Module._load = orig; }
});

test('package.json: Pro commands, settings, version, no old price', () => {
  const pkg = JSON.parse(fs.readFileSync(root + 'package.json', 'utf8'));
  const cmds = pkg.contributes.commands.map(c => c.command);
  for (const c of ['compareFiles', 'exportSubset', 'getPro', 'unlockWithSponsors', 'enterLicenseKey', 'removeLicense']) assert.ok(cmds.includes('hdf5NetcdfExplorer.' + c), c);
  const props = pkg.contributes.configuration.properties;
  assert.equal(props['hdf5NetcdfExplorer.showProFeatures'].default, true);
  assert.equal(props['hdf5NetcdfExplorer.compareTolerance'].default, 0);
  for (const m of pkg.contributes.menus.commandPalette) assert.match(m.when, /proLicensed/);
  assert.equal(pkg.engines.vscode, '^1.90.0');
  const text = JSON.stringify(pkg) + fs.readFileSync(root + 'README.md', 'utf8');
  assert.ok(!/USD 15/.test(text));
});

test('shared Pro files are byte-identical to the factory license module and to the NumPy viewer copies (when present)', () => {
  const lic = path.join(os.homedir(), 'plugin-market-intel-work', 'factory', 'sprint', 'license');
  if (fs.existsSync(lic)) for (const f of ['index.js', 'license.js', 'sponsors.js']) assert.ok(fs.readFileSync(root + 'src/license/' + f).equals(fs.readFileSync(path.join(lic, f))), f);
});
