// Complex numbers: which part of a complex value to show (magnitude, phase, real, imaginary, or both as a + bi),
// and how to find complex data in an HDF5 / NetCDF-4 compound type. Pure functions, used by the readers and the webview.

export const PARTS = ['complex', 'abs', 'arg', 're', 'im'];
export const PART_LABELS = { complex: 'a + bi', abs: 'Magnitude |z|', arg: 'Phase (radians)', re: 'Real part', im: 'Imaginary part' };
export const isPart = p => PARTS.includes(p);

// Member names used for complex numbers: h5py and nc-complex write {r, i}; MATLAB v7.3 writes {real, imag};
// other tools use {re, im} or {real, imaginary}.
const PAIRS = [['r', 'i'], ['re', 'im'], ['real', 'imag'], ['real', 'imaginary'], ['x', 'y']];

/**
 * h5wasm compound metadata -> { re, im, size } (member indices, bytes per number) when it is a complex number,
 * else null. Both members must be floats of the same size.
 */
export function complexMembers(m) {
  if (!m || m.type !== 6 || !m.compound_type) return null;
  const mem = m.compound_type.members || [];
  if (mem.length !== 2 || !mem.every(x => x && x.type === 1 && !(x.shape && x.shape.length) && x.size === mem[0].size)) return null;
  const names = mem.map(x => String(x.name || '').toLowerCase());
  for (const [a, b] of PAIRS.slice(0, 4)) {
    if (names[0] === a && names[1] === b) return { re: 0, im: 1, size: mem[0].size };
    if (names[0] === b && names[1] === a) return { re: 1, im: 0, size: mem[0].size };
  }
  return null;
}

const num = v => (typeof v === 'bigint' ? Number(v) : v);

/** One complex value -> the number for this part, or [re, im] for 'complex'. */
export function complexPart(re, im, part) {
  re = num(re); im = num(im);
  switch (part) {
    case 're': return re;
    case 'im': return im;
    case 'abs': return Math.hypot(re, im);
    case 'arg': return Math.atan2(im, re);
    default: return [re, im];
  }
}

/** Magnitude for the statistics of a page shown as a + bi. */
export const magnitude = v => (Array.isArray(v) ? Math.hypot(num(v[0]), num(v[1])) : v);

function fmt(x, digits) {
  if (typeof x === 'string') return x;
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : x > 0 ? 'Inf' : '-Inf';
  if (Number.isInteger(x)) return String(x);
  const a = Math.abs(x);
  if (digits && a !== 0 && (a < 1e-4 || a >= 1e7)) return x.toExponential(4);
  return digits ? String(Number(x.toPrecision(digits))) : String(x);
}

/** [re, im] -> "1.5 + 2i", "1.5 - 2i", "NaN + 0i". digits = 0 keeps full precision (exports). */
export function formatComplex(v, digits = 7) {
  if (!Array.isArray(v)) return v === null || v === undefined ? '' : String(v);
  const [re, im] = v;
  const neg = typeof im === 'number' ? im < 0 || Object.is(im, -0) : im === '-Inf';
  const imAbs = typeof im === 'number' ? Math.abs(im) : String(im).replace(/^-/, '');
  return `${fmt(re, digits)} ${neg ? '-' : '+'} ${fmt(imAbs, digits)}i`;
}
