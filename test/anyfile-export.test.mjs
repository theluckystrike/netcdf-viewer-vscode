// 0.2.0: HDF5 files with other extensions (JLD2, MATLAB 7.3, Loom, ...), the MATLAB v5 notice,
// and "Export slice" to CSV or JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { detectFormat } from '../src/core/detect.mjs';
import { sniff, openFile } from '../src/core/open.mjs';
import { validateRequest } from '../src/core/protocol.mjs';
import { Session } from '../src/core/session.mjs';
import { toCsv, toJson, csvField, exportFileName, coordAt } from '../src/core/export.mjs';
import { S, libs } from './helpers.mjs';

const F = p => fileURLToPath(new URL('./fixtures/' + p, import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'h5x-test-'));

test('MATLAB v5 MAT-file gets a clear notice; MATLAB 7.3 and JLD2 open as HDF5 behind their user block', () => {
  const v5 = Buffer.from('MATLAB 5.0 MAT-file, Platform: MACI64, Created on: Fri Nov  6 2026');
  const d = detectFormat(v5);
  assert.equal(d.format, 'unsupported');
  assert.match(d.reason, /-v7\.3/);
  assert.equal(sniff(F('matrix-v73.mat')).label, 'HDF5 (user block)');
  assert.equal(sniff(F('model.jld2')).label, 'HDF5 (user block)');
  const dir = tmp();
  try {
    const p = path.join(dir, 'old.mat');
    fs.writeFileSync(p, Buffer.concat([v5, Buffer.alloc(200)]));
    assert.equal(sniff(p).label, 'MATLAB v5 MAT-file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('JLD2 fixture: variables, dimension scales and values read like any HDF5 file', async () => {
  const o = await openFile(F('model.jld2'), libs);
  try {
    const names = o.backend.list('/').items.map(i => i.name).sort();
    assert.deepEqual(names, ['t', 'u', 'x']);
    const info = o.backend.info('/u');
    assert.deepEqual(info.shape, [4, 3]);
    assert.deepEqual(info.coords, ['/t', '/x']);
    const r = o.backend.read('/u', { rowAxis: 0, colAxis: 1, rowCount: 4, colCount: 3 });
    assert.equal(r.values[3][2], 11 / 4);
  } finally { o.backend.close(); }
});

test('manifest: new default extensions, an Open With editor for every file, and the Explorer menu', () => {
  const pkg = JSON.parse(fs.readFileSync(root + 'package.json', 'utf8'));
  const [main, any] = pkg.contributes.customEditors;
  const pats = main.selector.map(s => s.filenamePattern);
  for (const e of ['jld2', 'loom', 'h5mu', 'hf5', 'h5oina', 'h5ebsd', 'edaxh5', 'oh5', 'dream3d', 'geoh5', 'nde', 'cxi']) assert.ok(pats.includes('*.' + e), e);
  assert.ok(!pats.includes('*.mat'), 'MAT files stay opt-in: v5 files are not HDF5');
  assert.equal(any.viewType, 'hdf5NetcdfExplorer.anyFile');
  assert.equal(any.priority, 'option');
  assert.deepEqual(any.selector, [{ filenamePattern: '*' }]);
  const when = pkg.contributes.menus['explorer/context'][0].when;
  const re = new RegExp(when.match(/=~ \/(.*)\/i$/)[1], 'i');
  for (const e of ['.jld2', '.mat', '.loom', '.h5']) assert.ok(re.test(e), e);
  assert.ok(!re.test('.txt'));
});

test('protocol: export requests are checked', () => {
  const ok = validateRequest({ type: 'export', reqId: 1, path: '/t2m', view: { rowAxis: 1, colAxis: 2, index: [2, 0, 0] } });
  assert.deepEqual(ok, { ok: true, req: { type: 'export', reqId: 1, path: '/t2m', view: { rowAxis: 1, colAxis: 2, index: [2, 0, 0] }, decode: true } });
  assert.equal(validateRequest({ type: 'export', reqId: 1, path: '/t2m', view: { rowAxis: 1, colAxis: 1 } }).ok, false);
  assert.equal(validateRequest({ type: 'export', reqId: 1, path: 't2m', view: {} }).ok, false);
  assert.equal(validateRequest({ type: 'export', reqId: 1, path: '/t2m', view: { index: [-1] } }).ok, false);
  assert.equal(validateRequest({ type: 'export', path: '/t2m', view: {} }).ok, false);
});

test('CSV fields: quoting, fill values, full precision and the spreadsheet formula guard', () => {
  assert.equal(csvField(0.1 + 0.2), '0.30000000000000004');
  assert.equal(csvField(null), '');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('line\nbreak'), '"line\nbreak"');
  assert.equal(csvField('=HYPERLINK("x")', true), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvField('-5'), '-5');
  assert.equal(csvField(-5, true), '-5');
  assert.equal(csvField([1, 2]), '"[1,2]"');
  assert.equal(coordAt(null, 7), 7);
  assert.equal(coordAt({ values: [1, 2], times: [null, '2024-01-02'] }, 1), '2024-01-02');
  assert.equal(exportFileName({ name: 't2m', shape: [3, 4, 5], dims: ['time', 'lat', 'lon'] }, { rowAxis: 1, colAxis: 2, index: [2, 0, 0] }, 'csv'), 't2m_time2.csv');
  assert.equal(exportFileName({ name: '../x y', shape: [2] }, { rowAxis: 0, colAxis: -1, index: [0] }, 'json'), 'x_y.json');
});

test('toCsv and toJson: 2D grid, 1D column, compound table, scalar and text from the file', () => {
  const info2 = { name: 'u', path: '/u', dtype: 'float32', shape: [2, 3], dims: ['y', 'x'], cf: { units: 'm/s' } };
  const data2 = { start: [0, 0], step: [1, 1], rows: 2, cols: 3, values: [[1, null, 'NaN'], [4.5, 5, 6]], times: null, decoded: true };
  const csv = toCsv({ info: info2, view: { rowAxis: 0, colAxis: 1 }, data: data2, rowCoord: { values: [-10, 10] }, colCoord: { values: [100, 200, 300] } });
  assert.equal(csv, 'y \\ x,100,200,300\n-10,1,,NaN\n10,4.5,5,6\n');
  const j = JSON.parse(toJson({ info: info2, view: { rowAxis: 0, colAxis: 1 }, data: data2, rowCoord: null, colCoord: null, fixed: [], fileName: 'f.h5' }));
  assert.deepEqual([j.rowDim, j.colDim, j.units, j.rowCoords, j.colCoords, j.values], ['y', 'x', 'm/s', [0, 1], [0, 1, 2], [[1, null, 'NaN'], [4.5, 5, 6]]]);

  const info1 = { name: 'time', path: '/time', shape: [2], dims: ['time'], cf: {} };
  const data1 = { start: [0], step: [1], rows: 2, cols: 1, values: [[0], [1]], times: [['2024-12-01'], ['2024-12-02']] };
  assert.equal(toCsv({ info: info1, view: { rowAxis: 0, colAxis: -1 }, data: data1 }), 'time,time\n0,2024-12-01\n1,2024-12-02\n');
  assert.deepEqual(JSON.parse(toJson({ info: info1, view: { rowAxis: 0, colAxis: -1 }, data: data1 })).times, ['2024-12-01', '2024-12-02']);

  const infoC = { name: 'table', path: '/table', shape: [2], dims: ['dim_0'], compound: ['id', 'name'] };
  const dataC = { start: [0], step: [1], rows: 2, cols: 1, values: [[[1, '=cmd()']], [[2, 'ok, fine']]] };
  assert.equal(toCsv({ info: infoC, view: { rowAxis: 0, colAxis: -1 }, data: dataC }), 'dim_0,id,name\n0,1,\'=cmd()\n1,2,"ok, fine"\n');

  const info0 = { name: 'answer', path: '/answer', shape: [], dims: [] };
  assert.equal(toCsv({ info: info0, view: { rowAxis: 0, colAxis: -1 }, data: { values: [[42]], rows: 1, cols: 1, start: [], step: [] } }), 'answer\n42\n');
  assert.equal(JSON.parse(toJson({ info: info0, view: { rowAxis: 0, colAxis: -1 }, data: { values: [[42]], rows: 1, cols: 1, start: [], step: [] } })).values, 42);
});

const realWorker = file => () => new Worker(new URL('../src/worker.mjs', import.meta.url), { workerData: { filePath: file, opts: {} } });

test('Session export: whole 2D slice of the NetCDF sample with coordinates, as CSV and JSON; cancel writes nothing', async () => {
  const dir = tmp();
  const out = [];
  const written = {};
  let ask = null;
  const s = new Session({
    fileName: 'era5-t2m-sample.nc', post: m => out.push(m), createWorker: realWorker(S('era5-t2m-sample.nc')),
    chooseExportFile: async ({ defaultName }) => ask(defaultName),
    writeExport: async (p, text) => { written[p] = text; fs.writeFileSync(p, text); },
  });
  try {
    await s.handle({ type: 'ready' });
    await s.handle({ type: 'info', reqId: 1, path: '/t2m' });
    const info = out[1].data;
    assert.deepEqual(info.dims, ['time', 'latitude', 'longitude']);
    const [nt, ny, nx] = info.shape;
    let asked;
    ask = name => { asked = name; return { path: path.join(dir, name), format: 'csv' }; };
    await s.handle({ type: 'export', reqId: 2, path: '/t2m', view: { rowAxis: 1, colAxis: 2, index: [2, 0, 0] } });
    const res = out[2];
    assert.equal(res.ok, true, res.error);
    assert.equal(asked, 't2m_time2.csv');
    assert.deepEqual([res.data.rows, res.data.cols, res.data.format], [ny, nx, 'csv']);
    const lines = fs.readFileSync(path.join(dir, asked), 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, ny + 1);
    assert.match(lines[0], /^latitude \\ longitude,/);
    assert.equal(lines[0].split(',').length, nx + 1);
    // Same numbers as a direct read of row 10.
    await s.handle({ type: 'read', reqId: 3, path: '/t2m', view: { rowAxis: 1, colAxis: 2, index: [2, 0, 0], rowStart: 10, rowCount: 1, colCount: nx } });
    const row10 = out[3].data.values[0].map(v => (v === null ? '' : String(v)));
    assert.deepEqual(lines[11].split(',').slice(1), row10);
    assert.equal(lines[11].split(',')[0], String((await coordFrom(s, out, '/latitude'))[10]));

    ask = name => ({ path: path.join(dir, name.replace(/csv$/, 'json')), format: 'json' });
    await s.handle({ type: 'export', reqId: 5, path: '/t2m', view: { rowAxis: 1, colAxis: 2, index: [2, 0, 0] } });
    assert.equal(out.at(-1).ok, true);
    const j = JSON.parse(fs.readFileSync(path.join(dir, 't2m_time2.json'), 'utf8'));
    assert.deepEqual([j.variable, j.rowDim, j.colDim, j.values.length, j.values[0].length], ['/t2m', 'latitude', 'longitude', ny, nx]);
    assert.equal(j.fixed[0].dim, 'time');
    assert.equal(j.fixed[0].index, 2);
    assert.match(String(j.fixed[0].value), /^2024-12-/);
    assert.equal(j.decoded, true);

    // 1D time coordinate exports dates.
    ask = () => ({ path: path.join(dir, 'time.csv'), format: 'csv' });
    await s.handle({ type: 'export', reqId: 6, path: '/time', view: { rowAxis: 0, colAxis: -1, index: [0] } });
    const tl = fs.readFileSync(path.join(dir, 'time.csv'), 'utf8').split('\n');
    assert.equal(tl.length, nt + 2);
    assert.match(tl[1], /^0,2024-12-01/); // a coordinate is its own axis: the first column is the index

    const before = Object.keys(written).length;
    ask = () => null;
    await s.handle({ type: 'export', reqId: 7, path: '/t2m', view: { rowAxis: 1, colAxis: 2, index: [0, 0, 0] } });
    assert.deepEqual(out.at(-1).data, { cancelled: true });
    assert.equal(Object.keys(written).length, before);
  } finally { s.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

async function coordFrom(s, out, p) {
  await s.handle({ type: 'read', reqId: 4, path: p, view: { rowAxis: 0, colAxis: -1, rowCount: 1000 } });
  return out.at(-1).data.values.map(v => v[0]);
}

test('Session export refuses a slice above maxReadValues before the save dialog, and a group path', async () => {
  const out = [];
  let asked = 0;
  const s = new Session({
    fileName: 'era5-t2m-sample.nc', post: m => out.push(m), createWorker: realWorker(S('era5-t2m-sample.nc')),
    limits: { maxReadValues: 100, maxPathLength: 4096, maxDims: 32, maxPage: 2000 },
    chooseExportFile: async () => { asked++; return null; }, writeExport: async () => { throw new Error('no'); },
  });
  try {
    await s.handle({ type: 'ready' });
    await s.handle({ type: 'export', reqId: 1, path: '/t2m', view: { rowAxis: 1, colAxis: 2, index: [] } });
    assert.equal(out[1].ok, false);
    assert.match(out[1].error, /Export is limited to 100/);
    await s.handle({ type: 'export', reqId: 2, path: '/', view: {} });
    assert.equal(out[2].ok, false);
    assert.equal(asked, 0);
  } finally { s.dispose(); }
});

test('Session export of a compound table and of a string dataset (HDF5 sample)', async () => {
  const dir = tmp();
  const out = [];
  const s = new Session({
    fileName: 'beamline-scan.h5', post: m => out.push(m), createWorker: realWorker(S('beamline-scan.h5')),
    chooseExportFile: async ({ defaultName }) => ({ path: path.join(dir, defaultName), format: 'csv' }),
    writeExport: async (p, t) => fs.writeFileSync(p, t),
  });
  try {
    await s.handle({ type: 'ready' });
    await s.handle({ type: 'export', reqId: 1, path: '/notes/labels', view: { rowAxis: 0, colAxis: -1, index: [0] } });
    assert.equal(out[1].ok, true, out[1].error);
    assert.equal(fs.readFileSync(path.join(dir, 'labels.csv'), 'utf8'), 'dim_0,labels\n0,dark\n1,flat\n2,scan <b>&</b>\n');
    await s.handle({ type: 'export', reqId: 2, path: '/entry/scan/positions', view: { rowAxis: 0, colAxis: -1, index: [0] } });
    assert.equal(out[2].ok, true, out[2].error);
    const pl = fs.readFileSync(path.join(dir, 'positions.csv'), 'utf8').trimEnd().split('\n');
    assert.equal(pl[0], 'dim_0,step,motor_x_mm,motor_y_mm,ok');
    assert.equal(pl.length, 51);
    assert.match(pl[1], /^0,0,0,0,(false|0)$/); // step 0 has ok = false
  } finally { s.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bundled extension: Open With for any file, the palette command on the active tab, export through the save dialog, reload on re-create', { skip: !fs.existsSync(root + 'dist/extension.js') && 'not built' }, async () => {
  const { default: Module, createRequire } = await import('node:module');
  const dir = tmp();
  const providers = {}, commands = {}, opened = [], infos = [];
  let saveAnswer, created;
  class Uri { constructor(p) { this.scheme = 'file'; this.fsPath = p; this.path = p; } static file(p) { return new Uri(p); } static joinPath(u, ...p) { return new Uri([u.fsPath, ...p].join('/')); } }
  const vscode = {
    Uri, RelativePattern: class {},
    window: {
      registerCustomEditorProvider: (id, p) => { providers[id] = p; return { dispose() {} }; },
      setStatusBarMessage() {}, activeTextEditor: undefined,
      tabGroups: { activeTabGroup: { activeTab: { input: { uri: Uri.file(path.join(dir, 'run.output')) } } } },
      showSaveDialog: async () => saveAnswer,
      showInformationMessage: (m, ...b) => { infos.push(m); return Promise.resolve(undefined); },
      showOpenDialog: async () => undefined,
    },
    commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; }, executeCommand: async (...a) => { opened.push(a); } },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => d }),
      createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate(cb) { created = cb; }, dispose() {} }),
      fs: { writeFile: async (u, b) => fs.writeFileSync(u.fsPath, b) },
    },
    env: { clipboard: { writeText: async () => {} } },
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : orig.call(this, req, ...rest); };
  try {
    const ext = createRequire(import.meta.url)(root + 'dist/extension.js');
    ext.activate({ subscriptions: [], extensionUri: Uri.file(root.replace(/\/$/, '')), extensionPath: root, globalState: { get: () => undefined, update: async () => {} } });
    assert.ok(providers['hdf5NetcdfExplorer.viewer'] && providers['hdf5NetcdfExplorer.anyFile']);
    await commands['hdf5NetcdfExplorer.openWith']();
    assert.deepEqual([opened[0][0], opened[0][1].fsPath, opened[0][2]], ['vscode.openWith', path.join(dir, 'run.output'), 'hdf5NetcdfExplorer.anyFile']);
    await commands['hdf5NetcdfExplorer.openWith'](Uri.file('/data/x.JLD2'));
    assert.equal(opened[1][2], 'hdf5NetcdfExplorer.viewer');
    await commands['hdf5NetcdfExplorer.openWith'](Uri.file('/data/x.mat'));
    assert.equal(opened[2][2], 'hdf5NetcdfExplorer.anyFile');

    // A JLD2 file copied under an unknown name opens in the any-file editor.
    const odd = path.join(dir, 'model.output');
    fs.copyFileSync(F('model.jld2'), odd);
    const fromHost = []; let onMsg, disposeCb;
    const webview = { cspSource: 'vscode-webview://t', asWebviewUri: u => 'vscode-webview://t' + u.path, postMessage: m => { fromHost.push(m); return Promise.resolve(true); }, onDidReceiveMessage: cb => { onMsg = cb; return { dispose() {} }; } };
    const p = providers['hdf5NetcdfExplorer.anyFile'];
    p.resolveCustomEditor(p.openCustomDocument(Uri.file(odd)), { webview, onDidDispose: cb => { disposeCb = cb; } });
    const wait = async n => { for (let i = 0; i < 400 && fromHost.length < n; i++) await new Promise(r => setTimeout(r, 25)); };
    onMsg({ type: 'ready' }); await wait(1);
    assert.deepEqual([fromHost[0].format, fromHost[0].error], ['hdf5', undefined]);

    saveAnswer = Uri.file(odd); // the file being viewed: refused
    onMsg({ type: 'export', reqId: 1, path: '/u', view: { rowAxis: 0, colAxis: 1, index: [] } }); await wait(2);
    assert.equal(fromHost[1].ok, false);
    assert.match(fromHost[1].error, /never overwrites/);
    assert.equal(fs.readFileSync(odd).length, fs.readFileSync(F('model.jld2')).length);

    saveAnswer = Uri.file(path.join(dir, 'u.csv'));
    onMsg({ type: 'export', reqId: 2, path: '/u', view: { rowAxis: 0, colAxis: 1, index: [] } }); await wait(3);
    assert.equal(fromHost[2].ok, true, fromHost[2].error);
    assert.equal(fs.readFileSync(path.join(dir, 'u.csv'), 'utf8'), 't \\ x,10,20,30\n0,0,0.25,0.5\n0.5,0.75,1,1.25\n1,1.5,1.75,2\n1.5,2.25,2.5,2.75\n');
    assert.deepEqual(infos, ['Exported to u.csv']);

    saveAnswer = undefined; // dialog cancelled
    onMsg({ type: 'export', reqId: 3, path: '/u', view: { rowAxis: 0, colAxis: 1, index: [] } }); await wait(4);
    assert.deepEqual(fromHost[3].data, { cancelled: true });

    created(); await new Promise(r => setTimeout(r, 650));
    assert.equal(fromHost.at(-1).type, 'reload');
    disposeCb();
  } finally { Module._load = orig; fs.rmSync(dir, { recursive: true, force: true }); }
});
