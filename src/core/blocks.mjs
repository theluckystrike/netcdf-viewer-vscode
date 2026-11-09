// Zovo Pro tools (compare two files, export a subset) read whole variables, or a selection of one, in blocks that
// fit the read limit. Pure functions: the block plan, the conversion of a worker read to numbers, and the file walk.
import { product } from './slice.mjs';

/** Full selection of a shape: start 0, every index, step 1. */
export function fullSelection(shape) { return shape.map(n => ({ start: 0, count: n, step: 1 })); }

/**
 * Plan the reads for a selection (one {start, count, step} per dimension) in row-major order of the selection.
 * Each block is a 2D view for the worker's read op: rows of the second-to-last dimension and columns of the last,
 * the leading dimensions fixed. Yields { view, lead, r0, rows, c0, cols, out } where lead/r0/c0 are positions in the
 * selection (not the file) and out is the flat index of the block's first value in the selection.
 */
export function* planBlocks(shape, sel, maxValues) {
  const nd = shape.length;
  const max = Math.max(1, Math.floor(maxValues));
  if (nd === 0) { yield { view: { rowAxis: 0, colAxis: -1, index: [] }, lead: [], r0: 0, rows: 1, c0: 0, cols: 1, out: 0 }; return; }
  if (sel.some(s => s.count === 0)) return;
  if (nd === 1) {
    const s = sel[0];
    for (let r = 0; r < s.count; r += max) {
      const rows = Math.min(max, s.count - r);
      yield { view: { rowAxis: 0, colAxis: -1, index: [0], rowStart: s.start + r * s.step, rowCount: rows, rowStep: s.step }, lead: [], r0: r, rows, c0: 0, cols: 1, out: r };
    }
    return;
  }
  const R = sel[nd - 2], C = sel[nd - 1];
  const colsPer = Math.min(C.count, max);
  const rowsPer = Math.max(1, Math.floor(max / colsPer));
  const leadSel = sel.slice(0, nd - 2);
  const leadCount = product(leadSel.map(s => s.count));
  const k = new Array(nd - 2).fill(0);
  for (let li = 0; li < leadCount; li++) {
    const index = new Array(nd).fill(0);
    for (let d = 0; d < nd - 2; d++) index[d] = leadSel[d].start + k[d] * leadSel[d].step;
    for (let r = 0; r < R.count; r += rowsPer) {
      const rows = Math.min(rowsPer, R.count - r);
      for (let c = 0; c < C.count; c += colsPer) {
        const cols = Math.min(colsPer, C.count - c);
        yield {
          view: { rowAxis: nd - 2, colAxis: nd - 1, index, rowStart: R.start + r * R.step, rowCount: rows, rowStep: R.step, colStart: C.start + c * C.step, colCount: cols, colStep: C.step },
          lead: k.slice(), r0: r, rows, c0: c, cols, out: (li * R.count + r) * C.count + c,
        };
      }
    }
    for (let d = nd - 3; d >= 0; d--) { if (++k[d] < leadSel[d].count) break; k[d] = 0; }
  }
}

/**
 * A worker read result ({ values: rows of numbers | null | 'NaN' | 'Inf' | '-Inf' | text }) -> numbers.
 * Returns { values: Float64Array (row-major), fill: Uint8Array (1 = fill or missing), text: boolean }.
 */
export function toBlock(r) {
  const rows = r.values || [];
  const nr = rows.length, nc = nr ? rows[0].length : 0;
  const values = new Float64Array(nr * nc), fill = new Uint8Array(nr * nc);
  let text = false;
  for (let i = 0; i < nr; i++) {
    const row = rows[i];
    for (let j = 0; j < nc; j++) {
      const v = row[j], o = i * nc + j;
      if (typeof v === 'number') values[o] = v;
      else if (v === null || v === undefined) { fill[o] = 1; values[o] = NaN; }
      else if (v === 'NaN') values[o] = NaN;
      else if (v === 'Inf') values[o] = Infinity;
      else if (v === '-Inf') values[o] = -Infinity;
      else if (typeof v === 'boolean') values[o] = v ? 1 : 0;
      else if (typeof v === 'string' && /^-?\d+$/.test(v)) values[o] = Number(v); // 64-bit integers beyond 2^53
      else { text = true; values[o] = NaN; }
    }
  }
  return { values, fill, text, rows: nr, cols: nc };
}

/**
 * Every dataset in the file, depth first. list(path) is the worker's list op. Stops at maxItems.
 * Returns { items: [{ path, name, shape, dims, dtype, kind }], truncated }
 */
export async function walk(list, maxItems = 5000) {
  const items = [];
  let truncated = false;
  const queue = ['/'];
  const seen = new Set();
  while (queue.length && items.length < maxItems) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    let r;
    try { r = await list(p); } catch { continue; }
    if (r.more) truncated = true;
    for (const it of r.items || []) {
      if (it.kind === 'group') queue.push(it.path);
      else if (it.kind === 'dataset' || it.kind === 'dimension') items.push({ path: it.path, name: it.name, shape: it.shape || [], dims: it.dims || [], dtype: it.dtype || '', kind: it.kind });
      if (items.length >= maxItems) { truncated = true; break; }
    }
  }
  return { items, truncated };
}

/** Index tuple text such as "time=3, lat=120, lon=40" from a flat index in a shape. */
export function indexLabel(flat, shape, dims) {
  if (!shape.length) return '';
  const idx = new Array(shape.length);
  let r = flat;
  for (let d = shape.length - 1; d >= 0; d--) { idx[d] = r % shape[d]; r = Math.floor(r / shape[d]); }
  return idx.map((v, d) => `${(dims && dims[d]) || 'dim' + d}=${v}`).join(', ');
}
