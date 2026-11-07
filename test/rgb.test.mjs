// 0.4.0: RGB(A) image datasets (8-bit height x width x 3 or 4, or HDF5 CLASS=IMAGE) show as one picture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rgbChannels } from '../src/webview/util.js';
import { openFile } from '../src/core/open.mjs';
import { libs } from './helpers.mjs';

const ds = (shape, dtype, attrs = []) => ({ shape, dtype, numeric: true, compound: null, attrs });

test('rgbChannels: 8-bit (H, W, 3/4) and CLASS=IMAGE, nothing else', () => {
  assert.equal(rgbChannels(ds([240, 320, 3], 'uint8')), 3);
  assert.equal(rgbChannels(ds([240, 320, 4], 'uint8')), 4);
  assert.equal(rgbChannels(ds([240, 320, 3], 'int8')), 3);
  assert.equal(rgbChannels(ds([240, 320, 3], 'uint16', [{ name: 'CLASS', value: 'IMAGE' }])), 3);
  assert.equal(rgbChannels(ds([240, 320, 3], 'uint16')), 0, '16-bit without CLASS=IMAGE is data, not a picture');
  assert.equal(rgbChannels(ds([240, 320, 3], 'float32', [{ name: 'CLASS', value: 'IMAGE' }])), 0);
  assert.equal(rgbChannels(ds([24, 73, 144], 'uint8')), 0, 'time x lat x lon');
  assert.equal(rgbChannels(ds([3, 240, 320], 'uint8')), 0, 'channels first is left as a stack');
  assert.equal(rgbChannels(ds([240, 320], 'uint8')), 0);
  assert.equal(rgbChannels(ds([1, 320, 3], 'uint8')), 0);
  assert.equal(rgbChannels({ ...ds([240, 320, 3], 'uint8'), compound: ['a'] }), 0);
  assert.equal(rgbChannels(null), 0);
});

test('an HDF5 RGB image reads one channel per request with the same sampling (what the picture uses)', async () => {
  const h5wasm = await libs.h5wasm();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc2-rgb-'));
  try {
    const file = path.join(dir, 'micro.h5');
    const H = 600, W = 700, data = new Uint8Array(H * W * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = (y * W + x) * 3; data[k] = x % 256; data[k + 1] = y % 256; data[k + 2] = 200; }
    const f = new h5wasm.File(file, 'w');
    const d = f.create_dataset({ name: 'image', data, shape: [H, W, 3], dtype: '<B' });
    d.create_attribute('CLASS', 'IMAGE');
    f.close();
    const { backend: b } = await openFile(file, libs);
    try {
      const info = b.info('/image');
      assert.equal(info.dtype, 'uint8');
      assert.equal(rgbChannels(info), 3);
      const view = c => ({ rowAxis: 0, colAxis: 1, index: [0, 0, c], rowStart: 0, colStart: 0, rowCount: H, colCount: W, rowStep: Math.ceil(H / 512), colStep: Math.ceil(W / 512) });
      const [R, G, B] = [0, 1, 2].map(c => b.read('/image', view(c), false));
      assert.deepEqual([R.rows, R.cols], [300, 350]);
      assert.equal(R.values[0][10], 20);
      assert.equal(G.values[7][0], 14);
      assert.equal(B.values[299][349], 200);
    } finally { b.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('plot.js rgbImage writes the channels into the pixels and maps the hover to cells', async () => {
  let put = null;
  const ctx = () => new Proxy({}, { get: (t, k) => (k === 'putImageData' ? img => { put = img; } : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  const canvas = () => ({ style: {}, dataset: {}, width: 0, height: 0, getContext: () => ctx(), toDataURL: type => `data:${type};base64,iVBORw0KGgo=` });
  const saved = { document: globalThis.document, ImageData: globalThis.ImageData, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle };
  globalThis.document = { createElement: () => canvas(), body: {} };
  globalThis.ImageData = class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  try {
    const { rgbImage } = await import('../src/webview/plot.js');
    const p = rgbImage(canvas(), [[[255, 0]], [[128, null]], [[7, 300]]], { width: 600 });
    assert.deepEqual([...put.data], [255, 128, 7, 255, 0, 0, 255, 255]);
    assert.deepEqual(p.hit(p.scale * 1.5, 0), { r: 0, c: 1 });
    assert.match(p.pngUrl(), /^data:image\/png/);
  } finally { Object.assign(globalThis, saved); }
});

test('the webview shows height x width for an RGB image and offers the RGB checkbox', () => {
  const src = fs.readFileSync(new URL('../src/webview/main.js', import.meta.url), 'utf8');
  assert.match(src, /if \(rgbChannels\(info\)\) \{ state\.view\.rowAxis = 0; state\.view\.colAxis = 1; \}/);
  assert.match(src, /id: 'plot-rgb'/);
  assert.match(src, /canvas\.id = 'rgb-canvas'/);
});

test('plotSteps keeps the picture shape: one step for both axes unless an axis would get under 16 cells', async () => {
  const { plotSteps } = await import('../src/webview/util.js');
  assert.deepEqual(plotSteps(720, 1440), { rowStep: 3, colStep: 3 }); // OISST: 240 x 480, still 2:1
  assert.deepEqual(plotSteps(480, 640), { rowStep: 2, colStep: 2 }); // camera frame: 240 x 320, still 3:4
  assert.deepEqual(plotSteps(721, 1440), { rowStep: 3, colStep: 3 });
  assert.deepEqual(plotSteps(73, 144), { rowStep: 1, colStep: 1 });
  assert.deepEqual(plotSteps(10, 100000), { rowStep: 1, colStep: 196 }); // a shared step would leave 1 row
  assert.deepEqual(plotSteps(1043, 981), { rowStep: 3, colStep: 3 });
  for (const [r, c] of [[720, 1440], [4096, 4096], [10, 100000], [100000, 3], [1, 1]]) {
    const s = plotSteps(r, c);
    assert.ok(Math.ceil(r / s.rowStep) <= 512 && Math.ceil(c / s.colStep) <= 512);
    assert.ok(Math.ceil(r / s.rowStep) * Math.ceil(c / s.colStep) <= 1_000_000, 'fits maxReadValues');
  }
  const src = fs.readFileSync(new URL('../src/webview/main.js', import.meta.url), 'utf8');
  assert.match(src, /rowCount: rows, colCount: cols, \.\.\.plotSteps\(rows, cols, PLOT_MAX\) \}/);
});
