// 0.4.0: coastlines on latitude-longitude heatmaps (north up), and Play along a dimension.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { geoKind, monotonic, indexOf, coastline, coastlineCells } from '../src/webview/map.js';
import { COASTLINE_110M } from '../src/webview/coastline.js';
import { colormap } from '../src/webview/util.js';
import { openFile } from '../src/core/open.mjs';
import { S, libs } from './helpers.mjs';

const range = (a, b, step) => Array.from({ length: Math.round((b - a) / step) + 1 }, (_, i) => a + i * step);

test('geoKind: CF units and standard_name first, then common names; projected metres are not lat/lon', () => {
  assert.equal(geoKind('y', { units: 'degrees_north' }), 'lat');
  assert.equal(geoKind('x', { units: 'degree_east' }), 'lon');
  assert.equal(geoKind('rlat', { standard_name: 'grid_latitude', units: 'degrees' }), 'lat');
  assert.equal(geoKind('nav_lon', {}), 'lon');
  for (const n of ['lat', 'latitude', 'LAT', 'lat_0', 'g0_lat_0']) assert.equal(geoKind(n), 'lat', n);
  for (const n of ['lon', 'longitude', 'long', 'lon_0']) assert.equal(geoKind(n), 'lon', n);
  assert.equal(geoKind('lat', { units: 'm' }), null); // a projection in metres named "lat" is not a lat axis
  assert.equal(geoKind('time', { units: 'hours since 2000-01-01' }), null);
  assert.equal(geoKind('level'), null);
  assert.equal(geoKind('platform'), null);
});

test('monotonic and indexOf work both ways and outside the range', () => {
  assert.equal(monotonic([1, 2, 3]), true);
  assert.equal(monotonic([3, 2, 1]), true);
  assert.equal(monotonic([1, 1, 2]), false);
  assert.equal(monotonic([1, null, 2]), false);
  assert.equal(monotonic([1]), false);
  const up = indexOf([0, 10, 30]);
  assert.equal(up(5), 0.5); assert.equal(up(20), 1.5); assert.equal(up(-10), -1); assert.equal(up(40), 2.5);
  const down = indexOf([90, 87.5, 85]);
  assert.equal(down(90), 0); assert.equal(down(86.25), 1.5); assert.equal(down(91.25), -0.5);
});

test('the packed Natural Earth coastline decodes to 134 lines inside the globe', () => {
  const lines = coastline();
  assert.equal(lines.length, 134);
  let n = 0;
  for (const l of lines) for (const [lon, lat] of l) { n++; assert.ok(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90); }
  assert.ok(n > 5000);
  assert.ok(COASTLINE_110M.length < 40_000, 'stays small in the webview bundle');
  assert.equal(coastline(), lines, 'decoded once');
});

test('coastlineCells: cell units, north up for growing latitude, 0-360 wrap, transposed grids, refusals', () => {
  // One line along the equator from 0 to 10 E, on a 1-degree grid with latitude -10..10 (growing) and longitude 0..20.
  const eq = '0,0 50,0 50,0';
  const g = coastlineCells('lat', 'lon', range(-10, 10, 1), range(0, 20, 1), eq);
  assert.equal(g.northUp, true);
  assert.deepEqual(g.lines, [[[0.5, 10.5], [5.5, 10.5], [10.5, 10.5]]]);
  // Latitude from north to south: already north up.
  assert.equal(coastlineCells('lat', 'lon', range(10, -10, -1), range(0, 20, 1), eq).northUp, false);
  // Longitudes 0..359: a line from 10 W to 10 E is split where it crosses 0, and 10 W lands near column 350.
  const wrap = coastlineCells('lat', 'lon', range(-10, 10, 1), range(0, 359, 1), '-100,0 50,0 50,0 50,0 50,0');
  assert.deepEqual(wrap.lines.map(l => l.map(p => p[0])), [[350.5, 355.5], [0.5, 5.5, 10.5]]);
  // Longitudes -180..180: no split.
  assert.equal(coastlineCells('lat', 'lon', range(-10, 10, 1), range(-180, 180, 1), '-100,0 50,0 50,0 50,0 50,0').lines.length, 1);
  // Rows are longitude, columns latitude: x and y swap, no flip.
  const t = coastlineCells('lon', 'lat', range(0, 20, 1), range(-10, 10, 1), eq);
  assert.deepEqual(t.lines[0][1], [10.5, 5.5]);
  assert.equal(t.northUp, false);
  // Sampled grid (every 2nd cell): cell units follow the sampled values.
  assert.deepEqual(coastlineCells('lat', 'lon', range(-10, 10, 2), range(0, 20, 2), eq).lines[0][1], [3, 5.5]);
  // Not a map: same kinds, not monotonic, out of range values, index coordinates.
  assert.equal(coastlineCells('lat', 'lat', range(-10, 10, 1), range(-10, 10, 1), eq), null);
  assert.equal(coastlineCells('lat', 'lon', [0, 1, 1, 2], range(0, 20, 1), eq), null);
  assert.equal(coastlineCells('lat', 'lon', range(0, 1000, 100), range(0, 20, 1), eq), null);
  assert.equal(coastlineCells(null, 'lon', range(0, 10, 1), range(0, 20, 1), eq), null);
  // Lines that leave a regional grid are cut, not drawn across it.
  const regional = coastlineCells('lat', 'lon', range(30, 60, 0.5), range(-20, 40, 0.5));
  for (const l of regional.lines) for (const [x, y] of l) assert.ok(x >= -2 && x <= 123 && y >= -2 && y <= 63);
});

test('the ERA5 sample (latitude 90 to -90, longitude 0 to 357.5) gets world coastlines in the right cells', async () => {
  const { backend: b } = await openFile(S('era5-t2m-sample.nc'), libs);
  try {
    const lat = b.read('/latitude', { rowAxis: 0, colAxis: -1, rowCount: 73 }).values.map(r => r[0]);
    const lon = b.read('/longitude', { rowAxis: 0, colAxis: -1, rowCount: 144 }).values.map(r => r[0]);
    const latInfo = b.info('/latitude'), lonInfo = b.info('/longitude');
    assert.equal(geoKind('latitude', latInfo.cf), 'lat');
    assert.equal(geoKind('longitude', lonInfo.cf), 'lon');
    const g = coastlineCells('lat', 'lon', lat, lon);
    assert.equal(g.northUp, false);
    assert.ok(g.lines.length > 134, 'lines crossing 0 E are split');
    // Cape Agulhas (20.0 E, 34.8 S) sits at column 20 / 2.5 + 0.5 = 8.5 and row (90 + 34.8) / 2.5 + 0.5 = 50.4.
    const pts = g.lines.flat();
    const near = pts.filter(([x, y]) => Math.abs(x - 8.5) < 0.6 && Math.abs(y - 50.4) < 0.6);
    assert.ok(near.length > 0, 'a coastline point near Cape Agulhas');
    for (const [x, y] of pts) assert.ok(x >= -2 && x <= 146 && y >= -2 && y <= 75);
  } finally { b.close(); }
});

test('plot.js: flipped heatmap hit test, coastline lines drawn on screen and in the PNG', async () => {
  const calls = { lineTo: 0, moveTo: 0, texts: [] };
  const ctx = () => new Proxy({}, {
    get: (t, k) => (k === 'lineTo' ? () => calls.lineTo++ : k === 'moveTo' ? () => calls.moveTo++ : k === 'fillText' ? s => calls.texts.push(String(s)) : k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  const canvas = () => ({ style: {}, dataset: {}, width: 0, height: 0, getContext: () => ctx(), toDataURL: type => `data:${type};base64,iVBORw0KGgo=` });
  const saved = { document: globalThis.document, ImageData: globalThis.ImageData, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle };
  globalThis.document = { createElement: () => canvas(), body: {} };
  globalThis.ImageData = class { constructor(w, h) { this.data = new Uint8ClampedArray(w * h * 4); } };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  try {
    const { heatmap, heatmapPng } = await import('../src/webview/plot.js');
    const rows = [[1, 2, 3], [4, 5, 6]];
    const lines = [[[0.5, 0.5], [2.5, 1.5]], [[1, 1], [2, 1], [3, 1]]];
    const p = heatmap(canvas(), rows, { width: 600, cmap: colormap('viridis'), range: { lo: 1, hi: 6, log: false }, flipY: true, lines });
    // Row 0 is drawn at the bottom: the top-left pixel is row 1.
    assert.deepEqual(p.hit(0, 0), { r: 1, c: 0 });
    assert.deepEqual(p.hit(0, p.scale * 1.5), { r: 0, c: 0 });
    assert.equal(calls.lineTo, 2 * 3, 'halo + line for 2 lines (1 + 2 segments)');
    const plain = heatmap(canvas(), rows, { width: 600, cmap: colormap('viridis'), range: { lo: 1, hi: 6, log: false } });
    assert.deepEqual(plain.hit(0, 0), { r: 0, c: 0 });
    assert.equal(calls.lineTo, 6, 'no lines without the overlay');
    calls.texts.length = 0;
    heatmapPng(rows, { title: 'sst', cmap: colormap('viridis'), range: { lo: 1, hi: 6, log: false }, rowTick: i => 'lat' + i, colTick: i => 'lon' + i, flipY: true, lines });
    assert.equal(calls.lineTo, 12);
    // Row ticks are flipped with the picture: the top tick is the last row.
    assert.ok(calls.texts.indexOf('lat1') < calls.texts.indexOf('lat0'));
  } finally { Object.assign(globalThis, saved); }
});

test('Play: every slider has a play button, one speed menu, and play stops on Escape, a new variable, a slider move or an axis change', () => {
  const src = fs.readFileSync(new URL('../src/webview/main.js', import.meta.url), 'utf8');
  assert.match(src, /id: `play-\$\{d\}`, 'aria-label': `Play along \$\{info\.dims\[d\]\}`/);
  assert.match(src, /id: 'play-speed'/);
  assert.match(src, /const PLAY_SPEEDS = \[\[1000, '0\.5×'\], \[500, '1×'\], \[250, '2×'\], \[0, 'Max'\]\]/);
  // The loop waits for each frame to be drawn before the next step, and stops on a failed read.
  assert.match(src, /const ok = await redraw\(\);\s*\n\s*if \(ok === false\) break;/);
  assert.match(src, /show\(\(v\.index\[d\] \+ 1\) % n\)/);
  for (const where of [/async function select\(path\) \{\n  stopPlay\(\);/, /function showDataset\(info, detail\) \{\n  stopPlay\(\);/, /const set = x => \{ stopPlay\(\);/, /onchange: e => \{\n      stopPlay\(\);/, /if \(state\.play\) \{ stopPlay\(\); return; \}/]) assert.match(src, where);
  // Colour range is held at the first frame while playing; no "Reading…" flash between frames.
  assert.match(src, /if \(!pl\.range \|\| pl\.range\.log !== rr\.log\) pl\.range = /);
  assert.match(src, /if \(!state\.play\) body\.replaceChildren\(el\('p', \{ class: 'muted', text: 'Reading…' \}\)\);/);
});
