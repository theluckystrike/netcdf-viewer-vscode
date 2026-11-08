// HDF5 and NetCDF-4 backend on top of h5wasm (Node build: the HDF5 C library reads the file by offset,
// so only the bytes of the requested slice and the metadata are read).
import { viewToHyperslab, toH5Ranges, toRows, product } from './slice.mjs';
import { describeH5Type, describeFilters, unreadableFilters, attrValue, jsonSafe, isNumericH5 } from './values.mjs';
import { packing, decodeValue, parseTimeUnits, decodeTime, cfSummary } from './cf.mjs';
import { stats } from './stats.mjs';
import { complexMembers, complexPart, magnitude } from './complex.mjs';

const INTERNAL_ATTRS = new Set(['DIMENSION_LIST', 'REFERENCE_LIST', 'CLASS', 'NAME', '_Netcdf4Dimid', '_Netcdf4Coordinates', '_NCProperties', '_nc3_strict', '_SuperblockVersion', '_IsNetcdf4']);
const NC_DIM_ONLY = 'This is a netCDF dimension but not a netCDF variable';
const MAX_CHILDREN = 5000;

const join = (g, k) => (g === '/' ? '' : g) + '/' + k;
const base = p => p.slice(p.lastIndexOf('/') + 1);

function readAttrs(obj) {
  const out = {}, list = [];
  let names = [];
  try { names = Object.keys(obj.attrs); } catch { return { map: out, list }; }
  for (const name of names) {
    let value, dtype = '';
    try {
      const a = obj.attrs[name];
      dtype = describeH5Type(a.metadata);
      value = a.metadata && a.metadata.type === 7 ? '<reference>' : a.value;
    } catch (e) { value = '<unreadable: ' + e.message + '>'; }
    if (!(Array.isArray(value) && value.length && typeof value[0] === 'object' && value[0] && !ArrayBuffer.isView(value[0]))) out[name] = value;
    list.push({ name, value: attrValue(Array.isArray(value) && value.some(x => x && typeof x === 'object' && !ArrayBuffer.isView(x) && !Array.isArray(x)) ? '<references>' : value), dtype, internal: INTERNAL_ATTRS.has(name) });
  }
  return { map: out, list };
}

function strAttr(map, k) {
  const v = map[k];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

// MATLAB v7.3 MAT-files store arrays column-major, so HDF5 sees every dimension in reverse order. Datasets with a
// MATLAB_class attribute are shown in MATLAB's order (rows x columns): shapes are reversed and reads mapped back.
const rev = a => (Array.isArray(a) ? a.slice().reverse() : a);
const MAX_CHARS = 1_000_000;

export function openHdf5(h5wasm, filePath, opts = {}) {
  const file = new h5wasm.File(filePath, 'r');
  const matlab = !!opts.matlab;
  const rootAttrs = readAttrs(file);
  let isNc4 = '_NCProperties' in rootAttrs.map || /CF-|COARDS/i.test(strAttr(rootAttrs.map, 'Conventions') || '');
  const dimCache = new Map();

  function getObj(path) {
    const o = path === '/' ? file : file.get(path);
    if (!o) throw new Error('Not found: ' + path);
    return o;
  }

  function kindOf(o) {
    // instanceof, not constructor.name: names do not survive minification.
    if (!o) return 'missing';
    if (o instanceof h5wasm.Dataset) return 'dataset';
    if (o instanceof h5wasm.Group) return 'group';
    if (h5wasm.Datatype && o instanceof h5wasm.Datatype) return 'datatype';
    if (o.type === 'ExternalLink') return 'external';
    if (o.type === 'BrokenSoftLink') return 'broken';
    return 'other';
  }

  function dimNames(ds, path) {
    if (dimCache.has(path)) return dimCache.get(path);
    const shape = ds.shape || [];
    const names = [], coords = [];
    let labels = [];
    try { labels = ds.get_dimension_labels() || []; } catch { /* no labels */ }
    let selfScale = false;
    try { const a = readAttrs(ds).map; selfScale = strAttr(a, 'CLASS') === 'DIMENSION_SCALE' && shape.length === 1; } catch { /* plain dataset */ }
    if (selfScale) { isNc4 = true; const r = { names: [base(path)], coords: [path] }; dimCache.set(path, r); return r; }
    for (let i = 0; i < shape.length; i++) {
      let scales = [];
      try { scales = ds.get_attached_scales(i) || []; } catch { /* not attached */ }
      if (scales.length) { names.push(base(scales[0])); coords.push(scales[0]); isNc4 = true; } else { names.push(labels[i] || `dim_${i}`); coords.push(null); }
    }
    const r = { names, coords };
    dimCache.set(path, r);
    return r;
  }

  /** MATLAB class of a dataset in a v7.3 MAT-file ('double', 'char', 'logical', 'cell', ...), or null. */
  function matClass(o) {
    if (!matlab) return null;
    try { const a = o.attrs && o.attrs.MATLAB_class; const v = a ? a.value : null; return typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null; } catch { return null; }
  }
  /** MATLAB char arrays (uint16 codes): one string per row. */
  const isMatChar = (o, m, mc) => mc === 'char' && m && m.type === 0 && (o.shape || []).length === 2;
  function dtypeOf(o, m, mc) {
    const cm = complexMembers(m);
    if (cm) return `complex${cm.size * 16}`;
    if (mc === 'char' && isMatChar(o, m, mc)) return 'char';
    if (mc === 'logical') return 'logical';
    return describeH5Type(m);
  }
  /** Shape as the user sees it: MATLAB order for MAT-file arrays, strings per row for MATLAB char. */
  function shapeOf(o, m, mc) {
    const s = o.shape || [];
    if (!mc) return s;
    if (isMatChar(o, m, mc)) return s[1] === 1 ? [] : [s[1]];
    return rev(s);
  }

  function entry(group, key) {
    const path = join(group, key);
    let o;
    try { o = file.get(path); } catch (e) { return { name: key, path, kind: 'error', error: e.message }; }
    const kind = kindOf(o);
    const e = { name: key, path, kind };
    if (kind === 'external') { e.target = `${o.filename}:${o.obj_path}`; return e; }
    if (kind === 'broken') { e.target = o.target; return e; }
    if (kind === 'group') { try { e.children = o.keys().length; } catch { e.children = 0; } return e; }
    if (kind === 'dataset') {
      try {
        const mc = matClass(o);
        e.shape = shapeOf(o, o.metadata, mc);
        e.dtype = dtypeOf(o, o.metadata, mc);
        const a = readAttrs(o).map;
        const nm = strAttr(a, 'NAME');
        if (nm && nm.startsWith(NC_DIM_ONLY)) e.kind = 'dimension';
        if (strAttr(a, 'CLASS') === 'DIMENSION_SCALE') e.isCoord = true;
        e.longName = strAttr(a, 'long_name');
        e.units = strAttr(a, 'units');
        if (e.shape.length) e.dims = mc ? matDims(e.shape.length) : dimNames(o, path).names;
      } catch (err) { e.error = err.message; }
    }
    return e;
  }

  const matDims = n => Array.from({ length: n }, (_, i) => ['rows', 'columns', 'pages'][i] || `dim${i + 1}`);

  function list(path) {
    const g = getObj(path);
    if (kindOf(g) !== 'group') throw new Error('Not a group: ' + path);
    const keys = g.keys();
    const items = keys.slice(0, MAX_CHILDREN).map(k => entry(path, k));
    return { path, items, more: Math.max(0, keys.length - MAX_CHILDREN) };
  }

  function info(path) {
    const o = getObj(path);
    const kind = kindOf(o);
    const a = readAttrs(o);
    const out = { path, name: path === '/' ? '/' : base(path), kind, attrs: a.list };
    if (path === '/') { out.format = matlab ? 'MATLAB MAT-file v7.3 (HDF5)' : isNc4 ? 'NetCDF-4 (HDF5)' : 'HDF5'; }
    if (kind === 'group') { out.children = o.keys().length; return out; }
    if (kind !== 'dataset') return out;
    const m = o.metadata;
    const mc = matClass(o);
    const cm = complexMembers(m);
    out.shape = shapeOf(o, m, mc);
    out.dtype = dtypeOf(o, m, mc);
    out.numeric = isNumericH5(m) && !isMatChar(o, m, mc) || !!cm;
    out.complex = !!cm;
    out.compound = m.type === 6 && !cm ? m.compound_type.members.map(x => x.name) : null;
    out.chunks = m.chunks ? (mc ? rev(m.chunks) : m.chunks) : null;
    out.maxshape = m.maxshape ? (mc ? rev(m.maxshape) : m.maxshape) : null;
    if (mc && isMatChar(o, m, mc)) out.maxshape = null;
    out.itemSize = m.size;
    out.bytes = product(o.shape || []) * m.size;
    try { out.filters = describeFilters(o.filters); } catch { out.filters = []; }
    if (mc) {
      out.dims = matDims(out.shape.length);
      out.coords = out.shape.map(() => null);
      out.colMajor = true;
      out.matlabClass = mc;
    } else {
      const dn = dimNames(o, path);
      out.dims = dn.names;
      out.coords = dn.coords.map(c => {
        if (!c || c === path) return null;
        try { const cd = file.get(c); const ca = readAttrs(cd).map; const nm = strAttr(ca, 'NAME'); return nm && nm.startsWith(NC_DIM_ONLY) ? null : c; } catch { return null; }
      });
    }
    out.cf = cfSummary(a.map);
    const nm = strAttr(a.map, 'NAME');
    out.dimensionOnly = !!(nm && nm.startsWith(NC_DIM_ONLY));
    return out;
  }

  /** MATLAB char array -> one string per row (MATLAB order), read whole (capped). */
  function matStrings(o) {
    const s = o.shape || [];
    if (product(s) > MAX_CHARS) throw new Error(`This char array has ${product(s)} characters; the limit is ${MAX_CHARS}.`);
    const codes = o.value;
    const rows = s[1], len = s[0];
    // HDF5 shape [len, rows]: element (j, i) is character j of row i.
    return Array.from({ length: rows }, (_, i) => { let t = ''; for (let j = 0; j < len; j++) t += String.fromCharCode(Number(codes[j * rows + i])); return t; });
  }

  function read(path, view, decode = true, part = 'complex') {
    const o = getObj(path);
    if (kindOf(o) !== 'dataset') throw new Error('Not a dataset: ' + path);
    const m = o.metadata;
    const mc = matClass(o);
    if (mc && isMatChar(o, m, mc)) {
      const strs = matStrings(o);
      const shape = strs.length === 1 ? [] : [strs.length];
      const hs = viewToHyperslab(shape, { ...view, colAxis: -1 });
      const vals = shape.length ? Array.from({ length: hs.count[0] }, (_, k) => strs[hs.start[0] + k * hs.step[0]]) : [strs[0]];
      return { path, start: hs.start, count: hs.count, step: hs.step, rows: hs.rows, cols: hs.cols, values: toRows(vals, hs), times: null, stats: null, decoded: false, compound: null };
    }
    if (mc) {
      // Map the MATLAB-order view onto the reversed HDF5 dimensions, read, and give the indices back in MATLAB order.
      const nd = (o.shape || []).length;
      const flip = a => (a === -1 || a === undefined ? a : nd - 1 - a);
      const r = readRaw(path, o, m, { ...view, rowAxis: flip(view.rowAxis ?? 0), colAxis: view.colAxis === undefined ? undefined : flip(view.colAxis), index: rev(view.index || []) }, decode, part);
      return { ...r, start: rev(r.start), count: rev(r.count), step: rev(r.step) };
    }
    return readRaw(path, o, m, view, decode, part);
  }

  function readRaw(path, o, m, view, decode, part) {
    const shape = o.shape || [];
    const hs = viewToHyperslab(shape, view);
    const n = product(hs.count);
    if (opts.maxReadValues && n > opts.maxReadValues) throw new Error(`Slice has ${n} values; the limit is ${opts.maxReadValues}.`);
    let filters = [];
    try { filters = o.filters || []; } catch { /* no filter pipeline */ }
    const bad = unreadableFilters(filters);
    if (bad && n > 0) throw new Error(bad);
    let flat;
    try {
      flat = shape.length === 0 ? [o.value] : (n === 0 ? [] : o.slice(toH5Ranges(hs)));
    } catch (e) {
      const f = (() => { try { return describeFilters(o.filters).map(x => x.name).join(', '); } catch { return ''; } })();
      throw new Error('Cannot read this dataset' + (f ? ` (filters: ${f})` : '') + ': ' + (e.message || e));
    }
    if (!flat || typeof flat.length !== 'number') flat = [flat];
    const attrs = readAttrs(o).map;
    const cm = complexMembers(m);
    if (cm) {
      const vals = new Array(flat.length);
      for (let i = 0; i < flat.length; i++) { const x = flat[i] || []; vals[i] = complexPart(x[cm.re], x[cm.im], part); }
      const st = stats(part === 'complex' ? vals.map(magnitude) : vals);
      return { path, start: hs.start, count: hs.count, step: hs.step, rows: hs.rows, cols: hs.cols, values: toRows(vals.map(jsonSafe), hs), times: null, stats: st, statsOf: part === 'complex' ? 'abs' : part, decoded: false, compound: null, part };
    }
    const p = decode && isNumericH5(m) ? packing(attrs) : null;
    const tu = decode ? parseTimeUnits(strAttr(attrs, 'units')) : null;
    const vals = new Array(flat.length);
    for (let i = 0; i < flat.length; i++) vals[i] = p ? decodeValue(typeof flat[i] === 'bigint' ? Number(flat[i]) : flat[i], p) : flat[i];
    const st = isNumericH5(m) ? stats(vals) : null;
    const times = tu && isNumericH5(m) ? toRows(vals.map(v => decodeTime(v, tu, strAttr(attrs, 'calendar'))), hs) : null;
    return { path, start: hs.start, count: hs.count, step: hs.step, rows: hs.rows, cols: hs.cols, values: toRows(vals.map(jsonSafe), hs), times, stats: st, decoded: !!p, compound: m.type === 6 ? m.compound_type.members.map(x => x.name) : null };
  }

  return {
    format: 'hdf5',
    get label() { return matlab ? 'MATLAB MAT-file v7.3 (HDF5)' : isNc4 ? 'NetCDF-4 (HDF5)' : 'HDF5'; },
    list, info, read,
    close() { try { file.close(); } catch { /* already closed */ } },
  };
}
