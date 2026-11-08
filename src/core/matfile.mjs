// MATLAB MAT-file reader for the Level 5 format (MATLAB's default "-v7" and older "-v6" saves) and the Level 4 format.
// Pure JavaScript, read-only, nothing from the file is ever run. v7.3 MAT-files are HDF5 and go to the HDF5 backend.
//
// Level 5 layout: a 128-byte header (text, subsystem offset, version, endian mark "IM" or "MI"), then data elements.
// Each element has an 8-byte tag (type, byte count) or a 4-byte "small element" tag with up to 4 bytes of data.
// A variable is a miMATRIX element (array flags, dimensions, name, then the data), or a miCOMPRESSED element that
// holds a zlib-packed miMATRIX. Uncompressed values are read by byte offset when a slice is shown, so a big file is
// never loaded whole. A compressed variable is unpacked when it is opened, only up to a size limit, so a small file that
// would unpack to gigabytes (a "zip bomb") is refused instead.
//
// MATLAB stores arrays column-major (the first index changes fastest). Shapes and slices here use MATLAB's order:
// an m x n matrix has m rows and n columns, exactly as MATLAB shows it.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { viewToHyperslab, toRows, product, forEachIndex } from './slice.mjs';
import { jsonSafe } from './values.mjs';
import { stats } from './stats.mjs';
import { complexPart, magnitude } from './complex.mjs';

export const MAX_INFLATE = 256 * 1024 * 1024; // bytes one compressed variable may unpack to
const MAX_CACHE = 512 * 1024 * 1024; // unpacked variables kept in memory at once
const MAX_DEPTH = 64; // cells in cells in structs ...
const MAX_NODES = 500_000; // elements parsed in one file (cells, struct fields)
const MAX_CHARS = 4_000_000;
const WHOLE_READ = 16 * 1024 * 1024; // data elements up to this size are read in one go
const BLOCK = 256 * 1024;

// Data types (miXXX) -> size and getter.
const MI = {
  1: { n: 'int8', size: 1, get: (dv, o) => dv.getInt8(o) },
  2: { n: 'uint8', size: 1, get: (dv, o) => dv.getUint8(o) },
  3: { n: 'int16', size: 2, get: (dv, o, le) => dv.getInt16(o, le) },
  4: { n: 'uint16', size: 2, get: (dv, o, le) => dv.getUint16(o, le) },
  5: { n: 'int32', size: 4, get: (dv, o, le) => dv.getInt32(o, le) },
  6: { n: 'uint32', size: 4, get: (dv, o, le) => dv.getUint32(o, le) },
  7: { n: 'single', size: 4, get: (dv, o, le) => dv.getFloat32(o, le) },
  9: { n: 'double', size: 8, get: (dv, o, le) => dv.getFloat64(o, le) },
  12: { n: 'int64', size: 8, get: (dv, o, le) => dv.getBigInt64(o, le) },
  13: { n: 'uint64', size: 8, get: (dv, o, le) => dv.getBigUint64(o, le) },
  16: { n: 'utf8', size: 1, get: (dv, o) => dv.getUint8(o) },
  17: { n: 'utf16', size: 2, get: (dv, o, le) => dv.getUint16(o, le) },
  18: { n: 'utf32', size: 4, get: (dv, o, le) => dv.getUint32(o, le) },
};
const miMATRIX = 14, miCOMPRESSED = 15;

// Array classes (mxXXX).
const CLASS = { 1: 'cell', 2: 'struct', 3: 'object', 4: 'char', 5: 'sparse', 6: 'double', 7: 'single', 8: 'int8', 9: 'uint8', 10: 'int16', 11: 'uint16', 12: 'int32', 13: 'uint32', 14: 'int64', 15: 'uint64', 16: 'function_handle', 17: 'opaque' };
const CLASS_BYTES = { 6: 8, 7: 4, 8: 1, 9: 1, 10: 2, 11: 2, 12: 4, 13: 4, 14: 8, 15: 8 };

export class MatError extends Error {}
const bad = msg => new MatError(msg);
const pad8 = n => (n + 7) & ~7;
const dimNamesFor = n => Array.from({ length: n }, (_, i) => ['rows', 'columns', 'pages'][i] || `dim${i + 1}`);

// ---------- byte sources: the file (read by offset) or an unpacked buffer ----------

function fileSource(fd, size, le) {
  return {
    size, le,
    read(off, n) {
      if (off < 0 || n < 0 || off + n > size) throw bad(`The file ends at byte ${size}, but an element needs bytes ${off} to ${off + n}. The file is probably truncated.`);
      const b = Buffer.alloc(n);
      let got = 0;
      while (got < n) { const k = fs.readSync(fd, b, got, n - got, off + got); if (!k) break; got += k; }
      if (got < n) throw bad('The file is shorter than its header says (truncated).');
      return b;
    },
  };
}
function bufSource(buf, le) {
  return {
    size: buf.length, le, buf,
    read(off, n) {
      if (off < 0 || n < 0 || off + n > buf.length) throw bad(`A compressed variable ends at byte ${buf.length}, but an element needs bytes ${off} to ${off + n}. The variable is damaged.`);
      return buf.subarray(off, off + n);
    },
  };
}
const dvOf = b => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Element tag at off; end is the end of the enclosing element. */
function tagAt(src, off, end) {
  if (off + 8 > end) {
    // A small element needs only 4 bytes of tag + 4 of data, so 8 bytes are always there.
    throw bad(`An element tag at byte ${off} runs past the end of its parent (byte ${end}).`);
  }
  const b = src.read(off, 8), dv = dvOf(b);
  const w0 = dv.getUint32(0, src.le);
  const small = w0 >>> 16;
  if (small) {
    if (small > 4) throw bad(`Bad small element at byte ${off} (${small} bytes, at most 4 allowed).`);
    return { type: w0 & 0xffff, nbytes: small, dataOff: off + 4, next: off + 8, small: true };
  }
  const nbytes = dv.getUint32(4, src.le);
  const dataOff = off + 8;
  if (dataOff + nbytes > end) throw bad(`An element at byte ${off} says it has ${nbytes} bytes, but only ${end - dataOff} are left. The file is truncated or damaged.`);
  return { type: w0, nbytes, dataOff, next: Math.min(end, dataOff + (w0 === miCOMPRESSED ? nbytes : pad8(nbytes))) };
}

function readInts(src, tag, what) {
  const t = MI[tag.type];
  if (!t || !(tag.type <= 6 || tag.type === 12 || tag.type === 13)) throw bad(`${what}: unexpected data type ${tag.type}.`);
  if (tag.nbytes % t.size) throw bad(`${what}: ${tag.nbytes} bytes is not a whole number of values.`);
  const n = tag.nbytes / t.size;
  if (n > 1 << 24) throw bad(`${what}: too many values (${n}).`);
  const b = src.read(tag.dataOff, tag.nbytes), dv = dvOf(b);
  return Array.from({ length: n }, (_, i) => Number(t.get(dv, i * t.size, src.le)));
}
function readText(src, tag) {
  if (!tag.nbytes) return '';
  if (tag.nbytes > 1 << 20) throw bad('A name is longer than 1 MB.');
  const b = src.read(tag.dataOff, tag.nbytes);
  let s = Buffer.from(b).toString('utf8');
  const z = s.indexOf('\0');
  if (z >= 0) s = s.slice(0, z);
  return s;
}
/** Names from the file go into paths: no slashes, no control characters, not empty. */
function cleanName(s, fallback) {
  const t = String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\//g, '∕').slice(0, 256);
  return t || fallback;
}

// ---------- miMATRIX ----------

/**
 * Parses the header of a miMATRIX whose data runs from off to end, and finds where its parts are.
 * Values are not read. Containers (cell, struct, object) keep the byte range of their children, parsed on demand.
 */
function parseMatrix(src, off, end, ctx, depth, headerOnly = false) {
  if (depth > MAX_DEPTH) throw bad(`Cells or structs are nested more than ${MAX_DEPTH} levels deep.`);
  if (++ctx.nodes > MAX_NODES) throw bad(`The file has more than ${MAX_NODES.toLocaleString('en-US')} cells and fields. It is too complex to show.`);
  if (off >= end) return { cls: 0, className: 'double', dims: [0, 0], name: '', empty: true };
  let t = tagAt(src, off, end);
  if (t.type !== 6 || t.nbytes !== 8) throw bad(`Array flags expected (uint32, 8 bytes), found type ${t.type} with ${t.nbytes} bytes.`);
  const fb = dvOf(src.read(t.dataOff, 8));
  const f0 = fb.getUint32(0, src.le), nzmax = fb.getUint32(4, src.le);
  const cls = f0 & 0xff;
  const node = { cls, className: CLASS[cls] || `class ${cls}`, complex: !!(f0 & 0x800), global: !!(f0 & 0x400), logical: !!(f0 & 0x200), nzmax, src };
  if (!CLASS[cls]) throw bad(`Unknown MATLAB array class ${cls}.`);
  let p = t.next;
  if (cls === 16 || cls === 17) {
    // Function handles and objects of the new class system (string, table, datetime ...) are stored in MATLAB's
    // own internal layout. They are listed with their name and class but not decoded.
    node.dims = [1, 1];
    try {
      t = tagAt(src, p, end);
      if (t.type === 5) { node.dims = readInts(src, t, 'Dimensions'); p = t.next; t = tagAt(src, p, end); }
      if (t.type === 1 || t.type === 2) { node.name = readText(src, t); p = t.next; }
      if (cls === 17) {
        const t2 = tagAt(src, p, end); p = t2.next; // type system, "MCOS"
        const t3 = tagAt(src, p, end); if (t3.type === 1 || t3.type === 2) node.opaqueClass = readText(src, t3);
      }
    } catch { /* the name is enough */ }
    node.inert = true;
    return node;
  }
  t = tagAt(src, p, end);
  if (t.type !== 5) throw bad(`Dimensions expected (int32), found type ${t.type}.`);
  const dims = readInts(src, t, 'Dimensions');
  if (dims.length < 2) throw bad('A MATLAB array has at least 2 dimensions; this one has ' + dims.length + '.');
  if (dims.some(d => !(d >= 0) || d > 0x7fffffff)) throw bad('Bad dimensions: ' + dims.join(' x '));
  node.dims = dims;
  node.count = dims.reduce((a, b) => a * b, 1);
  p = t.next;
  t = tagAt(src, p, end);
  if (t.type !== 1 && t.type !== 2) throw bad(`Array name expected (int8), found type ${t.type}.`);
  node.name = readText(src, t);
  p = t.next;
  if (headerOnly && cls !== 2 && cls !== 3) return node;
  if (cls >= 6 && cls <= 15 || cls === 4) {
    const loc = part => {
      const d = tagAt(src, p, end);
      p = d.next;
      const ty = MI[d.type];
      if (!ty) throw bad(`${part} of ${node.name || 'a variable'} has unknown data type ${d.type}.`);
      // Char data that is short (some writers store empty text this way) shows what is there.
      if (d.nbytes !== node.count * ty.size && cls !== 4) throw bad(`${node.name || 'A variable'} is ${dims.join(' x ')} (${node.count.toLocaleString('en-US')} values), but its ${part} has ${d.nbytes.toLocaleString('en-US')} bytes of ${ty.n}. The file is damaged.`);
      return { type: d.type, off: d.dataOff, nbytes: d.nbytes };
    };
    if (node.count === 0 && p >= end) { node.re = { type: 9, off: 0, nbytes: 0 }; if (node.complex) node.im = node.re; return node; }
    node.re = loc('real part');
    if (node.complex) node.im = loc('imaginary part');
    return node;
  }
  if (cls === 5) {
    if (dims.length !== 2) throw bad('A sparse array must be 2-D.');
    const ti = tagAt(src, p, end); p = ti.next;
    const tj = tagAt(src, p, end); p = tj.next;
    if (ti.type !== 5 && ti.type !== 6) throw bad('Sparse row indices must be int32.');
    if (tj.type !== 5 && tj.type !== 6) throw bad('Sparse column pointers must be int32.');
    if (tj.nbytes !== (dims[1] + 1) * 4) throw bad(`Sparse array has ${dims[1]} columns but ${tj.nbytes / 4} column pointers (want ${dims[1] + 1}).`);
    node.ir = { type: ti.type, off: ti.dataOff, nbytes: ti.nbytes };
    node.jc = { type: tj.type, off: tj.dataOff, nbytes: tj.nbytes };
    if (p < end) { const d = tagAt(src, p, end); p = d.next; if (!MI[d.type]) throw bad('Sparse values have an unknown type.'); node.re = { type: d.type, off: d.dataOff, nbytes: d.nbytes }; }
    if (node.complex && p < end) { const d = tagAt(src, p, end); p = d.next; if (!MI[d.type]) throw bad('Sparse imaginary values have an unknown type.'); node.im = { type: d.type, off: d.dataOff, nbytes: d.nbytes }; }
    return node;
  }
  if (cls === 3) {
    t = tagAt(src, p, end);
    node.objectClass = readText(src, t);
    p = t.next;
  }
  if (cls === 2 || cls === 3) {
    t = tagAt(src, p, end);
    const fl = readInts(src, t, 'Field name length')[0];
    p = t.next;
    t = tagAt(src, p, end);
    p = t.next;
    if (t.nbytes && (!(fl > 0) || fl > 4096)) throw bad('Bad struct field name length ' + fl + '.');
    if (t.nbytes && t.nbytes % fl) throw bad('Struct field names do not fit their length.');
    const nf = t.nbytes ? t.nbytes / fl : 0;
    const b = src.read(t.dataOff, t.nbytes);
    node.fields = Array.from({ length: nf }, (_, i) => { const s = Buffer.from(b.subarray(i * fl, (i + 1) * fl)).toString('utf8'); const z = s.indexOf('\0'); return z >= 0 ? s.slice(0, z) : s; });
    if (headerOnly) return node;
  }
  if (cls === 1 || cls === 2 || cls === 3) {
    const per = cls === 1 ? 1 : node.fields.length;
    node.nchildren = node.count * per;
    if (node.nchildren > MAX_NODES) throw bad(`${node.name || 'A variable'} has ${node.nchildren.toLocaleString('en-US')} elements; at most ${MAX_NODES.toLocaleString('en-US')} can be shown.`);
    node.span = { off: p, end };
    node.depth = depth;
  }
  return node;
}

/** The children of a cell, struct or object (one miMATRIX each), parsed when the group is opened. */
function parseChildren(node, ctx) {
  if (node.kids) return node.kids;
  const { src } = node;
  let p = node.span.off;
  const kids = [];
  for (let i = 0; i < node.nchildren; i++) {
    const t = tagAt(src, p, node.span.end);
    if (t.type !== miMATRIX) throw bad(`Element ${i + 1} of ${node.name || 'a cell or struct'} is not a MATLAB array (type ${t.type}).`);
    kids.push(parseMatrix(src, t.dataOff, t.dataOff + t.nbytes, ctx, node.depth + 1));
    p = t.next;
  }
  node.kids = kids;
  return kids;
}

// ---------- values ----------

/** Getter for element i of a data part, reading the file in blocks (or the whole part when it is small). */
function partReader(src, loc) {
  const ty = MI[loc.type];
  const le = src.le;
  if (src.buf || loc.nbytes <= WHOLE_READ) {
    const b = loc.nbytes ? src.read(loc.off, loc.nbytes) : Buffer.alloc(0);
    const dv = dvOf(b);
    return i => ty.get(dv, i * ty.size, le);
  }
  const cache = new Map();
  return i => {
    const at = i * ty.size, blk = Math.floor(at / BLOCK);
    let dv = cache.get(blk);
    if (!dv) {
      const start = blk * BLOCK, n = Math.min(BLOCK + 8, loc.nbytes - start);
      dv = dvOf(src.read(loc.off + start, n));
      if (cache.size > 64) cache.delete(cache.keys().next().value);
      cache.set(blk, dv);
    }
    return ty.get(dv, at - blk * BLOCK, le);
  };
}

/** Column-major linear index of a MATLAB-order index. */
function linear(idx, dims) {
  let k = 0, m = 1;
  for (let d = 0; d < dims.length; d++) { k += idx[d] * m; m *= dims[d]; }
  return k;
}

function charStrings(node) {
  const [m, ...rest] = node.dims;
  if (node.count > MAX_CHARS) throw bad(`This char array has ${node.count.toLocaleString('en-US')} characters; the limit is ${MAX_CHARS.toLocaleString('en-US')}.`);
  const loc = node.re;
  const b = loc.nbytes ? node.src.read(loc.off, loc.nbytes) : Buffer.alloc(0);
  let codes;
  if (loc.type === 16) codes = Array.from(Buffer.from(b).toString('utf8'), ch => ch.codePointAt(0));
  else { const g = partReader(node.src, loc); codes = Array.from({ length: node.count }, (_, i) => Number(g(i))); }
  const n = rest.reduce((a, x) => a * x, 1);
  const out = [];
  for (let i = 0; i < m; i++) {
    let s = '';
    for (let j = 0; j < n; j++) { const c = codes[i + j * m]; if (c !== undefined) s += String.fromCodePoint(c > 0x10ffff ? 0xfffd : c); }
    out.push(s);
  }
  return out;
}

/** Sparse parts as plain arrays (row indices, column pointers, values). Capped by the read limit. */
function sparseParts(node, maxValues) {
  if (node.sp) return node.sp;
  const nCols = node.dims[1];
  const gj = partReader(node.src, node.jc);
  const jc = Int32Array.from({ length: nCols + 1 }, (_, i) => Number(gj(i)));
  const nnz = jc[nCols];
  const nIr = node.ir.nbytes / 4;
  if (!(nnz >= 0) || nnz > nIr) throw bad(`The sparse array says it has ${nnz} non-zeros but stores ${nIr} row indices.`);
  for (let c = 0; c < nCols; c++) if (jc[c] > jc[c + 1] || jc[c] < 0) throw bad('Sparse column pointers are not in order. The file is damaged.');
  if (nnz > Math.max(maxValues || 0, 10_000_000)) throw bad(`This sparse array has ${nnz.toLocaleString('en-US')} non-zeros, more than can be read here.`);
  const gi = partReader(node.src, node.ir);
  const ir = Int32Array.from({ length: nnz }, (_, i) => Number(gi(i)));
  for (let i = 0; i < nnz; i++) if (ir[i] < 0 || ir[i] >= node.dims[0]) throw bad('A sparse row index is out of range. The file is damaged.');
  const vsize = t => (t ? t.nbytes / MI[t.type].size : 0);
  if (node.re && vsize(node.re) < nnz) throw bad('The sparse array has fewer values than non-zeros.');
  if (node.im && vsize(node.im) < nnz) throw bad('The sparse array has fewer imaginary values than non-zeros.');
  const gr = node.re ? partReader(node.src, node.re) : () => 1;
  const gim = node.im ? partReader(node.src, node.im) : null;
  node.sp = { jc, ir, nnz, re: i => gr(i), im: gim };
  return node.sp;
}

// ---------- the backend ----------

/** Level 5 header fields from the first 128 bytes, or null. */
export function matHeader(head) {
  if (!head || head.length < 128) return null;
  const e = String.fromCharCode(head[126], head[127]);
  if (e !== 'IM' && e !== 'MI') return null;
  const le = e === 'IM';
  const dv = dvOf(head);
  const version = dv.getUint16(124, le);
  if (version !== 0x0100 && version !== 0x0200) return null;
  let text = Buffer.from(head.subarray(0, 116)).toString('latin1');
  const z = text.indexOf('\0'); if (z >= 0) text = text.slice(0, z);
  const subsys = head.subarray(116, 124);
  const subsysOffset = subsys.every(x => x === 0 || x === 0x20) ? 0 : Number(le ? dv.getBigUint64(116, true) : dv.getBigUint64(116, false));
  return { le, text: text.trim(), version, subsysOffset };
}

export function openMatV5(filePath, opts = {}) {
  const fd = fs.openSync(filePath, 'r');
  try { return matV5Backend(fd, opts); } catch (e) { fs.closeSync(fd); throw e; }
}

function matV5Backend(fd, opts) {
  const size = fs.fstatSync(fd).size;
  const head = Buffer.alloc(128);
  fs.readSync(fd, head, 0, 128, 0);
  const h = matHeader(head);
  if (!h) throw bad('This is not a MATLAB Level 5 MAT-file (bad header).');
  const src = fileSource(fd, size, h.le);
  const ctx = { nodes: 0 };
  const maxInflate = opts.maxInflateBytes || MAX_INFLATE;
  const top = [];
  let compressed = 0, problem = null;
  let p = 128;
  while (p < size) {
    let t;
    try { t = tagAt(src, p, size); } catch (e) { problem = `The file stops in the middle of an element at byte ${p.toLocaleString('en-US')} (${e.message}) The ${top.length} variables before it are shown.`; break; }
    if (h.subsysOffset && p === h.subsysOffset) { p = t.next; continue; } // MATLAB's internal subsystem data
    const at = p;
    p = t.next;
    if (t.type === miMATRIX) {
      try { top.push(parseMatrix(src, t.dataOff, t.dataOff + t.nbytes, ctx, 0)); } catch (e) { top.push({ error: e.message, name: `(variable at byte ${at})` }); }
    } else if (t.type === miCOMPRESSED) {
      compressed++;
      top.push(lazyCompressed(src, t, at, ctx, maxInflate));
    } else if (t.nbytes === 0 && t.type === 0) {
      continue; // padding
    } else {
      top.push({ error: `Unexpected element type ${t.type} at the top level.`, name: `(element at byte ${at})` });
    }
    if (top.length > MAX_NODES) { problem = 'Too many variables; the first ' + MAX_NODES + ' are shown.'; break; }
  }
  const label = compressed ? 'MATLAB MAT-file v7 (compressed)' : 'MATLAB MAT-file v5';
  const root = { isRoot: true, cls: 0, kids: top };
  // LRU of unpacked compressed variables, so a file with many big variables does not keep them all in memory.
  const cache = [];
  let cached = 0;
  function keep(n) {
    const i = cache.indexOf(n);
    if (i >= 0) cache.splice(i, 1);
    else cached += n.unpacked;
    cache.push(n);
    while (cached > MAX_CACHE && cache.length > 1) { const old = cache.shift(); cached -= old.unpacked; old.reset(); }
  }
  ctx.keep = keep;

  // Children of a group node with unique names (MATLAB index notation for cells and struct arrays).
  function childrenOf(n) {
    if (n.named) return n.named;
    const base = n.lazy ? materialize(n) : n;
    const kids = n.isRoot ? n.kids : n.structElement ? n.kids : base.span ? parseChildren(base, ctx) : base.cls === 1 || base.cls === 2 || base.cls === 3 ? [] : null;
    if (!kids) return null;
    const v = n.structElement ? n : base;
    const named = new Map();
    const add = (name, node) => { let k = name, i = 2; while (named.has(k)) k = `${name}~${i++}`; named.set(k, node); };
    if (n.isRoot) top.forEach((k, i) => add(cleanName(k.name, `var${i + 1}`), k));
    else if (v.cls === 1) {
      kids.forEach((k, i) => add(indexName(v.dims, i, '{', '}'), k));
    } else if (v.count === 1) {
      kids.forEach((k, i) => add(cleanName(v.fields[i], `field${i + 1}`), k));
    } else {
      // Struct array: one group per element, each with the fields.
      const nf = v.fields.length;
      for (let e = 0; e < v.count; e++) add(indexName(v.dims, e, '(', ')'), { structElement: true, fields: v.fields, kids: kids.slice(e * nf, (e + 1) * nf), cls: 2, count: 1, dims: [1, 1], className: v.className });
    }
    n.named = named;
    return named;
  }

  function materialize(n) {
    if (!n.lazy) return n;
    if (n.lazy.error) throw bad(n.lazy.error);
    const full = n.lazy.load();
    keep(n);
    return full;
  }

  function resolve(path) {
    if (path === '/') return root;
    const parts = path.split('/').slice(1);
    let n = root;
    for (const part of parts) {
      if (n.error) throw bad(n.error);
      const kids = isGroup(n) ? childrenOf(n) : null;
      if (!kids || !kids.has(part)) throw new Error('Not found: ' + path);
      n = kids.get(part);
    }
    return n;
  }

  const view = n => (n.lazy && n.lazy.full ? n.lazy.full : n.lazy ? n.lazy.head : n);
  const isGroup = n => n.isRoot || n.structElement || [1, 2, 3, 5].includes(view(n).cls) && !view(n).inert;

  function kindOf(n) {
    if (n.error) return 'error';
    if (n.lazy && n.lazy.error && !n.lazy.head) return 'error';
    const v = view(n);
    if (v.inert) return 'other';
    if (isGroup(n)) return 'group';
    return 'dataset';
  }

  function dtypeOf(v) {
    if (v.empty) return 'double';
    if (v.cls === 4) return 'char';
    if (v.logical) return 'logical';
    if (v.cls >= 6 && v.cls <= 15) return (v.complex ? 'complex ' : '') + v.className;
    return v.className;
  }
  function shapeOf(v) {
    if (v.cls === 4) { const m = v.dims[0]; return m === 1 && v.dims.length === 2 ? [] : [m, ...v.dims.slice(2)]; }
    return v.dims.slice();
  }

  function entry(name, path, n) {
    const kind = kindOf(n);
    const e = { name, path, kind };
    if (kind === 'error') { e.error = n.error || n.lazy.error; return e; }
    const v = view(n);
    if (kind === 'other') { e.target = v.opaqueClass || v.className; e.kind = 'other'; return e; }
    if (kind === 'group') {
      e.children = n.isRoot ? top.length : n.structElement ? n.fields.length : v.cls === 5 ? 2 : v.cls === 1 ? v.count : v.count === 1 ? v.fields.length : v.count;
      e.matlab = groupLabel(v, n);
      return e;
    }
    e.shape = shapeOf(v);
    e.dtype = dtypeOf(v);
    if (e.shape.length) e.dims = dimNamesFor(e.shape.length);
    return e;
  }
  const groupLabel = (v, n) => (n.structElement ? 'struct' : v.cls === 5 ? `${v.dims.join('x')} sparse${v.logical ? ' logical' : v.complex ? ' complex' : ''}` : `${v.dims.join('x')} ${v.cls === 3 ? v.objectClass || 'object' : v.className}`);

  function list(path) {
    const n = resolve(path);
    if (kindOf(n) !== 'group') throw new Error('Not a group: ' + path);
    if (n.lazy) materialize(n);
    const v = view(n);
    if (!n.isRoot && v.cls === 5) {
      const base = path === '/' ? '' : path;
      return { path, items: [sparseEntry(v, base, 'nonzeros'), sparseEntry(v, base, 'full')], more: 0 };
    }
    const kids = childrenOf(n);
    const items = [];
    for (const [name, k] of kids) { if (items.length >= 5000) break; items.push(entry(name, (path === '/' ? '' : path) + '/' + name, k)); }
    return { path, items, more: Math.max(0, kids.size - items.length) };
  }

  function sparseEntry(v, base, which) {
    if (which === 'nonzeros') return { name: 'nonzeros', path: base + '/nonzeros', kind: 'dataset', shape: [nnzOf(v)], dtype: 'row, column, value', dims: ['nonzero'] };
    return { name: 'full', path: base + '/full', kind: 'dataset', shape: v.dims.slice(), dtype: dtypeOf({ ...v, cls: v.logical ? 9 : 6, className: 'double' }), dims: dimNamesFor(2) };
  }
  const nnzOf = v => { try { return sparseParts(v, opts.maxReadValues).nnz; } catch { return 0; } };

  // A path inside a sparse group: /S/nonzeros or /S/full.
  function sparseTarget(path) {
    const i = path.lastIndexOf('/');
    const leaf = path.slice(i + 1);
    if (leaf !== 'nonzeros' && leaf !== 'full') return null;
    let parent;
    try { parent = resolve(path.slice(0, i) || '/'); } catch { return null; }
    if (parent.isRoot) return null;
    const v = view(materialize(parent) && parent);
    return v.cls === 5 && !v.inert ? { v, which: leaf } : null;
  }

  function attrsFor(v, n) {
    const a = [{ name: 'MATLAB class', value: n.structElement ? 'struct' : v.cls === 3 ? `object (${v.objectClass || '?'})` : v.inert && v.opaqueClass ? v.opaqueClass : v.className, dtype: '', internal: false }];
    if (v.dims) a.push({ name: 'MATLAB size', value: v.dims.join(' x '), dtype: '', internal: false });
    if (v.complex) a.push({ name: 'complex', value: 'yes', dtype: '', internal: false });
    if (v.logical) a.push({ name: 'logical', value: 'yes', dtype: '', internal: false });
    if (v.global) a.push({ name: 'global', value: 'yes', dtype: '', internal: false });
    if (v.fields && !n.structElement) a.push({ name: 'fields', value: v.fields.join(', '), dtype: '', internal: false });
    if (v.re && MI[v.re.type] && v.cls >= 6 && v.cls <= 15 && MI[v.re.type].n !== v.className) a.push({ name: 'stored as', value: MI[v.re.type].n + ' (MATLAB packs values into a smaller type when they fit)', dtype: '', internal: true });
    if (n.lazy) a.push({ name: 'compressed', value: `${n.lazy.compBytes.toLocaleString('en-US')} bytes in the file`, dtype: '', internal: false });
    if (v.inert) a.push({ name: 'note', value: 'MATLAB stores this kind of value in its own internal format, so its contents are not shown. Open the file in MATLAB to see them.', dtype: '', internal: false });
    return a;
  }

  function info(path) {
    if (path === '/') {
      return { path, name: '/', kind: 'group', format: label, children: top.length,
        attrs: [{ name: 'header', value: h.text, dtype: '', internal: false }, { name: 'byte order', value: h.le ? 'little-endian' : 'big-endian', dtype: '', internal: false }, { name: 'version', value: h.version === 0x0100 ? 'Level 5' : '0x' + h.version.toString(16), dtype: '', internal: false }],
        ...(problem ? { warning: problem } : {}) };
    }
    const st = sparseTarget(path);
    if (st) return sparseInfo(path, st);
    const n = resolve(path);
    const kind = kindOf(n);
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (kind === 'error') throw bad(n.error || n.lazy.error);
    if (n.lazy) materialize(n);
    const v = view(n);
    if (kind === 'group') return { path, name, kind: 'group', children: entry(name, path, n).children, attrs: attrsFor(v, n), matlab: groupLabel(v, n) };
    if (kind === 'other') return { path, name, kind: 'other', attrs: attrsFor(v, n) };
    const shape = shapeOf(v);
    const csize = v.cls === 4 ? 2 : CLASS_BYTES[v.cls] || 8;
    return {
      path, name, kind: 'dataset', shape, dims: dimNamesFor(shape.length), dtype: dtypeOf(v),
      numeric: v.cls !== 4, complex: !!v.complex, compound: null, chunks: null,
      filters: n.lazy ? [{ id: -1, name: 'zlib (MAT v7)' }] : [], itemSize: csize * (v.complex ? 2 : 1), bytes: (v.count || 0) * csize * (v.complex ? 2 : 1),
      attrs: attrsFor(v, n), cf: {}, coords: shape.map(() => null), dimensionOnly: false, colMajor: true, matlabClass: v.className,
    };
  }

  function sparseInfo(path, { v, which }) {
    const sp = sparseParts(v, opts.maxReadValues);
    const name = which;
    const attrs = [{ name: 'MATLAB class', value: `sparse ${v.logical ? 'logical' : 'double'}${v.complex ? ' (complex)' : ''}`, dtype: '', internal: false },
      { name: 'MATLAB size', value: v.dims.join(' x '), dtype: '', internal: false },
      { name: 'non-zeros', value: sp.nnz, dtype: '', internal: false },
      { name: 'density', value: v.dims[0] * v.dims[1] ? `${(100 * sp.nnz / (v.dims[0] * v.dims[1])).toPrecision(3)} %` : '-', dtype: '', internal: false }];
    if (which === 'nonzeros') {
      return { path, name, kind: 'dataset', shape: [sp.nnz], dims: ['nonzero'], dtype: 'row, column, value', numeric: false, complex: false,
        compound: v.complex ? ['row', 'column', 'real', 'imag'] : ['row', 'column', 'value'], chunks: null, filters: [], itemSize: 16, bytes: sp.nnz * 16,
        attrs: [...attrs, { name: 'note', value: 'Row and column numbers start at 1, as in MATLAB.', dtype: '', internal: false }], cf: {}, coords: [null], dimensionOnly: false, colMajor: true };
    }
    return { path, name, kind: 'dataset', shape: v.dims.slice(), dims: dimNamesFor(2), dtype: (v.complex ? 'complex ' : '') + (v.logical ? 'logical' : 'double'), numeric: true, complex: !!v.complex,
      compound: null, chunks: null, filters: [], itemSize: 8, bytes: v.dims[0] * v.dims[1] * 8,
      attrs: [...attrs, { name: 'note', value: 'Zeros are filled in for the slice on screen; the full matrix is never built in memory.', dtype: '', internal: false }], cf: {}, coords: [null, null], dimensionOnly: false, colMajor: true };
  }

  function result(path, hs, vals, numeric, part, compound) {
    const st = !numeric ? null : stats(part === 'complex' ? vals.map(magnitude) : vals);
    return { path, start: hs.start, count: hs.count, step: hs.step, rows: hs.rows, cols: hs.cols, values: toRows(vals.map(jsonSafe), hs), times: null, stats: st, ...(part === 'complex' && numeric ? { statsOf: 'abs' } : {}), decoded: false, compound: compound || null, ...(part ? { part } : {}) };
  }

  function guard(n) {
    if (opts.maxReadValues && n > opts.maxReadValues) throw new Error(`Slice has ${n} values; the limit is ${opts.maxReadValues}.`);
  }

  function read(path, viewSpec, decode = true, part = 'complex') {
    const st = sparseTarget(path);
    if (st) return readSparse(path, st, viewSpec, part);
    const n = resolve(path);
    if (kindOf(n) !== 'dataset') throw new Error('Not a dataset: ' + path);
    if (n.lazy) materialize(n);
    const v = view(n);
    if (v.cls === 4) {
      const strs = charStrings(v);
      const shape = shapeOf(v);
      if (shape.length > 1) {
        const hs = viewToHyperslab(shape, viewSpec);
        guard(product(hs.count));
        const vals = [];
        forEachIndex(hs, idx => { const k = linear(idx, shape); vals.push(strs[k]); });
        return result(path, hs, vals, false);
      }
      const hs = viewToHyperslab(shape, { ...viewSpec, colAxis: -1 });
      const vals = shape.length ? Array.from({ length: hs.count[0] }, (_, k) => strs[hs.start[0] + k * hs.step[0]]) : [strs[0] || ''];
      return result(path, hs, vals, false);
    }
    const shape = v.dims;
    const hs = viewToHyperslab(shape, viewSpec);
    const total = product(hs.count);
    guard(total);
    const vals = new Array(total);
    if (total) {
      const g = partReader(v.src, v.re);
      const gi = v.complex ? partReader(v.src, v.im) : null;
      let k = 0;
      forEachIndex(hs, idx => {
        const i = linear(idx, shape);
        vals[k++] = gi ? complexPart(g(i), gi(i), part) : g(i);
      });
    }
    return result(path, hs, vals, true, v.complex ? part : undefined);
  }

  function readSparse(path, { v, which }, viewSpec, part) {
    const sp = sparseParts(v, opts.maxReadValues);
    if (which === 'nonzeros') {
      const hs = viewToHyperslab([sp.nnz], { ...viewSpec, colAxis: -1 });
      guard(hs.count[0]);
      // Column of each non-zero: walk the column pointers once.
      const vals = [];
      let col = 0;
      for (let k = 0; k < hs.count[0]; k++) {
        const i = hs.start[0] + k * hs.step[0];
        while (col < v.dims[1] && sp.jc[col + 1] <= i) col++;
        const re = Number(sp.re(i));
        vals.push(v.complex ? [sp.ir[i] + 1, col + 1, re, Number(sp.im(i))] : [sp.ir[i] + 1, col + 1, v.logical ? (re ? 1 : 0) : re]);
      }
      return result(path, hs, vals, false, undefined, v.complex ? ['row', 'column', 'real', 'imag'] : ['row', 'column', 'value']);
    }
    const hs = viewToHyperslab(v.dims, viewSpec);
    const total = product(hs.count);
    guard(total);
    const vals = new Array(total);
    let k = 0;
    // For each cell, binary search the row in the column's sorted row indices.
    forEachIndex(hs, idx => {
      const r = idx[0], c = idx[1];
      let lo = sp.jc[c], hi = sp.jc[c + 1] - 1, found = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; const x = sp.ir[mid]; if (x === r) { found = mid; break; } if (x < r) lo = mid + 1; else hi = mid - 1; }
      const re = found >= 0 ? Number(sp.re(found)) : 0;
      if (v.complex) vals[k++] = complexPart(re, found >= 0 ? Number(sp.im(found)) : 0, part);
      else vals[k++] = v.logical ? (re ? 1 : 0) : re;
    });
    return result(path, hs, vals, true, v.complex ? part : undefined);
  }

  return { format: 'matv5', label, list, info, read, warning: problem, close() { try { fs.closeSync(fd); } catch { /* closed */ } } };
}

/** MATLAB index text for element i of an array: {3} or {2,1} for cells, (3) or (2,1) for struct arrays. */
function indexName(dims, i, open, close) {
  const vec = dims.length === 2 && (dims[0] === 1 || dims[1] === 1);
  if (vec) return `${open}${i + 1}${close}`;
  const sub = [];
  let r = i;
  for (const d of dims) { sub.push((r % d) + 1); r = Math.floor(r / d); }
  return `${open}${sub.join(',')}${close}`;
}

/**
 * A miCOMPRESSED variable: only its header is unpacked when the file opens (to list name, class and size).
 * The rest is unpacked when it is opened, up to maxInflate bytes. A variable whose header promises more, or whose
 * data unpacks to more (a zip bomb), is refused with a message.
 */
function lazyCompressed(src, tag, at, ctx, maxInflate) {
  const node = { lazy: null };
  const compBytes = tag.nbytes;
  const read = () => src.read(tag.dataOff, compBytes);
  let head = null, error = null;
  try {
    head = headerOf(src, tag);
  } catch (e) { error = e.message; }
  const est = head && head.count !== undefined ? head.count * (CLASS_BYTES[head.cls] || 1) * (head.complex ? 2 : 1) : 0;
  if (!error && est > maxInflate) error = `${head.name || 'This variable'} is ${head.dims.join(' x ')} ${head.className}, about ${(est / 1048576).toFixed(0)} MB when unpacked. The limit for one compressed variable is ${(maxInflate / 1048576).toFixed(0)} MB. In MATLAB, save it with -v7.3 to read it slice by slice.`;
  node.name = head ? head.name : `(compressed variable at byte ${at})`;
  node.lazy = {
    head, error, compBytes, full: null,
    load() {
      if (node.lazy.full) return node.lazy.full;
      let out;
      try {
        out = zlib.inflateSync(read(), { maxOutputLength: maxInflate + 1024, finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch (e) {
        if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)) throw bad(`${node.name} unpacks to more than ${(maxInflate / 1048576).toFixed(0)} MB, so it was not unpacked. It may be damaged or built to fill memory.`);
        throw bad(`The compressed data of ${node.name} is damaged (${e.message}).`);
      }
      const bs = bufSource(out, src.le);
      const t = tagAt(bs, 0, out.length);
      if (t.type !== miMATRIX) throw bad(`The compressed element of ${node.name} does not hold a MATLAB array (type ${t.type}).`);
      const full = parseMatrix(bs, t.dataOff, t.dataOff + t.nbytes, ctx, 0);
      node.lazy.full = full;
      node.unpacked = out.length;
      return full;
    },
  };
  node.reset = () => { node.lazy.full = null; node.named = null; };
  return node;
}

class ShortRead extends Error {}

/** Unpacks just enough of a compressed variable to read its header (flags, size, name, fields). Never more than 64 MB. */
function headerOf(src, tag) {
  for (const inLen of [512, 8192, 131072, 1048576]) {
    const n = Math.min(inLen, tag.nbytes);
    let out;
    try {
      out = zlib.inflateSync(src.read(tag.dataOff, n), { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: 64 * 1024 * 1024 });
    } catch (e) {
      if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)) throw bad('This compressed variable unpacks to far more data than it can hold. It was not unpacked.');
      throw bad(`Compressed data is damaged (${e.message}).`);
    }
    if (out.length >= 8) {
      const dv = dvOf(out.subarray(0, 8));
      const w0 = dv.getUint32(0, src.le), declared = dv.getUint32(4, src.le);
      if (w0 !== miMATRIX) throw bad(`A compressed element does not hold a MATLAB array (type ${w0}).`);
      // A source that knows the declared size but has only the unpacked prefix.
      const part = { size: 8 + declared, le: src.le, read(o, k) { if (o < 0 || o + k > out.length) throw new ShortRead('short'); return out.subarray(o, o + k); } };
      try { return parseMatrix(part, 8, 8 + declared, { nodes: 0 }, 0, true); } catch (e) { if (!(e instanceof ShortRead)) throw e; }
    }
    if (n === tag.nbytes) break;
  }
  throw bad('Cannot read the header of a compressed variable (it is damaged or cut short).');
}

// ---------- Level 4 ----------

const V4_TYPES = { 0: 9, 1: 7, 2: 5, 3: 3, 4: 4, 5: 2 }; // P digit -> miXXX

/** Variables of a Level 4 MAT-file, or null if the bytes are not one (every header must chain exactly to the end). */
export function probeMatV4(fd, size) {
  const vars = [];
  let p = 0;
  const hb = Buffer.alloc(20);
  while (p < size) {
    if (p + 20 > size || vars.length > 100000) return null;
    fs.readSync(fd, hb, 0, 20, p);
    let le = true;
    let type = hb.readInt32LE(0);
    if (!(type >= 0 && type < 5000)) { le = false; type = hb.readInt32BE(0); }
    const rd = o => (le ? hb.readInt32LE(o) : hb.readInt32BE(o));
    const M = Math.floor(type / 1000), O = Math.floor(type / 100) % 10, P = Math.floor(type / 10) % 10, T = type % 10;
    if (!(type >= 0 && type <= 1052) || (M !== 0 && M !== 1) || O !== 0 || P > 5 || T > 2 || (M === 0) !== le) return null;
    const mrows = rd(4), ncols = rd(8), imagf = rd(12), namlen = rd(16);
    if (mrows < 0 || ncols < 0 || (imagf !== 0 && imagf !== 1) || namlen < 1 || namlen > 4096) return null;
    const ty = MI[V4_TYPES[P]];
    const n = mrows * ncols;
    const dataOff = p + 20 + namlen;
    const bytes = n * ty.size * (imagf ? 2 : 1);
    if (!Number.isSafeInteger(bytes) || dataOff + bytes > size) return null;
    const nb = Buffer.alloc(namlen);
    fs.readSync(fd, nb, 0, namlen, p + 20);
    if (nb[namlen - 1] !== 0) return null;
    const name = nb.subarray(0, namlen - 1).toString('latin1');
    if (!/^[\x20-\x7e]*$/.test(name)) return null;
    vars.push({ le, P, T, mrows, ncols, imagf: !!imagf, name, re: { type: V4_TYPES[P], off: dataOff, nbytes: n * ty.size }, im: imagf ? { type: V4_TYPES[P], off: dataOff + n * ty.size, nbytes: n * ty.size } : null });
    p = dataOff + bytes;
  }
  return vars.length && p === size ? vars : null;
}

/** Level 4 backend: numeric and text matrices (sparse ones are shown as their row, column, value table). */
export function openMatV4(filePath, opts = {}) {
  const fd = fs.openSync(filePath, 'r');
  const size = fs.fstatSync(fd).size;
  const vars = probeMatV4(fd, size);
  if (!vars) { fs.closeSync(fd); throw bad('This is not a MATLAB Level 4 MAT-file.'); }
  const names = new Map();
  vars.forEach((v, i) => { let k = cleanName(v.name, `var${i + 1}`), j = 2; const b = k; while (names.has(k)) k = `${b}~${j++}`; names.set(k, v); });
  const srcOf = v => fileSource(fd, size, v.le);
  const get = path => { const v = names.get(path.slice(1)); if (!v || path.indexOf('/', 1) >= 0) throw new Error('Not found: ' + path); return v; };
  const dtype = v => (v.T === 1 ? 'char' : v.T === 2 ? 'sparse (row, column, value)' : (v.imagf ? 'complex ' : '') + MI[v.re.type].n.replace('single', 'single').replace('double', 'double'));
  const shapeOf = v => (v.T === 1 ? (v.mrows === 1 ? [] : [v.mrows]) : [v.mrows, v.ncols]);
  function list(path) {
    if (path !== '/') throw new Error('Level 4 MAT-files have no groups');
    return { path, items: [...names].map(([k, v]) => ({ name: k, path: '/' + k, kind: 'dataset', shape: shapeOf(v), dtype: dtype(v), dims: dimNamesFor(shapeOf(v).length) })), more: 0 };
  }
  function info(path) {
    if (path === '/') return { path, name: '/', kind: 'group', format: 'MATLAB MAT-file v4', children: names.size, attrs: [{ name: 'byte order', value: vars[0].le ? 'little-endian' : 'big-endian', dtype: '', internal: false }] };
    const v = get(path);
    const shape = shapeOf(v);
    const attrs = [{ name: 'MATLAB size', value: `${v.mrows} x ${v.ncols}`, dtype: '', internal: false }];
    if (v.T === 2) attrs.push({ name: 'note', value: 'A Level 4 sparse matrix is stored as rows of row, column and value. They are shown as stored.', dtype: '', internal: false });
    return { path, name: path.slice(1), kind: 'dataset', shape, dims: dimNamesFor(shape.length), dtype: dtype(v), numeric: v.T !== 1, complex: v.imagf && v.T === 0, compound: null, chunks: null, filters: [],
      itemSize: MI[v.re.type].size, bytes: v.re.nbytes * (v.imagf ? 2 : 1), attrs, cf: {}, coords: shape.map(() => null), dimensionOnly: false, colMajor: true };
  }
  function read(path, viewSpec, decode = true, part = 'complex') {
    const v = get(path);
    const src = srcOf(v);
    if (v.T === 1) {
      const node = { dims: [v.mrows, v.ncols], count: v.mrows * v.ncols, src, re: v.re };
      const strs = charStrings(node);
      const shape = shapeOf(v);
      const hs = viewToHyperslab(shape, { ...viewSpec, colAxis: -1 });
      const vals = shape.length ? Array.from({ length: hs.count[0] }, (_, k) => strs[hs.start[0] + k * hs.step[0]]) : [strs[0] || ''];
      return { path, start: hs.start, count: hs.count, step: hs.step, rows: hs.rows, cols: hs.cols, values: toRows(vals, hs), times: null, stats: null, decoded: false, compound: null };
    }
    const shape = [v.mrows, v.ncols];
    const hs = viewToHyperslab(shape, viewSpec);
    const total = product(hs.count);
    if (opts.maxReadValues && total > opts.maxReadValues) throw new Error(`Slice has ${total} values; the limit is ${opts.maxReadValues}.`);
    const g = partReader(src, v.re), gi = v.im && v.T === 0 ? partReader(src, v.im) : null;
    const vals = [];
    forEachIndex(hs, idx => { const i = linear(idx, shape); vals.push(gi ? complexPart(g(i), gi(i), part) : g(i)); });
    const st = stats(gi && part === 'complex' ? vals.map(magnitude) : vals);
    return { path, start: hs.start, count: hs.count, step: hs.step, rows: hs.rows, cols: hs.cols, values: toRows(vals.map(jsonSafe), hs), times: null, stats: st, decoded: false, compound: null, ...(gi ? { part } : {}) };
  }
  return { format: 'matv4', label: 'MATLAB MAT-file v4', list, info, read, close() { try { fs.closeSync(fd); } catch { /* closed */ } } };
}
