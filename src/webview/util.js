// Pure helpers for the webview. No DOM access here, so node tests can import them.

export function fmtNum(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return '[' + v.map(fmtNum).join(', ') + ']';
  if (typeof v !== 'number') return String(v);
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e7)) return v.toExponential(4);
  return String(Number(v.toPrecision(7)));
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 2 : 1) : String(n)) + ' ' + u[i];
}

export function shapeText(shape, dims) {
  if (!shape || !shape.length) return 'scalar';
  return shape.map((n, i) => (dims && dims[i] && !/^dim_\d+$/.test(dims[i]) ? `${dims[i]}=${n}` : String(n))).join(' × ');
}

const pyStr = s => JSON.stringify(String(s));
const isIdent = s => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);

/** Python snippet that loads the same slice the user is looking at. */
export function pythonSnippet({ fileName, path, lib, shape, dims, hs }) {
  const idx = (shape || []).map((n, d) => {
    if (!hs) return ':';
    const s = hs.start[d], c = hs.count[d], st = hs.step[d];
    if (c === 1 && n > 1 && hs.single && hs.single[d]) return String(s);
    const end = s + (c - 1) * st + 1;
    if (s === 0 && end >= n && st === 1) return ':';
    return `${s}:${end}${st > 1 ? ':' + st : ''}`;
  });
  if (lib === 'h5py') {
    const sel = shape && shape.length ? `[${idx.join(', ')}]` : '[()]';
    return `import h5py\n\nwith h5py.File(${pyStr(fileName)}, "r") as f:\n    data = f[${pyStr(path)}]${sel}\n    print(data.shape, data.dtype)`;
  }
  const slash = path.lastIndexOf('/');
  const group = slash > 0 ? path.slice(0, slash) : '';
  const name = path.slice(slash + 1);
  const isel = (shape || []).map((n, d) => {
    const k = dims && dims[d] ? dims[d] : `dim_${d}`;
    const key = isIdent(k) ? k : null;
    const v = idx[d];
    if (v === ':' || !key) return null;
    return `${key}=${/:/.test(v) ? `slice(${v.split(':').map(x => x || 'None').join(', ')})` : v}`;
  }).filter(Boolean);
  const open = group ? `xr.open_dataset(${pyStr(fileName)}, group=${pyStr(group)})` : `xr.open_dataset(${pyStr(fileName)})`;
  return `import xarray as xr\n\nds = ${open}\nda = ds[${pyStr(name)}]${isel.length ? `.isel(${isel.join(', ')})` : ''}\nprint(da)`;
}

// Viridis, 9 stops (matplotlib, CC0). Interpolated linearly.
const VIRIDIS = [[68, 1, 84], [71, 44, 122], [59, 81, 139], [44, 113, 142], [33, 144, 141], [39, 173, 129], [92, 200, 99], [170, 220, 50], [253, 231, 37]];
export function viridis(t) {
  if (!(t >= 0)) t = 0; if (t > 1) t = 1;
  const x = t * (VIRIDIS.length - 1), i = Math.min(VIRIDIS.length - 2, Math.floor(x)), f = x - i;
  const a = VIRIDIS[i], b = VIRIDIS[i + 1];
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}

/** Robust color range: 2nd and 98th percentile of finite values (sampled). */
export function colorRange(values) {
  const v = [];
  const stepN = Math.max(1, Math.floor(values.length / 20000));
  for (let i = 0; i < values.length; i += stepN) { const x = values[i]; if (typeof x === 'number' && Number.isFinite(x)) v.push(x); }
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  const lo = v[Math.floor(v.length * 0.02)], hi = v[Math.min(v.length - 1, Math.floor(v.length * 0.98))];
  return lo === hi ? { lo: v[0], hi: v[v.length - 1] === v[0] ? v[0] + 1 : v[v.length - 1] } : { lo, hi };
}

/** Nice axis ticks between lo and hi. */
export function ticks(lo, hi, n = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return [lo];
  const span = hi - lo, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => span / s <= n) || mag * 10;
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(Number(t.toPrecision(12)));
  return out;
}

/** Reads the webview → host message for a view; mirrors protocol.mjs fields. */
export function readMessage(reqId, path, view, decode, purpose) {
  return { type: 'read', reqId, path, view, decode: !!decode, purpose };
}
