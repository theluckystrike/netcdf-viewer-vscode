// Header parser for NetCDF classic files: CDF-1 (classic), CDF-2 (64-bit offset) and CDF-5 (64-bit data,
// written by PnetCDF, WRF, E3SM and `nccopy -k cdf5`). netcdfjs reads CDF-1 and CDF-2 only.
// Returns the same shape as netcdfjs's NetCDFReader header, so netcdf3.mjs reads the values the same way.
// Spec: https://docs.unidata.ucar.edu/netcdf-c/current/file_format_specifications.html

const NC_DIMENSION = 10, NC_VARIABLE = 11, NC_ATTRIBUTE = 12;
export const CDF_TYPES = { 1: 'byte', 2: 'char', 3: 'short', 4: 'int', 5: 'float', 6: 'double', 7: 'ubyte', 8: 'ushort', 9: 'uint', 10: 'int64', 11: 'uint64' };
export const CDF_TYPE_SIZE = { byte: 1, char: 1, short: 2, int: 4, float: 4, double: 8, ubyte: 1, ushort: 2, uint: 4, int64: 8, uint64: 8 };
const MAX_ITEMS = 1 << 24; // a header list longer than this is corrupt, not big

/** Thrown when the buffer ends inside the header: the caller reads more bytes and tries again. */
export class ShortHeader extends Error {}

export function parseCdfHeader(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 0;
  const need = n => { if (p + n > u8.length) throw new ShortHeader('The NetCDF header continues past the bytes read'); };
  const i32 = () => { need(4); const v = dv.getInt32(p, false); p += 4; return v; };
  const u64 = () => {
    need(8);
    const v = dv.getBigUint64(p, false); p += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('A size in the NetCDF header is too large (corrupt file?)');
    return Number(v);
  };
  if (u8.length < 4) throw new ShortHeader('File too short');
  if (u8[0] !== 0x43 || u8[1] !== 0x44 || u8[2] !== 0x46 || ![1, 2, 5].includes(u8[3])) throw new Error('Not a NetCDF classic file (no CDF signature)');
  const version = u8[3];
  p = 4;
  const nonNeg = () => {
    const v = version === 5 ? u64() : i32();
    if (v < 0) throw new Error('Negative count in the NetCDF header (corrupt file?)');
    return v;
  };
  const offset = () => (version === 1 ? i32() : u64());
  const count = () => { const n = nonNeg(); if (n > MAX_ITEMS) throw new Error('Too many items in the NetCDF header (corrupt file?)'); return n; };
  const pad = n => (4 - (n % 4)) % 4;
  const name = () => {
    const n = count();
    need(n + pad(n));
    const s = new TextDecoder('utf-8').decode(u8.subarray(p, p + n));
    p += n + pad(n);
    return s;
  };
  // numrecs: STREAMING (all bits set) means "count the records from the file size"; we treat it as 0 here
  // and the reader fixes it from the file size (see recordsFromSize).
  let numRecs;
  if (version === 5) { need(8); const v = dv.getBigUint64(p, false); p += 8; numRecs = v === 0xffffffffffffffffn ? -1 : Number(v); }
  else { numRecs = i32(); if (numRecs === -1) numRecs = -1; }

  const list = (tag, item) => {
    const t = i32();
    const n = count();
    if (t === 0 && n === 0) return [];
    if (t !== tag) throw new Error('Unexpected tag in the NetCDF header (corrupt file?)');
    const out = [];
    for (let i = 0; i < n; i++) out.push(item(i));
    return out;
  };

  const readValues = (type, n) => {
    const size = CDF_TYPE_SIZE[type];
    if (!size) throw new Error('Unknown NetCDF type in the header');
    const bytes = n * size;
    need(bytes + pad(bytes));
    let value;
    if (type === 'char') {
      let s = new TextDecoder('utf-8').decode(u8.subarray(p, p + n));
      const z = s.indexOf('\0');
      if (z >= 0) s = s.slice(0, z);
      value = s;
    } else {
      const a = new Array(n);
      for (let i = 0; i < n; i++) a[i] = getValue(dv, p + i * size, type);
      value = n === 1 ? a[0] : a;
    }
    p += bytes + pad(bytes);
    return value;
  };

  const attrs = () => list(NC_ATTRIBUTE, () => {
    const nm = name();
    const type = CDF_TYPES[i32()];
    if (!type) throw new Error('Unknown attribute type in the NetCDF header');
    const n = count();
    return { name: nm, type, value: readValues(type, n) };
  });

  const dimensions = list(NC_DIMENSION, () => ({ name: name(), size: nonNeg() }));
  const globalAttributes = attrs();
  const recId = dimensions.findIndex(d => d.size === 0);
  const variables = list(NC_VARIABLE, () => {
    const nm = name();
    const nd = count();
    const dims = [];
    for (let i = 0; i < nd; i++) {
      const id = nonNeg();
      if (id >= dimensions.length) throw new Error('A variable uses a dimension that is not defined (corrupt file?)');
      dims.push(id);
    }
    const attributes = attrs();
    const type = CDF_TYPES[i32()];
    if (!type) throw new Error('Unknown variable type in the NetCDF header');
    const size = nonNeg();
    const off = offset();
    return { name: nm, dimensions: dims, attributes, type, size, offset: off, record: dims.length > 0 && dims[0] === recId && recId >= 0 };
  });

  // Size of one record: the sum of the record variables' padded sizes. A file with exactly one record variable
  // does not pad its records (spec: "special case").
  const recVars = variables.filter(v => v.record);
  let recordStep = recVars.reduce((s, v) => s + v.size, 0);
  if (recVars.length === 1) {
    const v = recVars[0];
    recordStep = v.dimensions.slice(1).reduce((s, id) => s * dimensions[id].size, 1) * CDF_TYPE_SIZE[v.type];
  }
  return {
    version: version === 1 ? 'classic format' : version === 2 ? '64-bit offset format' : 'CDF-5 64-bit data format',
    cdfVersion: version,
    headerSize: p,
    dimensions,
    globalAttributes,
    variables,
    recordDimension: recId >= 0 ? { id: recId, name: dimensions[recId].name, length: numRecs, recordStep } : null,
  };
}

/** One value of a NetCDF type at byte offset o (big-endian). 64-bit integers come back as Number when safe, else BigInt. */
export function getValue(dv, o, type) {
  switch (type) {
    case 'byte': return dv.getInt8(o);
    case 'char': return dv.getUint8(o);
    case 'ubyte': return dv.getUint8(o);
    case 'short': return dv.getInt16(o, false);
    case 'ushort': return dv.getUint16(o, false);
    case 'int': return dv.getInt32(o, false);
    case 'uint': return dv.getUint32(o, false);
    case 'float': return dv.getFloat32(o, false);
    case 'double': return dv.getFloat64(o, false);
    case 'int64': { const v = dv.getBigInt64(o, false); return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v; }
    case 'uint64': { const v = dv.getBigUint64(o, false); return v <= 9007199254740991n ? Number(v) : v; }
    default: throw new Error('Unknown NetCDF type ' + type);
  }
}

/** Records in a streaming file (numrecs not written yet): what fits in the file after the first record's start. */
export function recordsFromSize(header, fileSize) {
  const rd = header.recordDimension;
  if (!rd || rd.length >= 0) return rd ? rd.length : 0;
  const recVars = header.variables.filter(v => v.record);
  if (!recVars.length || !rd.recordStep) return 0;
  const begin = Math.min(...recVars.map(v => v.offset));
  return Math.max(0, Math.floor((fileSize - begin) / rd.recordStep));
}
