// Plot controls (colour maps, range modes, log scale) and "Save PNG" (protocol, host-side PNG check, save dialog).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  colormap, viridis, COLORMAPS, isColormap, percentileRange, colorRange, minMaxRange, symmetricRange, customRange,
  attrRange, makeScale, resolveRange, colorbarTicks, finiteSample,
} from '../src/webview/util.js';
import { validateRequest, decodePngDataUrl, pngFileName, MAX_PNG_DATA_URL, PNG_PREFIX } from '../src/core/protocol.mjs';
import { Session } from '../src/core/session.mjs';
import { S } from './helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'h5x-png-'));

// The viridis of 0.2.x, copied here so a change to the default picture fails this test.
const OLD = [[68, 1, 84], [71, 44, 122], [59, 81, 139], [44, 113, 142], [33, 144, 141], [39, 173, 129], [92, 200, 99], [170, 220, 50], [253, 231, 37]];
function oldViridis(t) {
  if (!(t >= 0)) t = 0; if (t > 1) t = 1;
  const x = t * (OLD.length - 1), i = Math.min(OLD.length - 2, Math.floor(x)), f = x - i;
  const a = OLD[i], b = OLD[i + 1];
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}

/** A real 1x1 PNG, built with zlib so the test needs no image file. */
function tinyPng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 68, 1, 84]))), chunk('IEND', Buffer.alloc(0))]);
}
const pngUrl = () => PNG_PREFIX + tinyPng().toString('base64');

test('colour maps: viridis output is unchanged, every map has its endpoints, reverse flips', () => {
  for (let k = 0; k <= 1000; k++) {
    const t = k / 1000;
    assert.deepEqual(colormap('viridis')(t), oldViridis(t), 't=' + t);
    assert.deepEqual(viridis(t), oldViridis(t));
  }
  const ends = {
    viridis: [[68, 1, 84], [253, 231, 37]], cividis: [[0, 32, 77], [255, 233, 69]], magma: [[0, 0, 4], [252, 253, 191]],
    inferno: [[0, 0, 4], [252, 255, 164]], plasma: [[13, 8, 135], [240, 249, 33]], turbo: [[48, 18, 59], [122, 4, 3]],
    gray: [[0, 0, 0], [255, 255, 255]], coolwarm: [[5, 48, 97], [103, 0, 31]],
  };
  assert.deepEqual(COLORMAPS.map(m => m[0]).sort(), Object.keys(ends).sort());
  for (const [name, [lo, hi]] of Object.entries(ends)) {
    const f = colormap(name), r = colormap(name, true);
    assert.deepEqual(f(0), lo, name); assert.deepEqual(f(1), hi, name);
    assert.deepEqual(r(0), hi, name + ' reversed'); assert.deepEqual(r(1), lo, name + ' reversed');
    assert.deepEqual(r(0.3), f(0.7), name);
    assert.deepEqual(f(-5), lo); assert.deepEqual(f(7), hi); assert.deepEqual(f(NaN), lo);
    for (const c of f(0.37)) assert.ok(Number.isInteger(c) && c >= 0 && c <= 255);
  }
  assert.deepEqual(colormap('gray')(0.5), [128, 128, 128]);
  assert.deepEqual(colormap('coolwarm')(0.5), [247, 247, 247]); // diverging: white in the middle
  assert.equal(isColormap('jet'), false);
  assert.deepEqual(colormap('jet')(1), [253, 231, 37]); // unknown names fall back to viridis
  assert.equal(isColormap('__proto__'), false);
});

test('ranges: min-max, 2-98 percentile on a known array, symmetric, sampling above 1e6', () => {
  const a = Array.from({ length: 101 }, (_, i) => i); // 0..100
  assert.deepEqual(percentileRange(a), { lo: 2, hi: 98 });
  assert.deepEqual(colorRange(a), { lo: 2, hi: 98 });
  assert.deepEqual(percentileRange([5, null, 'NaN', 'Inf', ...a]), { lo: 2, hi: 98 });
  assert.equal(percentileRange([null, 'NaN']), null);
  assert.deepEqual(percentileRange([3, 3, 3]), { lo: 3, hi: 4 });
  assert.deepEqual(minMaxRange([4, -2, null, 9, 'NaN']), { lo: -2, hi: 9 });
  assert.deepEqual(minMaxRange([7]), { lo: 7, hi: 8 });
  assert.equal(minMaxRange([]), null);
  assert.deepEqual(symmetricRange([-3, 1, 2]), { lo: -3, hi: 3 });
  assert.deepEqual(symmetricRange([0.5, 2]), { lo: -2, hi: 2 });
  assert.deepEqual(symmetricRange([0, 0]), { lo: -1, hi: 1 });
  assert.equal(symmetricRange(['NaN']), null);
  const big = new Float64Array(3_000_001).map((_, i) => i);
  const s = finiteSample(big);
  assert.ok(s.length <= 1_000_000 && s.length > 700_000);
  const p = percentileRange(big);
  assert.ok(Math.abs(p.lo - 60000) < 10 && Math.abs(p.hi - 2940000) < 10);
});

test('custom range: two finite numbers with min < max', () => {
  assert.deepEqual(customRange('250', '310.5'), { ok: true, lo: 250, hi: 310.5 });
  assert.deepEqual(customRange(-1, 1), { ok: true, lo: -1, hi: 1 });
  for (const [lo, hi] of [['5', '5'], ['6', '5'], ['', '5'], ['a', '5'], ['1', 'Infinity'], [NaN, 2], [undefined, 1], [null, 1], ['1e400', '2']]) {
    const r = customRange(lo, hi);
    assert.equal(r.ok, false, `${lo}..${hi}`);
    assert.match(r.error, /number|smaller/);
  }
});

test('log scale: values <= 0 are no-data, the checkbox needs a range above 0', () => {
  const f = makeScale(1, 100, true);
  assert.equal(f(10), 0.5);
  assert.equal(f(1), 0); assert.equal(f(100), 1);
  assert.equal(f(0), null); assert.equal(f(-5), null); assert.equal(f(null), null); assert.equal(f('NaN'), null);
  assert.equal(makeScale(0, 10, true)(5), null); // a range that is not > 0 never draws on a log scale
  assert.equal(makeScale(0, 10)(5), 0.5);
  assert.equal(makeScale(0, 10)(null), null);
  const vals = [-1, 0, 1, 10, 100];
  const r = resolveRange(vals, { mode: 'minmax', log: true });
  assert.deepEqual([r.lo, r.hi, r.log, r.logOk], [-1, 100, false, false]);
  assert.match(r.error, /Log scale needs a range above 0/);
  const c = resolveRange(vals, { mode: 'custom', custom: { min: '1', max: '100' }, log: true });
  assert.deepEqual([c.lo, c.hi, c.log, c.logOk, c.error], [1, 100, true, true, undefined]);
  assert.deepEqual(colorbarTicks(1, 1000, true), [1, 10, 100, 1000]);
  assert.deepEqual(colorbarTicks(2, 500, true), [2, 10, 100, 500]);
  assert.deepEqual(colorbarTicks(0, 10, false), [0, 2, 4, 6, 8, 10]);
});

test('resolveRange: every mode, and a bad custom range falls back to 2-98 percentile with a message', () => {
  const a = Array.from({ length: 101 }, (_, i) => i - 20); // -20..80
  assert.deepEqual([resolveRange(a, { mode: 'minmax' }).lo, resolveRange(a, { mode: 'minmax' }).hi], [-20, 80]);
  assert.deepEqual([resolveRange(a).lo, resolveRange(a).hi], [-18, 78]);
  assert.deepEqual([resolveRange(a, { mode: 'symmetric' }).lo, resolveRange(a, { mode: 'symmetric' }).hi], [-80, 80]);
  const bad = resolveRange(a, { mode: 'custom', custom: { min: '9', max: '3' } });
  assert.deepEqual([bad.lo, bad.hi], [-18, 78]);
  assert.match(bad.error, /smaller/);
  const none = resolveRange(a, { mode: 'attrs', attrs: [] });
  assert.match(none.error, /actual_range/);
  const at = resolveRange(a, { mode: 'attrs', attrs: [{ name: 'valid_min', value: -50 }, { name: 'valid_max', value: 50 }] });
  assert.deepEqual([at.lo, at.hi, at.error], [-50, 50, undefined]);
  assert.equal(resolveRange([null, 'NaN'], { mode: 'minmax' }), null);
});

test('attribute range from CF attributes: actual_range, valid_range, valid_min/valid_max, packed values', () => {
  assert.deepEqual(attrRange([{ name: 'actual_range', value: [230.5, 310] }, { name: 'valid_range', value: [0, 1] }]), { lo: 230.5, hi: 310, source: 'actual_range' });
  assert.deepEqual(attrRange([{ name: 'valid_range', value: [-100, 100] }]), { lo: -100, hi: 100, source: 'valid_range' });
  assert.deepEqual(attrRange([{ name: 'valid_min', value: [0] }, { name: 'valid_max', value: 40 }]), { lo: 0, hi: 40, source: 'valid_min/valid_max' });
  // valid_* of a packed variable are stored values: decoded data needs scale_factor and add_offset applied.
  const packed = [{ name: 'valid_range', value: [-32000, 32000] }, { name: 'scale_factor', value: 0.0025 }, { name: 'add_offset', value: 260 }];
  const pr = attrRange(packed, { decoded: true });
  assert.ok(Math.abs(pr.lo - 180) < 1e-9 && Math.abs(pr.hi - 340) < 1e-9 && pr.source === 'valid_range', JSON.stringify(pr));
  assert.deepEqual(attrRange(packed, { decoded: false }), { lo: -32000, hi: 32000, source: 'valid_range' });
  assert.deepEqual(attrRange([{ name: 'actual_range', value: [1, 2] }, { name: 'scale_factor', value: 10 }], { decoded: true }), { lo: 1, hi: 2, source: 'actual_range' });
  assert.equal(attrRange([{ name: 'valid_min', value: 5 }]), null);
  assert.equal(attrRange([{ name: 'actual_range', value: [3, 3] }]), null);
  assert.equal(attrRange([{ name: 'actual_range', value: ['NaN', 2] }]), null);
  assert.equal(attrRange([{ name: 'units', value: 'K' }]), null);
  assert.equal(attrRange(undefined), null);
});

test('protocol: savePng is checked (prefix, size, PNG bytes, name)', () => {
  const url = pngUrl();
  const ok = validateRequest({ type: 'savePng', reqId: 4, dataUrl: url, name: 't2m-time0.png' });
  assert.deepEqual(ok, { ok: true, req: { type: 'savePng', reqId: 4, dataUrl: url, name: 't2m-time0.png' } });
  assert.equal(validateRequest({ type: 'savePng', reqId: 4, dataUrl: url }).req.name, 'plot.png');
  assert.equal(validateRequest({ type: 'savePng', reqId: 4, dataUrl: url, name: '../../etc/x y.PNG' }).req.name, 'etc_x_y.png');
  const bad = [
    { type: 'savePng', dataUrl: url },
    { type: 'savePng', reqId: 1, dataUrl: 'data:image/jpeg;base64,' + tinyPng().toString('base64') },
    { type: 'savePng', reqId: 1, dataUrl: 'javascript:alert(1)' },
    { type: 'savePng', reqId: 1, dataUrl: 42 },
    { type: 'savePng', reqId: 1, dataUrl: PNG_PREFIX + Buffer.from('GIF89a, not a png at all').toString('base64') },
    { type: 'savePng', reqId: 1, dataUrl: PNG_PREFIX },
    { type: 'savePng', reqId: 1, dataUrl: url, name: 5 },
    { type: 'savePng', reqId: 1, dataUrl: url, name: 'x'.repeat(201) },
  ];
  for (const m of bad) assert.equal(validateRequest(m).ok, false, JSON.stringify(m).slice(0, 80));
  const huge = validateRequest({ type: 'savePng', reqId: 1, dataUrl: url + 'A'.repeat(MAX_PNG_DATA_URL) });
  assert.equal(huge.ok, false);
  assert.match(huge.error, /too large/);
  assert.equal(pngFileName(''), 'plot.png');
  assert.equal(pngFileName('.hidden'), 'hidden.png');
});

test('protocol: copy text is limited (Copy as CSV of a long series still fits)', () => {
  assert.equal(validateRequest({ type: 'copy', text: 'x'.repeat(3_000_000) }).ok, true);
  assert.equal(validateRequest({ type: 'copy', text: 'x'.repeat(4_000_001) }).ok, false);
});

test('host-side PNG check decodes the whole picture', () => {
  const bytes = decodePngDataUrl(pngUrl());
  assert.deepEqual(bytes, tinyPng());
  assert.throws(() => decodePngDataUrl('data:image/gif;base64,R0lGOD'), /not a PNG data URL/);
  assert.throws(() => decodePngDataUrl(PNG_PREFIX + Buffer.from('not a png, just text').toString('base64')), /not a PNG picture/);
  assert.throws(() => decodePngDataUrl(PNG_PREFIX + 'iVBORw0KGgo<script>'), /bad base64/);
  assert.throws(() => decodePngDataUrl(PNG_PREFIX + 'iVBORw0KGgoAA'), /bad base64/); // not a multiple of 4
  assert.throws(() => decodePngDataUrl(pngUrl() + 'A'.repeat(MAX_PNG_DATA_URL)), /too large/);
});

test('Session savePng: save dialog with the suggested name, write the bytes, cancel writes nothing, bad pictures never ask', async () => {
  const dir = tmp();
  const out = [], asked = [], written = {};
  let answer = name => ({ path: path.join(dir, name) });
  const s = new Session({
    fileName: 'era5-t2m-sample.nc', post: m => out.push(m), createWorker: () => { throw new Error('no worker needed'); },
    choosePngFile: async ({ defaultName }) => { asked.push(defaultName); return answer(defaultName); },
    writePng: async (p, b) => { written[p] = b; fs.writeFileSync(p, b); },
  });
  try {
    await s.handle({ type: 'savePng', reqId: 1, dataUrl: pngUrl(), name: 't2m-time0.png' });
    assert.equal(out[0].ok, true, out[0].error);
    assert.deepEqual(asked, ['t2m-time0.png']);
    assert.equal(out[0].data.file, path.join(dir, 't2m-time0.png'));
    assert.deepEqual(fs.readFileSync(path.join(dir, 't2m-time0.png')), tinyPng());
    answer = () => null;
    await s.handle({ type: 'savePng', reqId: 2, dataUrl: pngUrl(), name: 'a.png' });
    assert.deepEqual(out[1].data, { cancelled: true });
    await s.handle({ type: 'savePng', reqId: 3, dataUrl: PNG_PREFIX + 'iVBORw0KGgo' + '%%%%', name: 'a.png' });
    assert.equal(out[2].ok, false);
    assert.match(out[2].error, /could not be saved: bad base64/);
    assert.equal(asked.length, 2);
    assert.equal(Object.keys(written).length, 1);
    const noHost = new Session({ fileName: 'f', post: m => out.push(m), createWorker: () => null });
    await noHost.handle({ type: 'savePng', reqId: 9, dataUrl: pngUrl() });
    assert.match(out.at(-1).error, /not available/);
  } finally { s.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('manifest: the colormap setting lists exactly the maps the viewer draws', () => {
  const pkg = JSON.parse(fs.readFileSync(root + 'package.json', 'utf8'));
  const c = pkg.contributes.configuration.properties['hdf5NetcdfExplorer.colormap'];
  assert.equal(c.default, 'viridis');
  assert.deepEqual(c.enum, COLORMAPS.map(m => m[0]));
  assert.equal(c.enumDescriptions.length, c.enum.length);
});

test('bundled extension: Save PNG through the save dialog, never over the source file; colormap setting reaches init', { skip: !fs.existsSync(root + 'dist/extension.js') && 'not built' }, async () => {
  const { default: Module, createRequire } = await import('node:module');
  const dir = tmp();
  const providers = {}, infos = [];
  let saveAnswer, dialogOpts;
  class Uri { constructor(p) { this.scheme = 'file'; this.fsPath = p; this.path = p; } static file(p) { return new Uri(p); } static joinPath(u, ...p) { return new Uri([u.fsPath, ...p].join('/')); } }
  const vscode = {
    Uri, RelativePattern: class {},
    window: {
      registerCustomEditorProvider: (id, p) => { providers[id] = p; return { dispose() {} }; },
      setStatusBarMessage() {}, showSaveDialog: async o => { dialogOpts = o; return saveAnswer; },
      showInformationMessage: (m) => { infos.push(m); return Promise.resolve(undefined); },
    },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => (k === 'colormap' ? 'magma' : d) }),
      createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, dispose() {} }),
      fs: { writeFile: async (u, b) => fs.writeFileSync(u.fsPath, b) },
    },
    env: { clipboard: { writeText: async () => {} } },
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : orig.call(this, req, ...rest); };
  try {
    const ext = createRequire(import.meta.url)(root + 'dist/extension.js');
    ext.activate({ subscriptions: [], extensionUri: Uri.file(root.replace(/\/$/, '')), extensionPath: root, globalState: { get: () => undefined, update: async () => {} } });
    const src = path.join(dir, 'era5.nc');
    fs.copyFileSync(S('era5-t2m-sample.nc'), src);
    const fromHost = []; let onMsg, disposeCb;
    const webview = { cspSource: 'vscode-webview://t', asWebviewUri: u => 'vscode-webview://t' + u.path, postMessage: m => { fromHost.push(m); return Promise.resolve(true); }, onDidReceiveMessage: cb => { onMsg = cb; return { dispose() {} }; } };
    const p = providers['hdf5NetcdfExplorer.viewer'];
    p.resolveCustomEditor(p.openCustomDocument(Uri.file(src)), { webview, onDidDispose: cb => { disposeCb = cb; } });
    const wait = async n => { for (let i = 0; i < 400 && fromHost.length < n; i++) await new Promise(r => setTimeout(r, 25)); };
    onMsg({ type: 'ready' }); await wait(1);
    assert.deepEqual(fromHost[0].ui, { colormap: 'magma' });

    saveAnswer = Uri.file(src);
    onMsg({ type: 'savePng', reqId: 1, dataUrl: pngUrl(), name: 't2m-time0.png' }); await wait(2);
    assert.equal(fromHost[1].ok, false);
    assert.match(fromHost[1].error, /never overwrites/);
    assert.equal(dialogOpts.defaultUri.fsPath, path.join(dir, 't2m-time0.png'));
    assert.deepEqual(dialogOpts.filters, { 'PNG image': ['png'] });
    assert.equal(fs.statSync(src).size, fs.statSync(S('era5-t2m-sample.nc')).size);

    saveAnswer = Uri.file(path.join(dir, 't2m-time0.png'));
    onMsg({ type: 'savePng', reqId: 2, dataUrl: pngUrl(), name: 't2m-time0.png' }); await wait(3);
    assert.equal(fromHost[2].ok, true, fromHost[2].error);
    assert.deepEqual(fs.readFileSync(path.join(dir, 't2m-time0.png')), tinyPng());
    assert.deepEqual(infos, ['Saved t2m-time0.png']);
    disposeCb();
  } finally { Module._load = orig; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('plot.js draws the heatmap, the colour bar and both PNG pictures on a stub canvas', async () => {
  const texts = [];
  const ctx = () => new Proxy({ texts }, {
    get: (t, k) => (k === 'fillText' ? (s) => texts.push(String(s)) : k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  const canvas = () => ({ style: {}, dataset: {}, width: 0, height: 0, getContext: () => ctx(), toDataURL: type => `data:${type};base64,iVBORw0KGgo=` });
  const saved = { document: globalThis.document, ImageData: globalThis.ImageData, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle };
  globalThis.document = { createElement: () => canvas(), body: {} };
  globalThis.ImageData = class { constructor(w, h) { this.data = new Uint8ClampedArray(w * h * 4); } };
  globalThis.window = { devicePixelRatio: 2 };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  try {
    const { heatmap, heatmapPng, linePlot, linePng } = await import('../src/webview/plot.js');
    const rows = [[1, 10, null], [100, 'NaN', -1]];
    const c = canvas();
    const p = heatmap(c, rows, { width: 600, cmap: colormap('magma'), range: { lo: 1, hi: 100, log: true } });
    assert.deepEqual([p.rows, p.cols, p.hit(0, 0), p.hit(p.scale * 2.5, p.scale * 1.5), p.hit(-1, 0)], [2, 3, { r: 0, c: 0 }, { r: 1, c: 2 }, null]);
    assert.ok(texts.includes('1') && texts.includes('100') && texts.includes('10'));
    texts.length = 0;
    const url = heatmapPng(rows, { title: 't2m (K), time = 2024-12-04 06:00', cmap: colormap('viridis'), range: { lo: -1, hi: 100, log: false }, rowLabel: 'latitude', colLabel: 'longitude', rowTick: i => 'r' + i, colTick: i => 'c' + i, units: 'K' });
    assert.match(url, /^data:image\/png;base64,/);
    for (const t of ['t2m (K), time = 2024-12-04 06:00', 'latitude', 'longitude', 'r0', 'r1', 'c0', 'c2', 'K']) assert.ok(texts.includes(t), t);
    texts.length = 0;
    assert.ok(linePlot(canvas(), ['2024-12-01', '2024-12-02'], [1, 2], { xLabel: 'time', yLabel: 'K' }));
    assert.match(linePng(['2024-12-01', '2024-12-02'], [1, 2], { title: 't2m at latitude 50, longitude 0 over time', xLabel: 'time' }), /^data:image\/png/);
    assert.ok(texts.includes('t2m at latitude 50, longitude 0 over time') && texts.includes('2024-12-01'));
    assert.equal(linePlot(canvas(), [0, 1], [null, 'NaN']), null);
  } finally { Object.assign(globalThis, saved); }
});
