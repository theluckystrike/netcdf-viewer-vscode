// Zovo Pro: export a subset of one variable (like `ncks -d` or xarray `.sel`): a range per dimension, by index or by
// coordinate value, to a tidy CSV (one row per point, coordinate columns first) or to a NetCDF-3 file with the
// variable, its coordinates and their attributes. The source file is only read.
import fs from 'node:fs';
import { planBlocks } from './blocks.mjs';
import { product } from './slice.mjs';
import { buildHeader, ncName, ncAttr, encode } from './nc3write.mjs';
import { csvField } from './export.mjs';

export const CSV_MAX_VALUES = 20_000_000;
export const NC_MAX_VALUES = 4_000_000_000;

/**
 * Parse one dimension's range. n = dimension length; coord = { values: number[], times: string[]|null } or null.
 *   ''  all  :          every index
 *   5                   one index (negative counts from the end)
 *   10:20  10:20:2      indices 10 to 20, both included, with an optional step
 *   30..60              coordinate values from 30 to 60 (any order); dates for a time coordinate: 2023-08-01..2023-08-31
 * Returns { ok: true, start, count, step, text } or { ok: false, error }.
 */
export function parseRange(input, n, coord) {
  const s = String(input ?? '').trim();
  const all = { ok: true, start: 0, count: n, step: 1, text: `all ${n}` };
  if (s === '' || s === ':' || /^all$/i.test(s)) return all;
  const idx = v => { const k = Number(v); return Number.isInteger(k) ? (k < 0 ? n + k : k) : NaN; };
  let m = /^(-?\d+)$/.exec(s);
  if (m) {
    const i = idx(m[1]);
    if (!(i >= 0 && i < n)) return { ok: false, error: `Index from 0 to ${n - 1}.` };
    return { ok: true, start: i, count: 1, step: 1, text: `index ${i}` };
  }
  m = /^(-?\d*)\s*:\s*(-?\d*)(?:\s*:\s*(\d+))?$/.exec(s);
  if (m) {
    const a = m[1] === '' ? 0 : idx(m[1]), b = m[2] === '' ? n - 1 : idx(m[2]), step = m[3] ? Number(m[3]) : 1;
    if (!(a >= 0 && a < n && b >= 0 && b < n)) return { ok: false, error: `Indices from 0 to ${n - 1} (or negative from the end).` };
    if (b < a) return { ok: false, error: 'The first index must not be after the second.' };
    if (!(step >= 1)) return { ok: false, error: 'The step must be 1 or more.' };
    const count = Math.floor((b - a) / step) + 1;
    return { ok: true, start: a, count, step, text: `indices ${a} to ${a + (count - 1) * step}${step > 1 ? ` every ${step}` : ''} (${count})` };
  }
  m = /^(.+?)\s*\.\.\s*(.+)$/.exec(s);
  if (m) {
    if (!coord) return { ok: false, error: 'This dimension has no coordinate variable. Use indices, such as 0:10.' };
    const isTime = !!(coord.times && coord.times.some(t => t != null));
    const key = i => (isTime ? coord.times[i] : coord.values[i]);
    let lo, hi;
    if (isTime) { lo = m[1].trim(); hi = m[2].trim(); if (lo > hi) [lo, hi] = [hi, lo]; } else {
      lo = Number(m[1]); hi = Number(m[2]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { ok: false, error: 'Two numbers, such as 30..60.' };
      if (lo > hi) [lo, hi] = [hi, lo];
    }
    // Dates compare as text: "2023-08-01" sorts before "2023-08-01 06:00". A bare end date takes the whole day.
    const inRange = v => v != null && (isTime ? String(v) >= lo && (String(v) <= hi || String(v).startsWith(hi)) : v >= lo && v <= hi);
    const hits = [];
    for (let i = 0; i < n; i++) if (inRange(key(i))) hits.push(i);
    if (!hits.length) {
      let best = -1, bestD = Infinity;
      if (!isTime) for (let i = 0; i < n; i++) { const v = coord.values[i]; if (typeof v === 'number') { const d = Math.min(Math.abs(v - lo), Math.abs(v - hi)); if (d < bestD) { bestD = d; best = i; } } }
      return { ok: false, error: best >= 0 ? `No value between ${lo} and ${hi}. The nearest is ${coord.values[best]} at index ${best}.` : `No value between ${lo} and ${hi}.` };
    }
    const a = hits[0], b = hits[hits.length - 1];
    if (hits.length !== b - a + 1) return { ok: false, error: 'The coordinate is not sorted, so a value range is not one block. Use indices.' };
    return { ok: true, start: a, count: b - a + 1, step: 1, text: `${key(a)} to ${key(b)} (${b - a + 1})` };
  }
  return { ok: false, error: 'Use an index (5), an index range (10:20 or 10:20:2) or a value range (30..60).' };
}

/** Coordinate label for selection position k of dimension d. */
function coordLabel(coord, sel, k) {
  const i = sel.start + k * sel.step;
  if (!coord) return i;
  if (coord.times && coord.times[i] != null) return coord.times[i];
  const v = coord.values[i];
  return v === undefined || v === null ? i : v;
}

const INTERNAL = new Set(['DIMENSION_LIST', 'REFERENCE_LIST', 'CLASS', 'NAME', '_Netcdf4Dimid', '_Netcdf4Coordinates', '_NCProperties', '_nc3_strict', '_SuperblockVersion', '_IsNetcdf4']);
const PACKING = new Set(['scale_factor', 'add_offset', '_FillValue', 'missing_value', 'valid_min', 'valid_max', 'valid_range', '_Unsigned', 'coordinates']);

/** Attribute list -> NetCDF attributes; drop = names to leave out; typeFor(name) forces a numeric type. */
function ncAtts(list, drop, typeFor) {
  const out = [];
  for (const a of list || []) {
    if (a.internal || INTERNAL.has(a.name) || drop.has(a.name) || a.name.startsWith('_Nc')) continue;
    if (a.value && typeof a.value === 'object' && !Array.isArray(a.value)) continue; // truncated or references
    const x = ncAttr(a.value, typeof a.value === 'string' ? undefined : typeFor && typeFor(a.name));
    if (x) out.push({ name: ncName(a.name, 'attr'), ...x });
  }
  return out;
}

/**
 * Write the subset. call(op, payload) talks to the reader (ops info, block, read). info = the variable's info.
 * sel: one { start, count, step } per dimension. coords: per dimension { values, times } or null (decoded labels).
 * target: { path, format: 'csv' | 'nc' }. opts: { maxValues, cancelled(), progress(f), sourceName, now() }
 * Returns { values, bytes, cancelled }.
 */
export async function writeSubset(call, info, sel, coords, target, opts = {}) {
  const shape = info.shape;
  const nd = shape.length;
  const total = product(sel.map(s => s.count));
  const max = opts.maxValues || 1_000_000;
  const cancelled = opts.cancelled || (() => false);
  const progress = opts.progress || (() => {});
  if (target.format === 'csv' && total > CSV_MAX_VALUES) throw new Error(`This subset has ${total.toLocaleString('en-US')} values. CSV export stops at ${CSV_MAX_VALUES.toLocaleString('en-US')}; save it as NetCDF, or pick a smaller range.`);
  if (total > NC_MAX_VALUES) throw new Error(`This subset has ${total.toLocaleString('en-US')} values. Pick a smaller range.`);
  const tmp = `${target.path}.part-${process.pid}-${Date.now()}`;
  const fh = await fs.promises.open(tmp, 'wx');
  let ok = false, bytes = 0, done = 0;
  try {
    if (target.format === 'csv') {
      const units = info.cf && info.cf.units;
      const head = [];
      for (let d = 0; d < nd; d++) {
        const c = coords[d];
        const name = (info.dims && info.dims[d]) || `dim${d}`;
        head.push(c && c.units ? `${name} (${c.units})` : name);
      }
      head.push(units ? `${info.name} (${units})` : info.name);
      let buf = head.map(h => csvField(h, true)).join(',') + '\r\n';
      const flush = async force => { if (buf.length > (force ? 0 : 1 << 20)) { const b = Buffer.from(buf, 'utf8'); await fh.write(b); bytes += b.length; buf = ''; } };
      const labels = sel.map((s, d) => { const out = new Array(s.count); for (let k = 0; k < s.count; k++) out[k] = csvField(coordLabel(coords[d], s, k), typeof coordLabel(coords[d], s, k) === 'string'); return out; });
      for (const blk of planBlocks(shape, sel, max)) {
        if (cancelled()) return { cancelled: true };
        const r = await call('block', { path: info.path, view: blk.view, decode: true });
        if (r.text) throw new Error('Text variables cannot be exported as a subset. Use Export slice.');
        const lead = blk.lead.map((k, d) => labels[d][k]).join(',');
        for (let i = 0; i < blk.rows; i++) for (let j = 0; j < blk.cols; j++) {
          const o = i * blk.cols + j;
          const v = r.fill[o] ? '' : csvField(r.values[o]);
          const parts = [];
          if (nd >= 3) parts.push(lead);
          if (nd >= 2) parts.push(labels[nd - 2][blk.r0 + i], labels[nd - 1][blk.c0 + j]);
          else if (nd === 1) parts.push(labels[0][blk.r0 + i]);
          parts.push(v);
          buf += parts.join(',') + '\r\n';
        }
        await flush(false);
        done += blk.rows * blk.cols;
        progress(done / total);
      }
      await flush(true);
    } else {
      // NetCDF: coordinates first (small, written whole), the variable last. Values are written decoded (CF packing
      // applied) as float or double, with NaN as the fill value; coordinates keep their stored values and attributes.
      const dimNames = [];
      const used = new Set();
      for (let d = 0; d < nd; d++) {
        let nm = ncName((info.dims && info.dims[d]) || `dim${d}`, `dim${d}`);
        while (used.has(nm)) nm += '_';
        used.add(nm); dimNames.push(nm);
      }
      const dims = sel.map((s, d) => ({ name: dimNames[d], size: s.count }));
      const vars = [];
      const coordData = [];
      for (let d = 0; d < nd; d++) {
        const cpath = info.coords && info.coords[d];
        if (!cpath) continue;
        let cinfo, raw;
        try {
          cinfo = await call('info', { path: cpath });
          if (!cinfo.numeric || cinfo.shape.length !== 1) continue;
          raw = await call('block', { path: cpath, view: { rowAxis: 0, colAxis: -1, index: [0], rowStart: sel[d].start, rowCount: sel[d].count, rowStep: sel[d].step }, decode: false });
        } catch { continue; }
        if (raw.text) continue;
        const keepPacking = new Set(['_FillValue', 'missing_value', 'valid_min', 'valid_max', 'valid_range', 'scale_factor', 'add_offset']);
        vars.push({ name: dimNames[d], dims: [d], type: 'double', atts: ncAtts(cinfo.attrs, new Set(['coordinates', '_Unsigned']), n => (keepPacking.has(n) ? 'double' : undefined)) });
        coordData.push(Float64Array.from(raw.values, (v, i) => (raw.fill[i] ? NaN : v)));
      }
      const vtype = info.dtype === 'float32' && !(info.cf && info.cf.packing) ? 'float' : 'double';
      const vname = ncName(info.name, 'data');
      const vatts = ncAtts(info.attrs, PACKING, null);
      vatts.unshift({ name: '_FillValue', type: vtype, values: [NaN] });
      vars.push({ name: used.has(vname) ? vname + '_' : vname, dims: sel.map((_, d) => d), type: vtype, atts: vatts });
      let root = null;
      try { root = await call('info', { path: '/' }); } catch { /* no global attributes */ }
      const gatts = ncAtts(root && root.attrs, new Set(['history']), null);
      const oldHistory = root && (root.attrs || []).find(a => a.name === 'history');
      const desc = sel.map((s, d) => `${dimNames[d]}=${s.start}:${s.start + (s.count - 1) * s.step}${s.step > 1 ? ':' + s.step : ''}`).join(', ');
      const line = `${new Date((opts.now || Date.now)()).toISOString().replace(/\.\d+Z$/, 'Z')}: subset of ${info.path} [${desc}] from ${opts.sourceName || 'the source file'} by NetCDF Viewer (zovo.hdf5-netcdf-explorer)`;
      gatts.push({ name: 'history', type: 'char', values: Buffer.from(oldHistory && typeof oldHistory.value === 'string' ? `${line}\n${oldHistory.value}` : line, 'utf8') });
      const { header, vars: placed } = buildHeader({ dims, atts: gatts, vars });
      await fh.write(header, 0, header.length, 0);
      for (let i = 0; i < coordData.length; i++) {
        const b = encode('double', coordData[i]);
        await fh.write(b, 0, b.length, placed[i].begin);
      }
      const main = placed[placed.length - 1];
      const size = vtype === 'float' ? 4 : 8;
      const ccount = nd >= 2 ? sel[nd - 1].count : 1;
      for (const blk of planBlocks(shape, sel, max)) {
        if (cancelled()) return { cancelled: true };
        const r = await call('block', { path: info.path, view: blk.view, decode: true });
        if (r.text) throw new Error('Text variables cannot be exported as a subset. Use Export slice.');
        const vals = Float64Array.from(r.values, (v, i) => (r.fill[i] ? NaN : v));
        if (blk.cols === ccount || nd < 2) {
          const b = encode(vtype, vals);
          await fh.write(b, 0, b.length, main.begin + blk.out * size);
        } else {
          for (let i = 0; i < blk.rows; i++) { // a row longer than one read: write it piece by piece
            const b = encode(vtype, vals.subarray(i * blk.cols, (i + 1) * blk.cols));
            await fh.write(b, 0, b.length, main.begin + (blk.out + i * ccount) * size);
          }
        }
        done += blk.rows * blk.cols;
        progress(done / total);
      }
      const end = main.begin + main.vsize;
      if (main.vsize > main.size) await fh.write(Buffer.alloc(main.vsize - main.size), 0, main.vsize - main.size, main.begin + main.size);
      bytes = end;
    }
    await fh.close();
    await fs.promises.rename(tmp, target.path);
    ok = true;
    return { values: total, bytes, cancelled: false };
  } finally {
    if (!ok) { await fh.close().catch(() => {}); await fs.promises.unlink(tmp).catch(() => {}); }
  }
}
