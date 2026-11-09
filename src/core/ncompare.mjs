// Zovo Pro: compare two NetCDF or HDF5 files, like nccmp or `cdo diffv`. Lists variables in one file only, changed
// shapes, types and attributes, and reads every value of every numeric variable that is in both files with the same
// shape: max and mean absolute difference, RMSE, values that differ (beyond an optional tolerance), fill and NaN
// mismatches and where the largest difference is. Values are compared after CF decoding (scale_factor, add_offset,
// _FillValue), so a packed file and an unpacked copy compare equal.
// callA / callB(op, payload) talk to one reader each (the worker ops list, info and block).
import { planBlocks, fullSelection, walk, indexLabel } from './blocks.mjs';
import { product } from './slice.mjs';

const shapeText = (s, dims) => (s.length ? s.map((n, i) => (dims && dims[i] ? `${dims[i]}=${n}` : String(n))).join(' × ') : 'scalar');
const sameArr = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Attribute names whose values differ, are added or are removed (internal HDF5/NetCDF attributes ignored). */
export function attrDiff(a, b) {
  const m = list => new Map((list || []).filter(x => !x.internal).map(x => [x.name, JSON.stringify(x.value)]));
  const ma = m(a), mb = m(b);
  const out = [];
  for (const [k, v] of ma) if (!mb.has(k)) out.push(`-${k}`); else if (mb.get(k) !== v) out.push(k);
  for (const k of mb.keys()) if (!ma.has(k)) out.push(`+${k}`);
  return out;
}

export function emptyAcc() { return { n: 0, nDiff: 0, fillMismatch: 0, nanMismatch: 0, infMismatch: 0, bothFill: 0, sumAbs: 0, sumSq: 0, maxAbs: 0, maxAt: -1 }; }

/** a, b: { values: Float64Array, fill: Uint8Array }; base(i) -> flat index of value i in the variable. */
export function accumulate(acc, a, b, tol, base) {
  const x = a.values, y = b.values, fx = a.fill, fy = b.fill;
  let { n, nDiff, fillMismatch, nanMismatch, infMismatch, bothFill, sumAbs, sumSq, maxAbs, maxAt } = acc;
  for (let i = 0; i < x.length; i++) {
    if (fx[i] || fy[i]) { if (fx[i] && fy[i]) bothFill++; else fillMismatch++; continue; }
    const p = x[i], q = y[i];
    if (p !== p || q !== q) { if ((p !== p) !== (q !== q)) nanMismatch++; continue; }
    if (p === Infinity || p === -Infinity || q === Infinity || q === -Infinity) { if (p !== q) infMismatch++; continue; }
    const d = p - q, ad = d < 0 ? -d : d;
    if (ad > tol) nDiff++;
    if (ad > maxAbs) { maxAbs = ad; maxAt = base(i); }
    sumAbs += ad; sumSq += d * d; n++;
  }
  Object.assign(acc, { n, nDiff, fillMismatch, nanMismatch, infMismatch, bothFill, sumAbs, sumSq, maxAbs, maxAt });
}

/**
 * opts: { callA, callB, nameA, nameB, maxValues, tolerance, cancelled(), progress(fraction, text), now() }
 * Returns the report (kind 'compare'), rows sorted with the changes first.
 */
export async function compareFiles(opts) {
  const { callA, callB, nameA, nameB } = opts;
  const maxValues = opts.maxValues || 1_000_000;
  const tol = Math.max(0, Number(opts.tolerance) || 0);
  const cancelled = opts.cancelled || (() => false);
  const progress = opts.progress || (() => {});
  const now = opts.now || Date.now;
  const t0 = now();
  const [wa, wb] = await Promise.all([walk(p => callA('list', { path: p })), walk(p => callB('list', { path: p }))]);
  const [rootA, rootB] = await Promise.all([callA('info', { path: '/' }), callB('info', { path: '/' })]);
  const dsA = new Map(wa.items.filter(x => x.kind === 'dataset').map(x => [x.path, x]));
  const dsB = new Map(wb.items.filter(x => x.kind === 'dataset').map(x => [x.path, x]));
  const paths = [...new Set([...dsA.keys(), ...dsB.keys()])];
  const rows = [];
  const gl = attrDiff(rootA.attrs, rootB.attrs);
  if (gl.length) rows.push({ path: '/ (global attributes)', status: 'attrs differ', attrs: gl.join(', '), note: '' });
  // Work for the progress bar: values of the variables that will be read.
  const infos = new Map();
  let work = 0;
  for (const p of paths) {
    if (!dsA.has(p) || !dsB.has(p)) continue;
    const [ia, ib] = await Promise.all([callA('info', { path: p }).catch(e => ({ error: e.message })), callB('info', { path: p }).catch(e => ({ error: e.message }))]);
    infos.set(p, [ia, ib]);
    if (!ia.error && !ib.error && ia.numeric && ib.numeric && !ia.compound && !ib.compound && sameArr(ia.shape, ib.shape)) work += Math.max(1, product(ia.shape));
  }
  let done = 0, stopped = false;
  for (const p of paths) {
    const a = dsA.get(p), b = dsB.get(p);
    const row = { path: p, status: '', dtypeA: a ? a.dtype : '', dtypeB: b ? b.dtype : '', shapeA: a ? shapeText(a.shape, a.dims) : '', shapeB: b ? shapeText(b.shape, b.dims) : '',
      maxAbs: null, meanAbs: null, rmse: null, compared: null, differing: null, fillMismatch: null, maxAt: '', attrs: '', note: '' };
    rows.push(row);
    if (!a) { row.status = 'only in B'; continue; }
    if (!b) { row.status = 'only in A'; continue; }
    const [ia, ib] = infos.get(p);
    if (ia.error || ib.error) { row.status = 'not compared'; row.note = ia.error || ib.error; continue; }
    row.dtypeA = ia.dtype; row.dtypeB = ib.dtype;
    row.attrs = attrDiff(ia.attrs, ib.attrs).join(', ');
    const notes = [];
    if (!sameArr(ia.dims || [], ib.dims || [])) notes.push(`Dimension names ${(ia.dims || []).join(', ')} vs ${(ib.dims || []).join(', ')}.`);
    if (!sameArr(ia.shape, ib.shape)) { row.status = 'shape differs'; row.note = notes.join(' '); continue; }
    if (!ia.numeric || !ib.numeric || ia.compound || ib.compound) {
      row.status = ia.dtype !== ib.dtype ? 'type differs' : row.attrs ? 'attrs differ' : 'not compared';
      notes.push('Text or compound values are not compared.'); row.note = notes.join(' '); continue;
    }
    if (stopped || cancelled()) { stopped = true; row.status = 'not compared'; row.note = 'Stopped before this variable.'; continue; }
    const shape = ia.shape;
    const acc = emptyAcc();
    let failed = null;
    const ccount = shape.length >= 2 ? shape[shape.length - 1] : 1;
    for (const blk of planBlocks(shape, fullSelection(shape), maxValues)) {
      if (cancelled()) { stopped = true; break; }
      let ra, rb;
      try {
        [ra, rb] = await Promise.all([callA('block', { path: p, view: blk.view, decode: true }), callB('block', { path: p, view: blk.view, decode: true })]);
      } catch (e) { failed = e.message || String(e); break; }
      if (ra.text || rb.text) { failed = 'Text values are not compared.'; break; }
      const base = shape.length >= 2 ? i => blk.out + Math.floor(i / blk.cols) * ccount + (i % blk.cols) : i => blk.out + i;
      accumulate(acc, ra, rb, tol, base);
      done += blk.rows * blk.cols;
      progress(Math.min(1, done / (work || 1)), p);
    }
    if (failed) { row.status = 'not compared'; notes.push(failed); row.note = notes.join(' '); continue; }
    if (stopped) { row.status = 'not compared'; row.note = 'Stopped while this variable was read.'; continue; }
    Object.assign(row, {
      compared: acc.n + acc.fillMismatch + acc.nanMismatch + acc.infMismatch + acc.bothFill,
      differing: acc.nDiff + acc.fillMismatch + acc.nanMismatch + acc.infMismatch,
      fillMismatch: acc.fillMismatch, maxAbs: acc.maxAbs, meanAbs: acc.n ? acc.sumAbs / acc.n : 0, rmse: acc.n ? Math.sqrt(acc.sumSq / acc.n) : 0,
      maxAt: acc.maxAt >= 0 && acc.maxAbs > 0 ? indexLabel(acc.maxAt, shape, ia.dims) : '',
    });
    if (acc.fillMismatch) notes.push(`${acc.fillMismatch.toLocaleString('en-US')} values are fill in one file only.`);
    if (acc.nanMismatch) notes.push(`${acc.nanMismatch.toLocaleString('en-US')} NaN in one file only.`);
    if (ia.dtype !== ib.dtype) notes.push(`Type ${ia.dtype} vs ${ib.dtype}.`);
    if (tol > 0 && acc.maxAbs > 0 && acc.nDiff === 0) notes.push(`All differences are within the tolerance ${tol}.`);
    row.note = notes.join(' ');
    row.status = row.differing > 0 ? 'changed' : ia.dtype !== ib.dtype ? 'type differs' : row.attrs ? 'attrs differ' : 'identical';
  }
  const order = { changed: 0, 'shape differs': 1, 'type differs': 2, 'attrs differ': 3, 'only in A': 4, 'only in B': 5, 'not compared': 6, identical: 7 };
  rows.sort((x, y) => (order[x.status] - order[y.status]) || ((y.maxAbs || 0) - (x.maxAbs || 0)) || x.path.localeCompare(y.path));
  const count = s => rows.filter(r => r.status === s).length;
  const summary = {
    variablesA: dsA.size, variablesB: dsB.size, identical: count('identical'), changed: count('changed'), shapeDiffers: count('shape differs'),
    typeDiffers: count('type differs'), attrsDiffer: count('attrs differ'), onlyA: count('only in A'), onlyB: count('only in B'), notCompared: count('not compared'),
    valuesCompared: rows.reduce((s, r) => s + (r.compared || 0), 0), truncated: wa.truncated || wb.truncated, tolerance: tol,
  };
  return { kind: 'compare', fileA: nameA, fileB: nameB, formatA: rootA.format || '', formatB: rootB.format || '', created: new Date(now()).toISOString(), ms: now() - t0, stopped, summary, rows };
}
