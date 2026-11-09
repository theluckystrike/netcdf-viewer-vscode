// Writes a NetCDF-3 file in the 64-bit offset format (CDF-2), which xarray, netCDF4-python, NCO, CDO, Panoply and
// ncview all read. Used by the Pro subset export. Fixed-size dimensions only, big-endian, no record dimension.
// The header is built first (sizes are known), then each variable's data is written at its offset.

const NC_DIMENSION = 0x0a, NC_VARIABLE = 0x0b, NC_ATTRIBUTE = 0x0c;
export const NC_TYPES = { byte: { id: 1, size: 1 }, char: { id: 2, size: 1 }, short: { id: 3, size: 2 }, int: { id: 4, size: 4 }, float: { id: 5, size: 4 }, double: { id: 6, size: 8 } };
const pad4 = n => (4 - (n % 4)) % 4;

/** A valid NetCDF name: letters, digits, underscore, dot, dash, plus and at sign; starts with a letter or underscore. */
export function ncName(s, fallback = 'var') {
  let n = String(s || '').replace(/^.*\//, '').replace(/[^A-Za-z0-9_.@+-]/g, '_');
  if (!/^[A-Za-z_]/.test(n)) n = '_' + n;
  return n.slice(0, 256) || fallback;
}

/** Attribute value -> { type, values } (text as char, integers in int32 range as int, other numbers as double). */
export function ncAttr(value, forceType) {
  if (typeof value === 'string') return { type: 'char', values: Buffer.from(value, 'utf8') };
  const arr = Array.isArray(value) ? value : [value];
  if (!arr.length || !arr.every(v => typeof v === 'number' || (typeof v === 'string' && /^(NaN|-?Inf)$/.test(v)))) return null;
  const nums = arr.map(v => (v === 'NaN' ? NaN : v === 'Inf' ? Infinity : v === '-Inf' ? -Infinity : v));
  const type = forceType || (nums.every(v => Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) ? 'int' : 'double');
  return { type, values: nums };
}

function nameBytes(s) { const b = Buffer.from(s, 'utf8'); return [u32(b.length), b, Buffer.alloc(pad4(b.length))]; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; }

/** Big-endian bytes of numbers in one NetCDF type. NaN in an integer type becomes the fill. */
export function encode(type, nums, fill) {
  const t = NC_TYPES[type];
  const b = Buffer.alloc(nums.length * t.size);
  for (let i = 0; i < nums.length; i++) {
    let v = nums[i];
    if (type === 'double') b.writeDoubleBE(v, i * 8);
    else if (type === 'float') b.writeFloatBE(v, i * 4);
    else {
      if (!Number.isFinite(v)) v = fill;
      if (type === 'int') b.writeInt32BE(Math.trunc(v), i * 4);
      else if (type === 'short') b.writeInt16BE(Math.trunc(v), i * 2);
      else b.writeInt8(Math.trunc(v), i);
    }
  }
  return b;
}

function attrList(atts) {
  const list = (atts || []).filter(Boolean);
  if (!list.length) return [u32(0), u32(0)];
  const out = [u32(NC_ATTRIBUTE), u32(list.length)];
  for (const a of list) {
    out.push(...nameBytes(a.name), u32(NC_TYPES[a.type].id));
    const data = a.type === 'char' ? a.values : encode(a.type, a.values, 0);
    out.push(u32(a.type === 'char' ? data.length : a.values.length), data, Buffer.alloc(pad4(data.length)));
  }
  return out;
}

/**
 * spec: { dims: [{ name, size }], atts: [{ name, type, values }], vars: [{ name, dims: [dimIndex], type, atts }] }
 * Returns { header: Buffer, vars: [{ begin, vsize, size, type }] } with begin = byte offset of each variable's data.
 */
export function buildHeader(spec) {
  const build = begins => {
    const parts = [Buffer.from([0x43, 0x44, 0x46, 0x02]), u32(0)];
    if (spec.dims.length) { parts.push(u32(NC_DIMENSION), u32(spec.dims.length)); for (const d of spec.dims) parts.push(...nameBytes(d.name), u32(d.size)); } else parts.push(u32(0), u32(0));
    parts.push(...attrList(spec.atts));
    if (spec.vars.length) {
      parts.push(u32(NC_VARIABLE), u32(spec.vars.length));
      spec.vars.forEach((v, i) => {
        parts.push(...nameBytes(v.name), u32(v.dims.length), ...v.dims.map(u32), ...attrList(v.atts), u32(NC_TYPES[v.type].id));
        const bytes = v.dims.reduce((p, d) => p * spec.dims[d].size, 1) * NC_TYPES[v.type].size;
        const vsize = bytes + pad4(bytes);
        parts.push(u32(vsize > 0xfffffffc ? 0xffffffff : vsize), u64(begins[i]));
      });
    } else parts.push(u32(0), u32(0));
    return Buffer.concat(parts);
  };
  const first = build(spec.vars.map(() => 0));
  let off = first.length;
  const vars = spec.vars.map(v => {
    const size = v.dims.reduce((p, d) => p * spec.dims[d].size, 1) * NC_TYPES[v.type].size;
    const out = { begin: off, size, vsize: size + pad4(size), type: v.type };
    off += out.vsize;
    return out;
  });
  vars.forEach((v, i) => { if (v.vsize > 0xfffffffc && i !== vars.length - 1) throw new Error('Only the last variable may be larger than 4 GB in a NetCDF-3 64-bit offset file.'); });
  const header = build(vars.map(v => v.begin));
  return { header, vars, total: off };
}
