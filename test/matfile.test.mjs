// 0.5.0: MATLAB MAT-files (v4, v5, v7 compressed, v7.3) and complex numbers.
// Fixtures: scripts/make-mat-fixtures.py (scipy.io.savemat, h5py, and hand-written big-endian and hostile files).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sniff, openFile } from '../src/core/open.mjs';
import { detectFormat, isMatV5 } from '../src/core/detect.mjs';
import { validateRequest } from '../src/core/protocol.mjs';
import { readSeries } from '../src/core/series.mjs';
import { complexMembers, complexPart, formatComplex } from '../src/core/complex.mjs';
import { pythonSnippet } from '../src/webview/util.js';
import { libs } from './helpers.mjs';

const M = p => fileURLToPath(new URL('./fixtures/mat/' + p, import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const all = { rowAxis: 0, colAxis: 1, rowCount: 100, colCount: 100, index: [] };
async function open(name, opts) { return (await openFile(M(name), libs, opts)).backend; }
const names = b => b.list('/').items.map(i => i.name);

for (const file of ['basic-v5.mat', 'compressed-v7.mat']) {
  test(`${file}: every class reads with MATLAB's rows x columns`, async () => {
    const b = await open(file);
    try {
      assert.match(b.label, file.startsWith('basic') ? /^MATLAB MAT-file v5$/ : /v7 \(compressed\)/);
      for (const n of ['A', 'B', 'i8', 'u64', 'flag', 'greeting', 'names', 'z', 'S', 'c', 's', 'sa', 'empty', 't3']) assert.ok(names(b).includes(n), n);
      const A = b.info('/A');
      assert.deepEqual([A.shape, A.dtype, A.dims, A.colMajor], [[3, 4], 'double', ['rows', 'columns'], true]);
      assert.deepEqual(b.read('/A', all).values, [[0.5, 1.5, 2.5, 3.5], [4.5, 5.5, 6.5, 7.5], [8.5, 9.5, 10.5, 11.5]]);
      // A slice with steps and an offset: rows 1..2, every 2nd column from 1.
      const r = b.read('/A', { rowAxis: 0, colAxis: 1, rowStart: 1, rowCount: 2, colStart: 1, colCount: 2, colStep: 2 });
      assert.deepEqual(r.values, [[5.5, 7.5], [9.5, 11.5]]);
      // Transposed view (columns as rows).
      assert.deepEqual(b.read('/A', { rowAxis: 1, colAxis: 0, rowCount: 2, colCount: 3 }).values, [[0.5, 4.5, 8.5], [1.5, 5.5, 9.5]]);
      assert.deepEqual(b.read('/B', all).values, [[1.25, -2.5]]);
      assert.deepEqual(b.read('/i8', all).values, [[-128, 0, 127]]);
      assert.deepEqual(b.read('/u32', all).values, [[4294967295, 3]]);
      assert.deepEqual(b.read('/i64', all).values, [['-9007199254740993', 9007199254740991, 5]]);
      assert.deepEqual(b.read('/u64', all).values, [['18446744073709551615', 7]]);
      assert.equal(b.info('/flag').dtype, 'logical');
      assert.deepEqual(b.read('/flag', all).values, [[1, 0, 1]]);
      assert.deepEqual([b.info('/greeting').shape, b.read('/greeting', {}).values], [[], [['hello']]]);
      assert.deepEqual(b.read('/unicode', {}).values, [['café ±']]);
      assert.deepEqual(b.read('/names', { rowAxis: 0, colAxis: -1, rowCount: 5 }).values, [['abc'], ['def']]);
      assert.deepEqual(b.read('/empty', all).values, []);
      // 3-D: t3(i, j, k) = i + 2 j + 6 k; page k = 2.
      const t3 = b.info('/t3');
      assert.deepEqual([t3.shape, t3.dims], [[2, 3, 4], ['rows', 'columns', 'pages']]);
      assert.deepEqual(b.read('/t3', { rowAxis: 0, colAxis: 1, index: [0, 0, 2], rowCount: 2, colCount: 3 }).values, [[12, 14, 16], [13, 15, 17]]);
      assert.deepEqual(b.read('/t3', { rowAxis: 2, colAxis: -1, index: [1, 2, 0], rowCount: 4 }).values.map(x => x[0]), [5, 11, 17, 23]);
    } finally { b.close(); }
  });

  test(`${file}: complex, sparse, cells, structs and struct arrays`, async () => {
    const b = await open(file);
    try {
      const z = b.info('/z');
      assert.deepEqual([z.dtype, z.complex, z.numeric, z.compound], ['complex double', true, true, null]);
      assert.deepEqual(b.read('/z', all).values, [[[1, 2], [3, -4], [0, 1]], [[-1, -1], [5, 0], [0, -2]]]);
      assert.deepEqual(b.read('/z', all, true, 'abs').values[0], [Math.hypot(1, 2), 5, 1]);
      assert.deepEqual(b.read('/z', all, true, 'arg').values[1], [Math.atan2(-1, -1), 0, -Math.PI / 2]);
      assert.deepEqual(b.read('/z', all, true, 're').values, [[1, 3, 0], [-1, 5, 0]]);
      assert.deepEqual(b.read('/z', all, true, 'im').values, [[2, -4, 1], [-1, 0, -2]]);
      assert.equal(b.read('/z', all).statsOf, 'abs');
      // Sparse: a group with the non-zeros (1-based, like MATLAB) and the full matrix.
      assert.deepEqual(b.list('/S').items.map(i => [i.name, i.shape]), [['nonzeros', [4]], ['full', [5, 4]]]);
      assert.deepEqual(b.info('/S/nonzeros').compound, ['row', 'column', 'value']);
      assert.deepEqual(b.read('/S/nonzeros', { rowAxis: 0, colAxis: -1, rowCount: 10 }).values.map(x => x[0]), [[1, 1, 1.5], [4, 1, -2], [2, 3, 3.25], [5, 4, 7]]);
      assert.deepEqual(b.read('/S/full', all).values, [[1.5, 0, 0, 0], [0, 0, 3.25, 0], [0, 0, 0, 0], [-2, 0, 0, 0], [0, 0, 0, 7]]);
      assert.deepEqual(b.read('/Sc/full', all, true, 'complex').values, [[[0, 0], [0, 0], [2, -3]], [[1, 1], [0, 0], [0, 0]]]);
      assert.deepEqual(b.read('/Sl/full', all).values, [[1, 0], [0, 1], [1, 1]]);
      assert.ok(b.info('/S/full').attrs.some(a => a.name === 'non-zeros' && a.value === 4));
      // Cells: {k} names, mixed classes inside.
      assert.deepEqual(b.list('/c').items.map(i => [i.name, i.kind, i.dtype]), [['{1}', 'dataset', 'double'], ['{2}', 'dataset', 'char'], ['{3}', 'dataset', 'int16']]);
      assert.deepEqual(b.read('/c/{3}', all).values, [[3, 4, 5]]);
      assert.deepEqual(b.read('/deep/{1}/{1}', all).values, [[42]]);
      // Structs and struct arrays.
      assert.deepEqual(b.list('/s').items.map(i => i.name), ['a', 'b', 'inner']);
      assert.deepEqual(b.read('/s/inner/tag', {}).values, [['inner']]);
      assert.equal(b.list('/').items.find(i => i.name === 'sa').matlab, '1x2 struct');
      assert.deepEqual(b.list('/sa').items.map(i => i.name), ['(1)', '(2)']);
      assert.deepEqual(b.read('/sa/(2)/x', all).values, [[2, 3]]);
      assert.deepEqual(b.read('/sa/(1)/y', {}).values, [['first']]);
      assert.equal(b.info('/').format, b.label);
    } finally { b.close(); }
  });
}

test('big-endian Level 5 file, with a compressed variable', async () => {
  const b = await open('bigendian-v5.mat');
  try {
    assert.equal(b.info('/').attrs.find(a => a.name === 'byte order').value, 'big-endian');
    assert.deepEqual(b.read('/D', all).values, [[1, 3, 5], [2, 4, 6]]);
    assert.deepEqual(b.read('/Dz', all).values, [[1, 3, 5], [2, 4, 6]]);
    assert.deepEqual(b.read('/k', all).values, [[-5, 300, 7]]);
    assert.deepEqual(b.read('/ch', {}).values, [['ok']]);
    assert.deepEqual(b.read('/zc', all).values, [[[1, -1], [2, 0.5]]]);
  } finally { b.close(); }
});

test('Level 4 file (scipy format="4"): numbers, text and complex', async () => {
  assert.equal(sniff(M('level4.mat')).format, 'matv4');
  const b = await open('level4.mat');
  try {
    assert.equal(b.label, 'MATLAB MAT-file v4');
    assert.deepEqual(b.read('/M', all).values, [[0, 1, 2], [3, 4, 5]]);
    assert.deepEqual(b.read('/txt', {}).values, [['abc']]);
    assert.deepEqual(b.read('/Z', all, true, 're').values, [[1, 2]]);
    assert.equal(b.info('/Z').complex, true);
  } finally { b.close(); }
});

test('v7.3 MAT-file: HDF5 shown in MATLAB order, char as text, logical, complex {real, imag}', async () => {
  const s = sniff(M('v73.mat'));
  assert.deepEqual([s.format, s.label, s.matlab], ['hdf5', 'MATLAB MAT-file v7.3 (HDF5)', true]);
  const b = await open('v73.mat');
  try {
    assert.equal(b.label, 'MATLAB MAT-file v7.3 (HDF5)');
    const A = b.info('/A');
    assert.deepEqual([A.shape, A.dims, A.colMajor], [[3, 4], ['rows', 'columns'], true]);
    assert.deepEqual(b.read('/A', all).values, [[0.5, 1.5, 2.5, 3.5], [4.5, 5.5, 6.5, 7.5], [8.5, 9.5, 10.5, 11.5]]);
    const r = b.read('/A', { rowAxis: 0, colAxis: 1, rowStart: 2, rowCount: 1, colStart: 1, colCount: 3 });
    assert.deepEqual([r.values, r.start, r.count], [[[9.5, 10.5, 11.5]], [2, 1], [1, 3]]);
    assert.deepEqual([b.info('/greeting').dtype, b.read('/greeting', {}).values], ['char', [['hello']]]);
    assert.equal(b.info('/flag').dtype, 'logical');
    const z = b.info('/z');
    assert.deepEqual([z.shape, z.complex, z.dtype], [[2, 3], true, 'complex128']);
    assert.deepEqual(b.read('/z', all, true, 'im').values, [[2, -4, 1], [-1, 0, -2]]);
    // Series along a dimension of a complex array: the magnitude unless a part is chosen.
    const sr = readSeries(b, '/z', 1, [1, 0], true, {});
    assert.deepEqual([sr.part, sr.values], ['abs', [Math.SQRT2, 5, 2]]);
    assert.deepEqual(readSeries(b, '/z', 1, [0, 0], true, { part: 'arg' }).values, [Math.atan2(2, 1), Math.atan2(-4, 3), Math.PI / 2]);
  } finally { b.close(); }
});

test('HDF5 complex compounds: h5py {r, i}, {real, imag}; other two-float compounds stay tables', async () => {
  const b = await open('complex.h5');
  try {
    const z = b.info('/z128');
    assert.deepEqual([z.dtype, z.complex, z.numeric, z.compound], ['complex128', true, true, null]);
    assert.equal(b.info('/z64').dtype, 'complex64');
    assert.deepEqual(b.read('/z128', all, true, 'abs').values[0], [Math.sqrt(5), 5]);
    assert.deepEqual(b.read('/z128', all).values[2], [[2, 0], [0, -3]]);
    assert.deepEqual(b.read('/ri', { rowAxis: 0, colAxis: -1, rowCount: 4 }, true, 'arg').values.map(x => x[0]), [0, Math.PI / 2, Math.PI, -Math.PI / 2]);
    const n = b.info('/notcomplex');
    assert.deepEqual([n.complex, n.compound], [false, ['a', 'b']]);
    assert.equal(b.list('/').items.find(i => i.name === 'z64').dtype, 'complex64');
  } finally { b.close(); }
});

test('complex helpers and protocol', () => {
  assert.deepEqual(complexMembers({ type: 6, compound_type: { members: [{ name: 'i', type: 1, size: 4 }, { name: 'r', type: 1, size: 4 }] } }), { re: 1, im: 0, size: 4 });
  assert.equal(complexMembers({ type: 6, compound_type: { members: [{ name: 'r', type: 1, size: 4 }, { name: 'i', type: 1, size: 8 }] } }), null);
  assert.equal(complexMembers({ type: 6, compound_type: { members: [{ name: 'r', type: 0, size: 4 }, { name: 'i', type: 0, size: 4 }] } }), null);
  assert.equal(complexPart(3, 4, 'abs'), 5);
  assert.equal(complexPart(3n, 4n, 're'), 3);
  assert.equal(formatComplex([1.5, -2]), '1.5 - 2i');
  assert.equal(formatComplex([0, 0.1 + 0.2]), '0 + 0.3i');
  assert.equal(formatComplex([0, 0.1 + 0.2], 0), '0 + 0.30000000000000004i');
  assert.equal(formatComplex(['NaN', 'Inf']), 'NaN + Infi');
  const ok = validateRequest({ type: 'read', reqId: 1, path: '/z', view: {}, part: 'arg', purpose: 'plot' });
  assert.equal(ok.req.part, 'arg');
  assert.equal(validateRequest({ type: 'read', reqId: 1, path: '/z', view: {}, part: 'evil' }).ok, false);
  assert.equal(validateRequest({ type: 'series', reqId: 1, path: '/z', axis: 0, part: 're' }).req.part, 're');
  assert.equal(validateRequest({ type: 'export', reqId: 1, path: '/z', view: {}, part: 'abs' }).req.part, 'abs');
  assert.deepEqual(validateRequest({ type: 'openAsText' }), { ok: true, req: { type: 'openAsText' } });
});

test('hostile MAT-files: truncated, bogus sizes, zip bombs, deep nesting, wrong tags, not MATLAB', async () => {
  for (const f of ['truncated-v5.mat', 'truncated-v7.mat']) {
    const b = await open(f);
    try {
      assert.ok(names(b).includes('A'), f);
      assert.deepEqual(b.read('/A', all).values[0], [0.5, 1.5, 2.5, 3.5]);
      assert.match(b.info('/').warning, /stops in the middle|truncated/);
      // Everything listed either reads or gives a message; nothing throws a non-Error or hangs.
      for (const it of b.list('/').items) if (it.kind === 'dataset') { try { b.read(it.path, all); } catch (e) { assert.ok(e instanceof Error); } }
    } finally { b.close(); }
  }
  let b = await open('bogus-dims.mat');
  try {
    const items = b.list('/').items;
    assert.equal(items[0].kind, 'error');
    assert.match(items[0].error, /2147483647 x 2147483647.*damaged/);
    assert.deepEqual(b.read('/ok', {}).values, [[3.5]]);
  } finally { b.close(); }
  b = await open('bomb.mat');
  try {
    const before = process.memoryUsage().rss;
    assert.deepEqual(b.list('/').items.map(i => [i.name, i.kind]), [['big', 'dataset'], ['liar', 'dataset'], ['fine', 'dataset']]);
    assert.deepEqual(b.list('/').items[0].shape, [20000, 20000]);
    assert.throws(() => b.read('/big', all), /about 3052 MB when unpacked. The limit for one compressed variable is 256 MB/);
    assert.throws(() => b.read('/liar', all), /unpacks to more than 256 MB, so it was not unpacked/);
    assert.ok(process.memoryUsage().rss - before < 600 * 1048576, 'memory stays bounded');
    assert.deepEqual(b.read('/fine', {}).values, [[1]]);
  } finally { b.close(); }
  b = await open('bomb.mat', { maxInflateBytes: 1024 * 1024 });
  try { assert.throws(() => b.read('/liar', all), /more than 1 MB/); } finally { b.close(); }
  b = await open('deep-cells.mat');
  try {
    let p = '/nest', err = null, depth = 0;
    for (; depth < 300; depth++) { try { b.list(p); } catch (e) { err = e; break; } p += '/{1}'; }
    assert.match(err.message, /nested more than 64 levels/);
    assert.equal(depth, 64);
    assert.deepEqual(b.read('/after', {}).values, [[2]]);
  } finally { b.close(); }
  b = await open('wrong-tags.mat');
  try {
    const items = b.list('/').items;
    assert.deepEqual(items.map(i => i.kind), ['error', 'error', 'error', 'dataset']);
    assert.match(items[0].error, /Array flags expected/);
    assert.match(items[1].error, /unknown data type 99/);
    assert.deepEqual(b.read('/good', all).values, [[4, 5]]);
  } finally { b.close(); }
  const s = sniff(M('not-matlab.mat'));
  assert.equal(s.format, 'unknown');
  assert.match(s.reason, /not a MATLAB MAT-file.*Open as text/);
  await assert.rejects(openFile(M('not-matlab.mat'), libs), /not a MATLAB MAT-file/);
});

test('detection: v5 header variants, truncated header, v7.3 user block', () => {
  const h = (text, ver = [0, 1], e = 'IM') => { const b = Buffer.alloc(128, 0x20); b.write(text); b[124] = ver[0]; b[125] = ver[1]; b.write(e, 126, 'latin1'); return b; };
  assert.equal(detectFormat(h('MATLAB 5.0 MAT-file, Platform: PCWIN64')).format, 'matv5');
  assert.equal(detectFormat(h('MATLAB 5.0 MAT-file', [1, 0], 'MI')).format, 'matv5');
  assert.equal(isMatV5(h('Octave 9 MAT-file')), true);
  assert.equal(isMatV5(h('MATLAB 5.0 MAT-file', [0, 1], 'XX')), false);
  assert.equal(detectFormat(Buffer.from('MATLAB 5.0 MAT-file, Platform')).label, 'MATLAB v5 (truncated)');
  assert.match(detectFormat(Buffer.from('MATLAB 7.3 MAT-file, Platform: GLNXA64')).reason, /HDF5 data that should follow/);
});

test('manifest: .mat opens on a click, name and keywords for MATLAB searches', () => {
  const pkg = JSON.parse(fs.readFileSync(root + 'package.json', 'utf8'));
  assert.ok(pkg.contributes.customEditors[0].selector.some(s => s.filenamePattern === '*.mat'));
  assert.equal(pkg.displayName, 'NetCDF Viewer & HDF5 Viewer (NC Viewer, H5 Viewer, MATLAB MAT Viewer)');
  for (const w of ['matlab', 'viewer', 'mat']) assert.ok(pkg.displayName.toLowerCase().split(/[^a-z0-9]+/).includes(w), w);
  for (const k of ['matlab', 'mat', 'mat file']) assert.ok(pkg.keywords.includes(k), k);
  assert.ok(pkg.keywords.length <= 30);
  assert.equal(pkg.engines.vscode, '^1.90.0');
});

test('SciPy and h5py snippets for MAT-files', () => {
  const s = pythonSnippet({ fileName: 'a.mat', path: '/A', lib: 'scipy', shape: [3, 4], dims: ['rows', 'columns'], hs: { start: [0, 0], count: [3, 4], step: [1, 1] } });
  assert.match(s, /from scipy.io import loadmat/);
  assert.match(s, /data = m\["A"\]\[:, :\]/);
  assert.match(pythonSnippet({ fileName: 'a.mat', path: '/s/inner/tag', lib: 'scipy' }), /m\["s"\]  # this item: \/s\/inner\/tag/);
  assert.match(pythonSnippet({ fileName: 'a.mat', path: '/A', lib: 'h5py', colMajor: true }), /\[\(\)\]\.T  # MATLAB order/);
});

test('export of a complex slice: a + bi in CSV without the formula guard, [re, im] in JSON, a part as numbers', async () => {
  const { Session } = await import('../src/core/session.mjs');
  const { Worker } = await import('node:worker_threads');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acq1-mat-'));
  try {
    const written = {};
    let target = null;
    const out = [];
    const s = new Session({
      fileName: 'basic-v5.mat', post: m => out.push(m),
      createWorker: () => new Worker(new URL('../src/worker.mjs', import.meta.url), { workerData: { filePath: M('basic-v5.mat'), opts: {} } }),
      chooseExportFile: async () => target, writeExport: async (p, t) => { written[p] = t; },
    });
    try {
      target = { path: path.join(dir, 'z.csv'), format: 'csv' };
      await s.handle({ type: 'export', reqId: 1, path: '/z', view: { rowAxis: 0, colAxis: 1, index: [] } });
      assert.equal(out.at(-1).ok, true, out.at(-1).error);
      assert.equal(written[target.path], 'rows \\ columns,0,1,2\n0,1 + 2i,3 - 4i,0 + 1i\n1,-1 - 1i,5 + 0i,0 - 2i\n');
      target = { path: path.join(dir, 'z.json'), format: 'json' };
      await s.handle({ type: 'export', reqId: 2, path: '/z', view: { rowAxis: 0, colAxis: 1, index: [] } });
      assert.deepEqual(JSON.parse(written[target.path]).values[1], [[-1, -1], [5, 0], [0, -2]]);
      target = { path: path.join(dir, 'zi.csv'), format: 'csv' };
      await s.handle({ type: 'export', reqId: 3, path: '/z', view: { rowAxis: 0, colAxis: 1, index: [] }, part: 'im' });
      assert.match(written[target.path], /\n0,2,-4,1\n/);
    } finally { s.dispose(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
