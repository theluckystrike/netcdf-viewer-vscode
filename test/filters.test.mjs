// 0.4.0: HDF5 compression plugins. LZF, Blosc, Blosc2, bitshuffle, LZ4, Zstd, bzip2 and ZFP datasets read through
// h5wasm-plugins. A filter with no decoder gets a clear message. Before, HDF5 logged an error but h5wasm returned
// leftover memory and the viewer showed made-up numbers (found on a real ESRF detector file compressed with
// bitshuffle in the real-app gate). Fixtures: scripts/make-filter-fixtures.py (h5py + hdf5plugin).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { unreadableFilters, BUILTIN_FILTERS, decodableFilters } from '../src/core/values.mjs';
import { FILTER_PLUGINS } from '../src/core/filters.mjs';
import { openHdf5 } from '../src/core/hdf5.mjs';
import { openFile } from '../src/core/open.mjs';
import { Session } from '../src/core/session.mjs';
import { S, libs } from './helpers.mjs';

const FX = n => fileURLToPath(new URL(`./fixtures/filters/${n}.h5`, import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const ROW10 = [[640, 641, 642, 643]];
const read10 = b => b.read('/x', { rowAxis: 0, colAxis: 1, rowStart: 10, rowCount: 1, colCount: 4 }).values;

test('unreadableFilters names the filters that cannot be decoded', () => {
  assert.deepEqual([...BUILTIN_FILTERS].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.equal(unreadableFilters([], BUILTIN_FILTERS), null);
  assert.equal(unreadableFilters(undefined, BUILTIN_FILTERS), null);
  assert.equal(unreadableFilters([{ id: 2 }, { id: 1, cd_values: [4] }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }], BUILTIN_FILTERS), null);
  const m = unreadableFilters([{ id: 2 }, { id: 32008, name: 'bitshuffle; see https://github.com/kiyo-masui/bitshuffle' }], BUILTIN_FILTERS);
  assert.match(m, /compressed with bitshuffle \(HDF5 filter 32008\), which this viewer cannot decode yet/);
  assert.match(m, /hdf5plugin/);
  assert.match(unreadableFilters([{ id: 32001 }, { id: 4 }, { id: 32000 }], BUILTIN_FILTERS), /blosc \(HDF5 filter 32001\) and lzf \(HDF5 filter 32000\)/);
  assert.match(unreadableFilters([{ id: 40000, name: 'my filter; docs' }], BUILTIN_FILTERS), /my filter \(HDF5 filter 40000\)/);
});

test('every shipped plugin filter decodes a file written by h5py + hdf5plugin; SZ (not shipped) gets the message', async () => {
  await libs.h5wasm();
  const ok = decodableFilters();
  for (const id of Object.values(FILTER_PLUGINS)) assert.ok(ok.has(id), `filter ${id} installed`);
  for (const n of ['lzf', 'blosc', 'blosc2', 'bzip2', 'lz4', 'zstd', 'bitshuffle', 'bitshuffle-lz4', 'zfp']) {
    const { backend: b } = await openFile(FX(n), libs);
    try { assert.deepEqual(read10(b), ROW10, n); } finally { b.close(); }
  }
  const { backend: sz } = await openFile(FX('sz'), libs);
  try {
    assert.equal(sz.info('/x').filters[0].name, 'sz');
    assert.throws(() => read10(sz), /sz \(HDF5 filter 32017\), which this viewer cannot decode yet/);
  } finally { sz.close(); }
});

test('a filter without a decoder never shows made-up numbers (h5wasm without plugins)', async () => {
  const real = await libs.h5wasm();
  // Same h5wasm, but /t2m reports filter 40000 in its pipeline.
  class File extends real.File {
    get(p) {
      const o = super.get(p);
      if (o && p === '/t2m') Object.defineProperty(o, 'filters', { get: () => [{ id: 2, name: 'shuffle' }, { id: 40000, name: 'future filter; docs', cd_values: [] }] });
      return o;
    }
  }
  const b = openHdf5({ File, Dataset: real.Dataset, Group: real.Group, Datatype: real.Datatype }, S('era5-t2m-sample.nc'), {});
  try {
    assert.ok(b.list('/').items.some(i => i.name === 't2m'));
    assert.deepEqual(b.info('/t2m').filters.map(f => f.name), ['shuffle', 'future filter; docs']);
    assert.throws(() => b.read('/t2m', { rowAxis: 1, colAxis: 2, index: [0, 0, 0], rowCount: 2, colCount: 2 }), /future filter \(HDF5 filter 40000\)/);
    assert.equal(b.read('/latitude', { rowAxis: 0, colAxis: -1, rowCount: 2 }).values.length, 2);
  } finally { b.close(); }
});

test('the built-in filters still read (szip, nbit, scaleoffset, fletcher32 written by h5wasm)', async () => {
  const h5wasm = await libs.h5wasm();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc2-filt-'));
  try {
    for (const [id, opts] of [[4, [32, 8]], [5, []], [6, [2, 0]], [3, []]]) {
      const p = path.join(dir, `f${id}.h5`);
      const f = new h5wasm.File(p, 'w');
      f.create_dataset({ name: 'x', data: new Int32Array(4096).map((_, i) => i), shape: [64, 64], dtype: '<i4', chunks: [32, 32], compression: id, compression_opts: opts });
      f.close();
      const b = openHdf5(h5wasm, p, {});
      try { assert.deepEqual(read10(b), ROW10, `filter ${id}`); } finally { b.close(); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const [label, url] of [['source worker (node_modules plugins)', '../src/worker.mjs'], ['bundled worker (dist/plugins, what the VSIX runs)', '../dist/worker.mjs']]) {
  test(`${label}: a bitshuffle dataset reads through the session`, { skip: url.includes('dist') && !fs.existsSync(root + 'dist/plugins/libH5Zbshuf.so') && 'not built' }, async () => {
    const out = [];
    const s = new Session({ fileName: 'bitshuffle.h5', post: m => out.push(m), createWorker: () => new Worker(new URL(url, import.meta.url), { workerData: { filePath: FX('bitshuffle'), opts: {} } }) });
    try {
      await s.handle({ type: 'ready' });
      await s.handle({ type: 'read', reqId: 1, path: '/x', purpose: 'table', view: { rowAxis: 0, colAxis: 1, index: [0, 0], rowStart: 10, colStart: 0, rowCount: 1, colCount: 4, rowStep: 1, colStep: 1 } });
      const r = out.find(m => m.reqId === 1);
      assert.equal(r.ok, true, r.error);
      assert.deepEqual(r.data.values, ROW10);
    } finally { s.dispose(); }
  });
}

test('the package ships the 8 plugin libraries and nothing else from h5wasm-plugins', () => {
  const ignore = fs.readFileSync(root + '.vscodeignore', 'utf8');
  assert.match(ignore, /^!dist\/plugins\/\*\*$/m);
  const build = fs.readFileSync(root + 'scripts/build.js', 'utf8');
  assert.match(build, new RegExp(`const PLUGINS = \\[${Object.keys(FILTER_PLUGINS).map(n => `'${n}'`).join(', ')}\\]`));
  if (fs.existsSync(root + 'dist/plugins')) assert.deepEqual(fs.readdirSync(root + 'dist/plugins').sort(), Object.keys(FILTER_PLUGINS).map(n => `libH5Z${n}.so`).sort());
});
