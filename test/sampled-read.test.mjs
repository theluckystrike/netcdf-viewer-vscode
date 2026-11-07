// 0.4.0: fixes ported from the JetBrains build (PORT4). A sampled plot of a 2D field over 1,000,000 cells
// was refused, a cut-off HDF5 file gave a confusing error, and an unlimited max shape printed 1.8e19.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { validateRequest, DEFAULT_LIMITS } from '../src/core/protocol.mjs';
import { detectFormat, hdf5EofAddress } from '../src/core/detect.mjs';
import { sniff } from '../src/core/open.mjs';
import { Session } from '../src/core/session.mjs';
import { S, libs } from './helpers.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc2-sampled-'));

test('protocol: a sampled read counts only the values it reads', () => {
  const big = { type: 'read', reqId: 1, path: '/f', view: { rowAxis: 1, colAxis: 2, index: [0, 0, 0], rowStart: 0, rowCount: 1024, colStart: 0, colCount: 2048, rowStep: 2, colStep: 4 } };
  assert.equal(validateRequest(big).ok, true);
  const full = validateRequest({ ...big, view: { ...big.view, rowStep: 1, colStep: 1 } });
  assert.equal(full.ok, false);
  assert.match(full.error, /2097152 values.*limit is 1000000.*maxReadValues/);
  // ERA5 / OISST 0.25 degree global grid: 721 x 1440 = 1,038,240 cells, the webview samples it with steps 2 and 3.
  const era5 = { type: 'read', reqId: 2, path: '/t2m', view: { rowAxis: 1, colAxis: 2, index: [0, 0, 0], rowCount: 721, colCount: 1440, rowStep: Math.ceil(721 / 512), colStep: Math.ceil(1440 / 512) } };
  assert.equal(validateRequest(era5).ok, true);
  // A long 1D record sampled to 4000 points for the line plot.
  assert.equal(validateRequest({ type: 'read', reqId: 3, path: '/x', view: { rowAxis: 0, colAxis: -1, rowCount: 5_000_000, rowStep: 1250 } }).ok, true);
  // Steps do not open a hole: rounding up is still checked against the limit.
  assert.equal(validateRequest({ type: 'read', reqId: 4, path: '/x', view: { rowCount: 2001, colCount: 1001, rowStep: 2, colStep: 1 } }, DEFAULT_LIMITS).ok, false);
});

test('a 721 x 1440 field plots through the real worker (was refused before 0.4.0)', async () => {
  const h5wasm = await libs.h5wasm();
  const dir = tmp();
  const file = path.join(dir, 'oisst-like.nc');
  try {
    const f = new h5wasm.File(file, 'w');
    const data = new Float32Array(721 * 1440);
    for (let i = 0; i < data.length; i++) data[i] = i;
    f.create_dataset({ name: 'sst', data, shape: [1, 721, 1440], dtype: '<f4', chunks: [1, 181, 360], compression: 'gzip', compression_opts: 1 });
    f.close();
    const out = [];
    const s = new Session({ fileName: 'oisst-like.nc', post: m => out.push(m), createWorker: () => new Worker(new URL('../src/worker.mjs', import.meta.url), { workerData: { filePath: file, opts: { maxReadValues: DEFAULT_LIMITS.maxReadValues } } }) });
    try {
      await s.handle({ type: 'ready' });
      assert.equal(out[0].format, 'hdf5');
      const rowStep = Math.ceil(721 / 512), colStep = Math.ceil(1440 / 512);
      await s.handle({ type: 'read', reqId: 1, path: '/sst', purpose: 'plot', view: { rowAxis: 1, colAxis: 2, index: [0, 0, 0], rowStart: 0, colStart: 0, rowCount: 721, colCount: 1440, rowStep, colStep } });
      const r = out[1];
      assert.equal(r.ok, true, r.error);
      assert.equal(r.data.rows, 361);
      assert.equal(r.data.cols, 480);
      assert.equal(r.data.values[1][1], 2 * 1440 + 3);
      assert.equal(r.data.values[360][479], 720 * 1440 + 479 * 3);
    } finally { s.dispose(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('truncated HDF5 / NetCDF-4 files are reported as truncated, whole files are not', () => {
  const full = fs.readFileSync(S('era5-t2m-sample.nc'));
  assert.equal(hdf5EofAddress(full.subarray(0, 64)), full.length);
  assert.equal(hdf5EofAddress(Uint8Array.from([1, 2, 3])), null);
  const dir = tmp();
  try {
    const cut = path.join(dir, 'cut.nc');
    fs.writeFileSync(cut, full.subarray(0, Math.floor(full.length / 2)));
    const s = sniff(cut);
    assert.equal(s.format, 'unsupported');
    assert.match(s.reason, /truncated.*1,337,567 bytes.*668,783 bytes/);
    assert.equal(sniff(S('era5-t2m-sample.nc')).format, 'hdf5');
    assert.equal(sniff(S('beamline-scan.h5')).format, 'hdf5');
    // Without a size the check is skipped (callers that only have the first bytes).
    assert.equal(detectFormat(full.subarray(0, 64)).format, 'hdf5');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unlimited max shape shows as the infinity sign, not 18446744073709552000', () => {
  const src = fs.readFileSync(new URL('../src/webview/main.js', import.meta.url), 'utf8');
  assert.match(src, /m >= 2 \*\* 53 \? '∞'/);
});
