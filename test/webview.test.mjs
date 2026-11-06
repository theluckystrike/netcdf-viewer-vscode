import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fmtNum, fmtBytes, shapeText, pythonSnippet, viridis, colorRange, ticks } from '../src/webview/util.js';
const require = createRequire(import.meta.url);
const { buildHtml } = require('../src/html.js');

test('number and size formatting', () => {
  assert.equal(fmtNum(null), '—');
  assert.equal(fmtNum(3), '3');
  assert.equal(fmtNum(0.1 + 0.2), '0.3');
  assert.equal(fmtNum(1.5e-7), '1.5000e-7');
  assert.equal(fmtNum('NaN'), 'NaN');
  assert.equal(fmtNum([1, 2.5]), '[1, 2.5]');
  assert.equal(fmtBytes(4e10), '37.3 GB');
  assert.equal(shapeText([24, 73], ['time', 'dim_1']), 'time=24 × 73');
  assert.equal(shapeText([], []), 'scalar');
});

test('python snippets match the slice on screen', () => {
  const hs = { start: [5, 0, 0], count: [1, 73, 144], step: [1, 1, 1], single: [true, false, false] };
  assert.equal(pythonSnippet({ fileName: 'era5.nc', path: '/t2m', lib: 'xarray', shape: [24, 73, 144], dims: ['time', 'latitude', 'longitude'], hs }),
    'import xarray as xr\n\nds = xr.open_dataset("era5.nc")\nda = ds["t2m"].isel(time=5)\nprint(da)');
  const h = pythonSnippet({ fileName: 'scan.h5', path: '/entry/image', lib: 'h5py', shape: [256, 256], dims: [], hs: { start: [0, 0], count: [100, 30], step: [1, 1], single: [false, false] } });
  assert.match(h, /f\["\/entry\/image"\]\[0:100, 0:30\]/);
  const g = pythonSnippet({ fileName: 'a "b".nc', path: '/grp/v', lib: 'xarray', shape: [10], dims: ['x'] });
  assert.match(g, /open_dataset\("a \\"b\\".nc", group="\/grp"\)/);
  assert.match(pythonSnippet({ fileName: 'x.h5', path: '/s', lib: 'h5py', shape: [], dims: [] }), /\[\(\)\]/);
});

test('colormap and axis helpers', () => {
  assert.deepEqual(viridis(0), [68, 1, 84]);
  assert.deepEqual(viridis(1), [253, 231, 37]);
  assert.deepEqual(viridis(NaN), [68, 1, 84]);
  const r = colorRange([1, 2, 3, null, 'NaN', 100]);
  assert.ok(r.lo >= 1 && r.hi <= 100);
  assert.equal(colorRange([null, 'NaN']), null);
  assert.deepEqual(ticks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
});

test('webview HTML has a strict CSP and no inline script without nonce', () => {
  const html = buildHtml({ cspSource: 'vscode-webview://x', scriptUri: 'vscode-webview://x/w.js', styleUri: 'vscode-webview://x/s.css', nonce: 'abc123' });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-abc123'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.match(html, /<script nonce="abc123"/);
});

test('webview and core never build HTML from data or run code', () => {
  for (const f of ['src/webview/main.js', 'src/webview/plot.js', 'src/webview/util.js', 'src/core/hdf5.mjs', 'src/core/netcdf3.mjs', 'src/worker.mjs']) {
    const src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|child_process/, f);
  }
});

test('replaceChildren never gets a null child (it would print "null" in the overview)', () => {
  const src = fs.readFileSync(new URL('../src/webview/main.js', import.meta.url), 'utf8');
  for (const m of src.matchAll(/replaceChildren\(([\s\S]*?)\);\n/g)) assert.doesNotMatch(m[1], /:\s*null\s*[,)]/, m[0].slice(0, 120));
});
