// 0.4.0: NetCDF CDF-5 (64-bit data) files open. Before, the viewer refused them with "convert with nccopy".
// Fixture: test/fixtures/cdf5-sample.nc, made by ncgen + nccopy -k cdf5 from cdf5-sample.cdl (values checked with ncdump).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { NetCDFReader } from 'netcdfjs';
import { openFile, sniff } from '../src/core/open.mjs';
import { parseCdfHeader, ShortHeader, recordsFromSize } from '../src/core/cdfheader.mjs';
import { Session } from '../src/core/session.mjs';
import { S, libs } from './helpers.mjs';

const FIX = new URL('./fixtures/cdf5-sample.nc', import.meta.url).pathname;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc2-cdf5-'));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const col = (b, p, n) => b.read(p, { rowAxis: 0, colAxis: -1, rowCount: n }).values.map(r => r[0]);

test('CDF-5: types, 64-bit and unsigned values, CF decoding, time, strings, attributes (same as ncdump)', async () => {
  assert.equal(sniff(FIX).format, 'netcdf3');
  const { backend: b } = await openFile(FIX, libs);
  try {
    assert.equal(b.label, 'NetCDF-3 CDF-5 (64-bit data)');
    assert.equal(b.info('/').format, 'NetCDF-3 CDF-5 (64-bit data)');
    const types = Object.fromEntries(b.list('/').items.map(i => [i.name, [i.dtype, i.shape]]));
    assert.deepEqual(types, {
      time: ['float64', [2]], mask: ['uint8', [3, 4]], count: ['int64', [2, 3, 4]], ids: ['uint32', [4]], level: ['uint16', [3]],
      temp: ['int16', [2, 3, 4]], station: ['string(6)', [4]], big: ['uint64', [4]],
    });
    assert.deepEqual(b.info('/').dimensions.find(d => d.name === 'time'), { name: 'time', size: 2, unlimited: true });
    // Record variables interleave in the file: reading time step 1 checks the record stride.
    const c = b.read('/count', { rowAxis: 1, colAxis: 2, index: [1, 0, 0], rowCount: 3, colCount: 4 });
    assert.deepEqual(c.values, [[5000000000, 13, 14, 15], [16, 17, 18, 19], [20, 21, 22, -23]]);
    assert.equal(c.stats.max, 5000000000);
    assert.deepEqual(b.read('/mask', { rowAxis: 0, colAxis: 1, rowCount: 3, colCount: 4 }).values, [[0, 1, 1, 0], [1, 1, 1, 1], [0, 0, 1, 255]]);
    assert.deepEqual(col(b, '/ids', 4), [1, 2, 4000000000, 4]);
    assert.deepEqual(col(b, '/level', 3), [1000, 850, 65535]);
    assert.deepEqual(col(b, '/big', 4), [1, 2, '18446744073709551615', 4]); // above 2^53: shown as exact text
    assert.deepEqual(col(b, '/station', 4), ['ALPHA', 'BRAVO', 'C', 'DELTA6']);
    const t = b.read('/time', { rowAxis: 0, colAxis: -1, rowCount: 2 });
    assert.deepEqual(t.times, [['2026-01-01'], ['2026-01-01 06:00']]);
    // short with scale_factor, add_offset and _FillValue: time 0 row 2 ends with the fill value.
    const temp0 = b.read('/temp', { rowAxis: 1, colAxis: 2, index: [0, 0, 0], rowCount: 3, colCount: 4 });
    assert.equal(temp0.decoded, true);
    near(temp0.values[0][1], 274.15);
    assert.equal(temp0.values[2][3], null);
    assert.equal(temp0.stats.fill, 1);
    const raw1 = b.read('/temp', { rowAxis: 1, colAxis: 2, index: [1, 0, 0], rowCount: 1, colCount: 2 }, false);
    assert.deepEqual(raw1.values, [[-100, -200]]);
    // Sampled read along the record dimension (every 2nd step) and a time series at one point.
    assert.deepEqual(b.read('/count', { rowAxis: 0, colAxis: 2, index: [0, 2, 0], rowCount: 2, colCount: 4, colStep: 3 }).values, [[8, 11], [20, -23]]);
    const attrs = Object.fromEntries(b.info('/').attrs.map(a => [a.name, [a.value, a.dtype]]));
    assert.deepEqual(attrs.int64_attr, ['9007199254740993', 'int64']);
    assert.deepEqual(attrs.Conventions, ['CF-1.8', 'char']);
    assert.equal(b.info('/count').cf.units, '1');
  } finally { b.close(); }
});

test('the header parser gives the same layout as netcdfjs for CDF-1 and CDF-2 files', () => {
  const buf = fs.readFileSync(S('argo-profiles-classic.nc'));
  const ours = parseCdfHeader(buf), theirs = new NetCDFReader(buf);
  assert.deepEqual(ours.dimensions, theirs.dimensions);
  assert.deepEqual(ours.recordDimension && { ...ours.recordDimension }, theirs.recordDimension && { ...theirs.recordDimension });
  assert.equal(ours.variables.length, theirs.variables.length);
  for (let i = 0; i < ours.variables.length; i++) {
    const a = ours.variables[i], v = theirs.variables[i];
    assert.deepEqual([a.name, a.dimensions, a.type, a.size, Number(a.offset), a.record], [v.name, v.dimensions, v.type, v.size, Number(v.offset), v.record], v.name);
  }
});

test('CDF-5 edge cases: streaming record count, header over 64 KB, cut-off header, corrupt counts', async () => {
  const full = fs.readFileSync(FIX);
  const dir = tmp();
  try {
    // A file still being written by PnetCDF has numrecs = all bits set: the records are counted from the file size.
    const streaming = Buffer.from(full);
    streaming.fill(0xff, 4, 12);
    const h = parseCdfHeader(streaming);
    assert.equal(h.recordDimension.length, -1);
    assert.equal(recordsFromSize(h, streaming.length), 2);
    const sp = path.join(dir, 'streaming.nc');
    fs.writeFileSync(sp, streaming);
    const { backend: s } = await openFile(sp, libs);
    try { assert.deepEqual(s.info('/count').shape, [2, 3, 4]); } finally { s.close(); }

    // A header that does not fit in the first 64 KB read: the reader reads more and tries again.
    // Written by makeCdf5 below, so the test does not need the netCDF tools.
    const bp = path.join(dir, 'bighdr.nc');
    fs.writeFileSync(bp, makeCdf5({ dims: [['x', 3]], vars: [{ name: 'v', dims: [0], type: 10, attrs: [['history', 'h'.repeat(100_000)]], data: [1n, 2n, 9000000000n] }] }));
    const { backend: big } = await openFile(bp, libs);
    try {
      assert.deepEqual(col(big, '/v', 3), [1, 2, 9000000000]);
      assert.equal(big.info('/v').attrs[0].value.length, 100_000);
    } finally { big.close(); }

    // Cut inside the header: a clear error, not a hang.
    const cut = path.join(dir, 'cut.nc');
    fs.writeFileSync(cut, full.subarray(0, 40));
    await assert.rejects(openFile(cut, libs), /CDF-5|header/i);
    assert.throws(() => parseCdfHeader(full.subarray(0, 40)), ShortHeader);
    // A dimension count of 2^40: refused as corrupt, no huge allocation.
    const bad = Buffer.from(full);
    bad.writeBigUInt64BE(1n << 40n, 16);
    assert.throws(() => parseCdfHeader(bad), /corrupt/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a CDF-5 file opens through the worker and the session (what the viewer runs)', async () => {
  const out = [];
  const s = new Session({ fileName: 'cdf5-sample.nc', post: m => out.push(m), createWorker: () => new Worker(new URL('../src/worker.mjs', import.meta.url), { workerData: { filePath: FIX, opts: {} } }) });
  try {
    await s.handle({ type: 'ready' });
    assert.equal(out[0].format, 'netcdf3', JSON.stringify(out[0]));
    await s.handle({ type: 'read', reqId: 1, path: '/count', purpose: 'plot', view: { rowAxis: 1, colAxis: 2, index: [1, 0, 0], rowStart: 0, colStart: 0, rowCount: 3, colCount: 4, rowStep: 1, colStep: 1 } });
    const r = out.find(m => m.reqId === 1);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.values[0][0], 5000000000);
  } finally { s.dispose(); }
});

/** Minimal CDF-5 writer for tests: fixed-size variables only, big-endian, 4-byte padding. */
function makeCdf5({ dims, vars }) {
  const parts = [];
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
  const pad = b => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  const name = s => Buffer.concat([u64(Buffer.byteLength(s)), pad(Buffer.from(s))]);
  const size = { 10: 8 };
  const head = () => {
    const p = [Buffer.from([0x43, 0x44, 0x46, 5]), u64(0)];
    p.push(u32(10), u64(dims.length), ...dims.flatMap(([n, s]) => [name(n), u64(s)]));
    p.push(u32(0), u64(0)); // no global attributes
    p.push(u32(11), u64(vars.length));
    for (const v of vars) {
      p.push(name(v.name), u64(v.dims.length), ...v.dims.map(u64));
      p.push(u32(12), u64(v.attrs.length), ...v.attrs.flatMap(([n, s]) => [name(n), u32(2), u64(Buffer.byteLength(s)), pad(Buffer.from(s))]));
      p.push(u32(v.type), u64(v.data.length * size[v.type]), u64(v.begin || 0));
    }
    return Buffer.concat(p);
  };
  let h = head();
  let begin = h.length;
  for (const v of vars) { v.begin = begin; begin += v.data.length * size[v.type]; }
  h = head();
  parts.push(h);
  for (const v of vars) { const b = Buffer.alloc(v.data.length * 8); v.data.forEach((x, i) => b.writeBigInt64BE(x, i * 8)); parts.push(b); }
  return Buffer.concat(parts);
}
