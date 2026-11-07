// 0.4.0: a station or buoy series stored as (time, lat=1, lon=1) opens as a line along time, not a 1 x 1 heatmap
// (found on an NDBC buoy file in the real-app gate). Heatmaps skip dimensions of length 1 too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { viewToHyperslab } from '../src/core/slice.mjs';
import { openFile } from '../src/core/open.mjs';
import { S, libs } from './helpers.mjs';

test('a 1D view of a 3D variable reads along one dimension with the others fixed', async () => {
  assert.deepEqual(viewToHyperslab([50450, 1, 1], { rowAxis: 0, colAxis: -1, index: [0, 0, 0], rowCount: 50450, rowStep: 13 }).count, [3881, 1, 1]);
  const { backend: b } = await openFile(S('era5-t2m-sample.nc'), libs);
  try {
    const line = b.read('/t2m', { rowAxis: 0, colAxis: -1, index: [0, 10, 20], rowCount: 24 });
    assert.equal(line.rows, 24); assert.equal(line.cols, 1);
    for (const t of [0, 5, 23]) {
      const cell = b.read('/t2m', { rowAxis: 1, colAxis: 2, index: [t, 0, 0], rowStart: 10, rowCount: 1, colStart: 20, colCount: 1 });
      assert.equal(line.values[t][0], cell.values[0][0]);
    }
  } finally { b.close(); }
});

test('the webview picks dimensions longer than 1 and offers "none (line plot)" as the column dimension', () => {
  const src = fs.readFileSync(new URL('../src/webview/main.js', import.meta.url), 'utf8');
  assert.match(src, /const long = info\.shape\.map\(\(n, d\) => d\)\.filter\(d => info\.shape\[d\] > 1\);/);
  assert.match(src, /else if \(long\.length === 1\) \{ state\.view\.rowAxis = long\[0\]; state\.view\.colAxis = -1; \}/);
  assert.match(src, /text: 'none \(line plot\)'/);
  assert.match(src, /const line = nd === 1 \|\| v\.colAxis < 0, ax = v\.rowAxis;/);
  // The line branch uses the row dimension, not dimension 0.
  const lineBranch = src.slice(src.indexOf('  if (line) {'), src.indexOf('  const k = rgbChannels(info);'));
  assert.doesNotMatch(lineBranch, /(dims|coords|start|step)\[0\]/);
});
