// Webview UI. All file content goes into the DOM as text nodes (textContent), never parsed as HTML.
import { fmtNum, fmtBytes, shapeText, pythonSnippet, COLORMAPS, isColormap, colormap, resolveRange, attrRange, rgbChannels, plotSteps } from './util.js';
import { linePlot, heatmap, heatmapPng, linePng, rgbImage } from './plot.js';
import { seriesCsv } from '../core/export.mjs';
import { seriesTitle } from '../core/series.mjs';
import { geoKind, coastlineCells } from './map.js';
import { PART_LABELS, formatComplex } from '../core/complex.mjs';

const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
const PAGE_ROWS = 100, PAGE_COLS = 30, PLOT_MAX = 512, LINE_MAX = 4000;

let reqSeq = 1;
const pending = new Map();
function request(type, path, extra = {}) {
  const reqId = reqSeq++;
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    vscode.postMessage({ type, reqId, path, ...extra });
  });
}

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

const state = { init: null, selected: null, info: null, view: null, tab: 'table', decode: true, part: 'complex', coordCache: new Map(), tree: new Map(), filter: '', plot: null, seriesAt: null, seriesAxis: null, closeSeries: null };

// Plot choices (colour map, reverse, range mode, custom ranges per variable, log) live in the webview state,
// so they come back when this file's tab is shown again. The colour map starts from the setting.
// Play along a dimension: milliseconds per step (a step never starts before the last one is drawn).
const PLAY_SPEEDS = [[1000, '0.5×'], [500, '1×'], [250, '2×'], [0, 'Max']];
const RANGE_MODES = [['minmax', 'Min to max'], ['p2_98', '2-98 percentile'], ['symmetric', 'Symmetric around 0'], ['attrs', 'From attributes'], ['custom', 'Custom']];
function loadPlotPrefs(ui) {
  const saved = (vscode.getState() || {}).plot || {};
  const dflt = ui && isColormap(ui.colormap) ? ui.colormap : 'viridis';
  state.plot = {
    cmap: isColormap(saved.cmap) ? saved.cmap : dflt,
    reverse: saved.reverse === true,
    range: RANGE_MODES.some(m => m[0] === saved.range) ? saved.range : 'p2_98',
    log: saved.log === true,
    custom: saved.custom && typeof saved.custom === 'object' ? saved.custom : {},
    coast: saved.coast !== false,
    rgb: saved.rgb !== false,
    speed: PLAY_SPEEDS.some(x => x[0] === saved.speed) ? saved.speed : 500,
  };
}
const savePlotPrefs = () => vscode.setState({ ...(vscode.getState() || {}), plot: state.plot });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (state.play) { stopPlay(); return; }
  if (state.closeSeries) state.closeSeries();
});

window.addEventListener('message', ev => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'init') { state.init = m; loadPlotPrefs(m.ui); render(); return; }
  if (m.type === 'reload') { state.coordCache.clear(); state.tree.clear(); render(); return; }
  if (m.type === 'result') {
    const p = pending.get(m.reqId); if (!p) return;
    pending.delete(m.reqId);
    m.ok ? p.resolve(m.data) : p.reject(new Error(m.error || 'error'));
  }
});

function render() {
  app.replaceChildren();
  const i = state.init;
  if (i.error) {
    app.append(el('div', { class: 'fatal' }, el('h2', { text: 'Cannot open ' + i.fileName }), el('p', { text: i.error }),
      el('p', null, el('button', { class: 'secondary', id: 'open-as-text', onclick: () => vscode.postMessage({ type: 'openAsText' }) }, 'Open as text'))));
    return;
  }
  const search = el('input', { type: 'search', placeholder: 'Filter variables', 'aria-label': 'Filter variables', oninput: e => { state.filter = e.target.value.toLowerCase(); drawTree(); } });
  const header = el('header', null,
    el('span', { class: 'fname', text: i.fileName }),
    el('span', { class: 'badge', text: i.label }),
    el('span', { class: 'muted', text: fmtBytes(i.size) }),
    el('span', { class: 'grow' }), search);
  const tree = el('nav', { id: 'tree', 'aria-label': 'File structure' });
  const detail = el('section', { id: 'detail' });
  app.append(header, el('div', { class: 'main' }, tree, detail));
  loadGroup('/').then(() => { drawTree(); select('/'); });
}

async function loadGroup(path) {
  if (state.tree.has(path)) return state.tree.get(path);
  const node = { loading: true, items: [], open: true };
  state.tree.set(path, node);
  try { const r = await request('list', path); node.items = r.items; node.more = r.more; } catch (e) { node.error = e.message; }
  node.loading = false;
  return node;
}

function drawTree() {
  const tree = document.getElementById('tree'); if (!tree) return;
  const root = el('ul', { role: 'tree' });
  root.append(el('li', { class: 'node group' + (state.selected === '/' ? ' sel' : ''), role: 'treeitem', tabindex: 0, onclick: () => select('/'), text: '/ (file)' }));
  const add = (path, ul, depth) => {
    const n = state.tree.get(path); if (!n) return;
    if (n.error) ul.append(el('li', { class: 'err', text: n.error }));
    for (const it of n.items) {
      const match = !state.filter || it.name.toLowerCase().includes(state.filter) || (it.longName || '').toLowerCase().includes(state.filter);
      const li = el('li', { class: `node ${it.kind}` + (state.selected === it.path ? ' sel' : ''), role: 'treeitem', tabindex: 0, title: it.path });
      li.style.paddingLeft = (8 + depth * 14) + 'px';
      if (it.kind === 'group') {
        const sub = state.tree.get(it.path);
        li.append(el('span', { class: 'twisty', text: sub && sub.open ? '▾' : '▸' }), el('span', { text: it.name }), el('span', { class: 'muted', text: ` ${it.matlab || it.children}` }));
        li.addEventListener('click', async () => {
          const s = state.tree.get(it.path);
          if (s) s.open = !s.open; else await loadGroup(it.path);
          drawTree(); select(it.path);
        });
        if (match || state.filter) ul.append(li);
        if (sub && sub.open) add(it.path, ul, depth + 1);
        continue;
      }
      if (!match) continue;
      const icon = it.kind === 'dataset' ? (it.isCoord ? '⌖' : '▦') : it.kind === 'dimension' ? '↔' : it.kind === 'external' ? '↗' : '•';
      li.append(el('span', { class: 'icon', text: icon }), el('span', { text: it.name }), el('span', { class: 'muted', text: ' ' + (it.kind === 'dataset' ? `${it.dtype} ${shapeText(it.shape, null)}` : it.kind === 'external' || (it.kind === 'other' && it.target) ? it.target : it.kind === 'error' ? 'cannot read' : it.kind) }));
      li.addEventListener('click', () => select(it.path));
      li.addEventListener('keydown', e => { if (e.key === 'Enter') select(it.path); });
      ul.append(li);
    }
    if (n.more) ul.append(el('li', { class: 'muted', text: `${n.more} more items not shown` }));
  };
  add('/', root, 1);
  tree.replaceChildren(root);
}

function kv(rows) {
  const t = el('table', { class: 'kv' });
  for (const [k, v] of rows) if (v !== undefined && v !== null && v !== '') t.append(el('tr', null, el('th', { text: k }), el('td', null, v instanceof Node ? v : String(v))));
  return t;
}

function attrTable(attrs, showInternal) {
  const list = attrs.filter(a => showInternal || !a.internal);
  if (!list.length) return el('p', { class: 'muted', text: 'No attributes.' });
  const t = el('table', { class: 'grid attrs' }, el('thead', null, el('tr', null, el('th', { text: 'Name' }), el('th', { text: 'Value' }), el('th', { text: 'Type' }))));
  const tb = el('tbody');
  for (const a of list) {
    const v = a.value && a.value.truncated ? fmtNum(a.value.items) + ` … (${a.value.truncated} items)` : fmtNum(a.value);
    tb.append(el('tr', null, el('td', { class: 'mono', text: a.name }), el('td', { class: 'mono wrap', text: v }), el('td', { class: 'muted', text: a.dtype || '' })));
  }
  t.append(tb);
  return t;
}

async function select(path) {
  stopPlay();
  state.selected = path; drawTree();
  const detail = document.getElementById('detail');
  detail.replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
  let info;
  try { info = await request('info', path); } catch (e) { detail.replaceChildren(el('p', { class: 'err', text: e.message })); return; }
  if (state.selected !== path) return;
  state.info = info;
  if (info.kind === 'group') return showGroup(info, detail);
  if (info.kind !== 'dataset') { detail.replaceChildren(el('h2', { text: info.name }), kv([['Path', info.path], ['Kind', info.kind]]), attrTable(info.attrs, true)); return; }
  const nd = info.shape.length;
  state.view = { rowAxis: 0, colAxis: nd > 1 ? nd - 1 : -1, index: new Array(nd).fill(0), rowStart: 0, colStart: 0 };
  if (nd >= 2) {
    // Show the last two dims (lat x lon for most climate data) and fix the others at 0. Dimensions of length 1
    // are skipped: a buoy or station series stored as (time, lat=1, lon=1) shows as a line along time.
    const long = info.shape.map((n, d) => d).filter(d => info.shape[d] > 1);
    // MATLAB arrays: rows x columns of the first page, the way MATLAB shows A(:, :, k).
    if (long.length >= 2 && info.colMajor) { state.view.rowAxis = long[0]; state.view.colAxis = long[1]; }
    else if (long.length >= 2) { state.view.rowAxis = long[long.length - 2]; state.view.colAxis = long[long.length - 1]; }
    else if (long.length === 1) { state.view.rowAxis = long[0]; state.view.colAxis = -1; }
    else { state.view.rowAxis = nd - 2; state.view.colAxis = nd - 1; }
  }
  // An RGB image (height, width, 3 or 4) shows height x width, with the channels together.
  if (rgbChannels(info)) { state.view.rowAxis = 0; state.view.colAxis = 1; }
  state.tab = info.compound || !info.numeric || nd === 0 ? 'table' : (nd >= 2 ? 'plot' : state.tab);
  showDataset(info, detail);
}

function showGroup(info, detail) {
  const n = state.tree.get(info.path);
  const kids = el('div');
  detail.replaceChildren(
    el('h2', { text: info.path === '/' ? (state.init.fileName) : info.name }),
    kv([['Format', info.format], ['Path', info.path], ['MATLAB', info.matlab], ['Items', info.children]]),
    info.warning ? el('p', { class: 'err', text: info.warning }) : '',
    info.dimensions ? el('div', null, el('h3', { text: 'Dimensions' }), kv(info.dimensions.map(d => [d.name, d.size + (d.unlimited ? ' (unlimited)' : '')]))) : '',
    el('h3', { text: info.path === '/' ? 'Global attributes' : 'Attributes' }), attrTable(info.attrs, false), kids);
  const items = (n && n.items) || [];
  const vars = items.filter(i => i.kind === 'dataset');
  if (vars.length) {
    const t = el('table', { class: 'grid' }, el('thead', null, el('tr', null, ...['Variable', 'Dimensions', 'Type', 'Units', 'Long name'].map(h => el('th', { text: h })))));
    const tb = el('tbody');
    for (const v of vars) tb.append(el('tr', { class: 'click', onclick: () => select(v.path) }, el('td', { class: 'mono', text: v.name }), el('td', { text: shapeText(v.shape, v.dims) }), el('td', { text: v.dtype }), el('td', { text: v.units || '' }), el('td', { text: v.longName || '' })));
    t.append(tb);
    kids.append(el('h3', { text: 'Variables' }), t);
  }
}

async function coordValues(path, len) {
  if (!path || len > 200000) return null;
  if (state.coordCache.has(path)) return state.coordCache.get(path);
  const p = request('read', path, { view: { rowAxis: 0, colAxis: -1, rowStart: 0, rowCount: len, index: [] }, decode: true, purpose: 'table' })
    .then(r => ({ values: r.values.map(x => x[0]), times: r.times ? r.times.map(x => x[0]) : null }), () => null);
  state.coordCache.set(path, p);
  return p;
}
/** CF units and standard_name of a coordinate variable (to tell latitude and longitude apart from other axes). */
function coordMeta(path) {
  if (!path) return Promise.resolve(null);
  const key = 'meta:' + path;
  if (!state.coordCache.has(key)) state.coordCache.set(key, request('info', path).then(i => i.cf || {}, () => null));
  return state.coordCache.get(key);
}

/** Coastline overlay for a heatmap whose rows and columns are latitude and longitude, or null. */
async function geoOverlay(info, v, r, rc, cc) {
  if (!rc || !cc || rc.times || cc.times) return null;
  const rp = info.coords && info.coords[v.rowAxis], cp = info.coords && info.coords[v.colAxis];
  const [rm, cm] = await Promise.all([coordMeta(rp), coordMeta(cp)]);
  const kind = (d, p, m) => geoKind(info.dims[d], m) || (p ? geoKind(p.split('/').pop(), m) : null);
  const rk = kind(v.rowAxis, rp, rm), ck = kind(v.colAxis, cp, cm);
  if (!rk || !ck || rk === ck) return null;
  const at = (c, axis, count) => Array.from({ length: count }, (_, i) => c.values[r.start[axis] + i * r.step[axis]]);
  return coastlineCells(rk, ck, at(rc, v.rowAxis, r.rows), at(cc, v.colAxis, r.cols));
}
const coordLabel = (c, i) => c ? (c.times && c.times[i] != null ? c.times[i] : fmtNum(c.values[i])) : String(i);

function compression(info) {
  if (!info.filters || !info.filters.length) return info.chunks ? 'none' : 'none (contiguous)';
  return info.filters.map(f => f.name + (f.level !== undefined ? ` level ${f.level}` : '')).join(' + ');
}

function packingText(p) {
  if (!p) return undefined;
  const bits = [];
  if (p.scale !== undefined) bits.push(`scale_factor ${fmtNum(p.scale)}`);
  if (p.offset !== undefined) bits.push(`add_offset ${fmtNum(p.offset)}`);
  if (p.fill.length) bits.push(`_FillValue ${p.fill.map(fmtNum).join(', ')}`);
  if (p.missing.length) bits.push(`missing_value ${p.missing.map(fmtNum).join(', ')}`);
  if (p.validMin !== undefined || p.validMax !== undefined) bits.push(`valid ${fmtNum(p.validMin)}..${fmtNum(p.validMax)}`);
  return bits.join(', ');
}

function showDataset(info, detail) {
  stopPlay();
  const cf = info.cf || {};
  const nd = info.shape.length;
  const lib = /^matv/.test(state.init.format) ? 'scipy' : state.init.format === 'netcdf3' || /NetCDF/.test(state.init.label) ? 'xarray' : 'h5py';
  const copyBtn = (label, fn) => el('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'copy', text: fn() }) }, label);
  const coordsText = (info.coords || []).map((c, i) => c ? `${info.dims[i]} → ${c}` : null).filter(Boolean).join(', ');
  const head = el('div', { class: 'dhead' },
    el('h2', null, el('span', { class: 'mono', text: info.name }), cf.long_name ? el('span', { class: 'muted', text: '  ' + cf.long_name }) : null),
    el('div', { class: 'actions' },
      copyBtn('Copy path', () => info.path),
      copyBtn(lib === 'xarray' ? 'Copy xarray code' : lib === 'scipy' ? 'Copy SciPy code' : 'Copy h5py code', () => pythonSnippet({ fileName: state.init.fileName, path: info.path, lib, shape: info.shape, dims: info.dims, hs: state.lastHs, colMajor: info.colMajor })),
      exportButton(info)));
  const meta = kv([
    ['Path', info.path], ['Type', info.dtype], ['Shape', shapeText(info.shape, info.dims)],
    ['Units', cf.units], ['Standard name', cf.standard_name], ['Calendar', cf.time ? cf.calendar || 'standard' : undefined],
    ['Packing', packingText(cf.packing)], ['Coordinates', coordsText || cf.coordinates],
    ['Chunks', info.chunks ? info.chunks.join(' × ') : undefined], ['Compression', compression(info)],
    ['Size in memory', fmtBytes(info.bytes)], ['Max shape', info.maxshape && info.maxshape.some((m, i) => m !== info.shape[i]) ? info.maxshape.map(m => (m === null || m < 0 || m >= 2 ** 53 ? '∞' : m)).join(' × ') : undefined],
  ]);
  const controls = el('div', { class: 'controls' });
  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  const body = el('div', { class: 'tabbody' });
  const statsBar = el('div', { class: 'stats mono' });
  for (const [id, label] of [['table', 'Table'], ['plot', 'Plot'], ['attrs', `Attributes (${info.attrs.filter(a => !a.internal).length})`]]) {
    if (id === 'plot' && (!info.numeric || info.compound || nd === 0)) continue;
    tabs.append(el('button', { role: 'tab', class: 'tab' + (state.tab === id ? ' on' : ''), 'aria-selected': state.tab === id ? 'true' : 'false', onclick: () => { state.tab = id; showDataset(info, detail); } }, label));
  }
  detail.replaceChildren(head, meta, controls, tabs, body, statsBar);
  buildControls(info, controls, () => drawTab(info, body, statsBar));
  drawTab(info, body, statsBar);
}

// Export slice: the host reads every row and column of the two chosen dimensions (the sliders fix the rest)
// and writes CSV or JSON to the file picked in the save dialog.
function exportButton(info) {
  const note = el('span', { class: 'muted export-note', role: 'status' });
  const btn = el('button', { class: 'secondary', title: 'Save every value of this slice as CSV or JSON', onclick: async () => {
    const v = state.view || { rowAxis: 0, colAxis: -1, index: [] };
    btn.disabled = true; note.className = 'muted export-note'; note.textContent = 'Exporting…';
    try {
      const r = await request('export', info.path, { view: { rowAxis: v.rowAxis, colAxis: v.colAxis, index: v.index.slice() }, decode: state.decode, ...(info.complex ? { part: state.part } : {}) });
      note.textContent = r.cancelled ? '' : `Saved ${exportedName(r.file)} (${r.rows} × ${r.cols} values)`;
    } catch (e) {
      note.className = 'err export-note'; note.textContent = e.message;
    } finally { btn.disabled = false; }
  } }, 'Export slice…');
  return el('span', { class: 'export' }, btn, note);
}
const exportedName = f => String(f || '').split(/[\\/]/).pop();

/** Part of a complex value for this tab: a + bi only in the table; plots and series use the magnitude instead. */
const partFor = (info, purpose) => (!info.complex ? undefined : purpose === 'table' ? state.part : state.part === 'complex' ? 'abs' : state.part);

function buildControls(info, box, redraw) {
  const nd = info.shape.length, v = state.view;
  if (info.complex) {
    const sel = el('select', { id: 'complex-part', 'aria-label': 'Complex values' });
    const cur = partFor(info, state.tab === 'plot' ? 'plot' : 'table');
    for (const [k, label] of Object.entries(PART_LABELS)) {
      if (k === 'complex' && state.tab === 'plot') continue;
      sel.append(el('option', { value: k, selected: cur === k, text: label }));
    }
    sel.addEventListener('change', () => { state.part = sel.value; redraw(); });
    box.append(el('label', { class: 'ctl', title: 'Complex numbers: show a + bi, the magnitude, the phase, or the real or imaginary part' }, 'Complex ', sel));
  }
  if (info.numeric && (info.cf && info.cf.packing || info.cf && info.cf.time)) {
    const cb = el('input', { type: 'checkbox', id: 'dec', checked: state.decode, onchange: e => { state.decode = e.target.checked; redraw(); } });
    box.append(el('label', { class: 'chk' }, cb, ' Apply CF decoding (scale, offset, fill, time)'));
  }
  if (nd < 2) return;
  let sliders = 0;
  const axisSel = (which) => {
    const s = el('select', { 'aria-label': which === 'rowAxis' ? 'Row dimension' : 'Column dimension', onchange: e => {
      stopPlay();
      const a = Number(e.target.value), other = which === 'rowAxis' ? 'colAxis' : 'rowAxis';
      if (a === v[other]) v[other] = v[which];
      if (v.rowAxis === -1) v.rowAxis = info.dims.findIndex((_, d) => d !== a);
      v[which] = a; v.rowStart = 0; v.colStart = 0;
      box.replaceChildren(); buildControls(info, box, redraw); redraw();
    } });
    info.dims.forEach((d, i) => s.append(el('option', { value: i, selected: v[which] === i, text: `${d} (${info.shape[i]})` })));
    if (which === 'colAxis') s.append(el('option', { value: -1, selected: v.colAxis === -1, text: 'none (line plot)' }));
    return s;
  };
  box.append(el('span', { class: 'ctl' }, 'Rows ', axisSel('rowAxis')), el('span', { class: 'ctl' }, 'Columns ', axisSel('colAxis')));
  for (let d = 0; d < nd; d++) {
    if (d === v.rowAxis || d === v.colAxis) continue;
    const n = info.shape[d];
    const lab = el('span', { class: 'mono coord' });
    const setLab = async () => { const c = await coordValues(info.coords && info.coords[d], n); lab.textContent = coordLabel(c, v.index[d]); };
    const num = el('input', { type: 'number', min: 0, max: n - 1, value: v.index[d], 'aria-label': info.dims[d] + ' index' });
    const range = el('input', { type: 'range', min: 0, max: Math.max(0, n - 1), value: v.index[d], 'aria-label': info.dims[d] });
    let t;
    const show = x => { v.index[d] = Math.max(0, Math.min(n - 1, Math.trunc(Number(x) || 0))); num.value = v.index[d]; range.value = v.index[d]; setLab(); };
    const set = x => { stopPlay(); show(x); clearTimeout(t); t = setTimeout(redraw, 120); };
    range.addEventListener('input', e => set(e.target.value));
    num.addEventListener('change', e => set(e.target.value));
    const play = el('button', { class: 'secondary play', id: `play-${d}`, 'aria-label': `Play along ${info.dims[d]}`, 'aria-pressed': 'false', title: `Play along ${info.dims[d]} (Escape stops)`, disabled: n < 2 }, '▶');
    play.addEventListener('click', () => (state.play && state.play.d === d ? stopPlay() : startPlay(d, n, show, play, redraw)));
    box.append(el('span', { class: 'ctl slider' }, `${info.dims[d]} `, play, range, num, lab));
    setLab();
    sliders++;
  }
  if (sliders) {
    const speed = el('select', { id: 'play-speed', 'aria-label': 'Play speed' });
    for (const [ms, label] of PLAY_SPEEDS) speed.append(el('option', { value: ms, selected: state.plot.speed === ms, text: label }));
    speed.addEventListener('change', () => { state.plot.speed = Number(speed.value); savePlotPrefs(); });
    box.append(el('label', { class: 'ctl' }, 'Speed ', speed));
  }
}

/**
 * Steps one dimension forward (wrapping to 0 at the end) and redraws, until stopped. The next step starts only
 * when the last one is drawn. While it plays the colour range stays at the first frame's range, so frames compare.
 */
async function startPlay(d, n, show, btn, redraw) {
  stopPlay();
  const v = state.view;
  const play = { d, btn, stopped: false, range: null, path: state.info && state.info.path };
  state.play = play;
  btn.textContent = '⏸'; btn.setAttribute('aria-pressed', 'true'); btn.setAttribute('aria-label', 'Pause');
  while (!play.stopped && state.view === v) {
    const t0 = performance.now();
    show((v.index[d] + 1) % n);
    const ok = await redraw();
    if (ok === false) break;
    const wait = state.plot.speed - (performance.now() - t0);
    await new Promise(res => setTimeout(res, Math.max(wait, 16)));
  }
  if (state.play === play) stopPlay();
}

function stopPlay() {
  const p = state.play;
  if (!p) return;
  p.stopped = true; state.play = null;
  p.btn.textContent = '▶'; p.btn.setAttribute('aria-pressed', 'false'); p.btn.setAttribute('aria-label', 'Play');
}

function showStats(bar, r, note) {
  const s = r.stats;
  if (!s) { bar.textContent = ''; return; }
  const parts = s.count ? [`min ${fmtNum(s.min)}`, `max ${fmtNum(s.max)}`, `mean ${fmtNum(s.mean)}`, `std ${fmtNum(s.std)}`] : ['no finite values'];
  if (r.statsOf === 'abs') parts.unshift('of |z|:');
  if (s.fill) parts.push(`fill/missing ${s.fill}`);
  if (s.nan) parts.push(`NaN ${s.nan}`);
  if (s.inf) parts.push(`Inf ${s.inf}`);
  bar.textContent = parts.join('  ·  ') + (note ? '  ·  ' + note : '');
}

async function drawTab(info, body, bar) {
  const token = {}; state.drawToken = token;
  if (state.tab === 'attrs') {
    let showInt = false;
    const wrap = el('div');
    const draw = () => wrap.replaceChildren(attrTable(info.attrs, showInt));
    const internal = info.attrs.filter(a => a.internal).length;
    body.replaceChildren(internal ? el('label', { class: 'chk' }, el('input', { type: 'checkbox', onchange: e => { showInt = e.target.checked; draw(); } }), ` Show ${internal} internal HDF5/NetCDF attributes`) : '', wrap);
    draw(); bar.textContent = '';
    return;
  }
  const nd = info.shape.length, v = state.view;
  // While playing, the last frame stays on screen until the next one is drawn (no flicker).
  if (!state.play) body.replaceChildren(el('p', { class: 'muted', text: 'Reading…' }));
  const t0 = performance.now();
  try {
    if (state.tab === 'plot') { await drawPlot(info, body, bar, token, t0); return true; }
    const view = { ...v, rowCount: PAGE_ROWS, colCount: v.colAxis >= 0 ? PAGE_COLS : 1 };
    const r = await request('read', info.path, { view, decode: state.decode, purpose: 'table', ...(info.complex ? { part: partFor(info, 'table') } : {}) });
    if (state.drawToken !== token) return;
    state.lastHs = { ...r, single: info.shape.map((_, d) => d !== v.rowAxis && d !== v.colAxis) };
    const rowsTotal = nd ? info.shape[v.rowAxis] : 1, colsTotal = v.colAxis >= 0 ? info.shape[v.colAxis] : 1;
    const [rc, cc] = nd ? await Promise.all([coordValues(info.coords && info.coords[v.rowAxis], rowsTotal), v.colAxis >= 0 ? coordValues(info.coords && info.coords[v.colAxis], colsTotal) : null]) : [null, null];
    const t = el('table', { class: 'grid data' });
    const hr = el('tr', null, el('th', { class: 'corner', text: nd ? info.dims[v.rowAxis] : '' }));
    const r0 = nd ? r.start[v.rowAxis] : 0, c0 = v.colAxis >= 0 ? r.start[v.colAxis] : 0;
    if (info.compound) for (const name of info.compound) hr.append(el('th', { text: name }));
    else if (v.colAxis >= 0) for (let c = 0; c < r.cols; c++) hr.append(el('th', { title: `${info.dims[v.colAxis]}[${c0 + c}]`, text: coordLabel(cc, c0 + c) }));
    else hr.append(el('th', { text: cf(info) }));
    const tb = el('tbody');
    for (let i = 0; i < r.rows; i++) {
      const tr = el('tr', null, el('th', { title: nd ? `${info.dims[v.rowAxis]}[${r0 + i}]` : '', text: nd ? coordLabel(rc, r0 + i) : '' }));
      const row = r.values[i];
      if (info.compound) for (const x of row[0]) tr.append(el('td', { text: fmtNum(x) }));
      else for (let c = 0; c < row.length; c++) {
        const val = row[c];
        const txt = r.times && r.times[i][c] ? r.times[i][c] : Array.isArray(val) && info.complex ? formatComplex(val) : fmtNum(val);
        tr.append(el('td', { class: val === null ? 'fill' : typeof val === 'string' && !r.times ? (val.length > 80 ? 'str long' : 'str') : '', title: r.times ? fmtNum(val) : undefined, text: txt }));
      }
      tb.append(tr);
    }
    t.append(el('thead', null, hr), tb);
    const pager = el('div', { class: 'pager' });
    const nav = (label, cond, fn) => el('button', { class: 'secondary', disabled: !cond, onclick: () => { fn(); drawTab(info, body, bar); } }, label);
    if (nd) pager.append(nav('◀ Rows', v.rowStart > 0, () => { v.rowStart = Math.max(0, v.rowStart - PAGE_ROWS); }), el('span', { class: 'muted', text: ` ${info.dims[v.rowAxis]} ${r0}–${r0 + r.rows - 1} of ${rowsTotal} ` }), nav('Rows ▶', r0 + r.rows < rowsTotal, () => { v.rowStart += PAGE_ROWS; }));
    if (v.colAxis >= 0) pager.append(el('span', { class: 'gap' }), nav('◀ Columns', v.colStart > 0, () => { v.colStart = Math.max(0, v.colStart - PAGE_COLS); }), el('span', { class: 'muted', text: ` ${info.dims[v.colAxis]} ${c0}–${c0 + r.cols - 1} of ${colsTotal} ` }), nav('Columns ▶', c0 + r.cols < colsTotal, () => { v.colStart += PAGE_COLS; }));
    body.replaceChildren(pager, el('div', { class: 'tablewrap' }, t));
    showStats(bar, r, `this page, ${Math.round(performance.now() - t0)} ms`);
    return true;
  } catch (e) {
    if (state.drawToken !== token) return false;
    body.replaceChildren(el('p', { class: 'err', text: e.message }));
    bar.textContent = '';
    return false;
  }
}
const cf = info => (info.cf && info.cf.units ? `${info.name} (${info.cf.units})` : info.name);
const safeName = s => String(s).replace(/[^A-Za-z0-9_.-]+/g, '_');

/** Asks the host to save a picture; the note shows the result. */
async function savePng(dataUrl, name, note) {
  note.className = 'muted note'; note.textContent = 'Saving…';
  try {
    const r = await request('savePng', undefined, { dataUrl, name });
    note.textContent = r.cancelled ? '' : `Saved ${exportedName(r.file)}`;
  } catch (e) { note.className = 'err note'; note.textContent = e.message; }
}

function pngOf(draw, name, note) {
  let url;
  try { url = draw(); } catch (e) { note.className = 'err note'; note.textContent = 'Could not draw the picture: ' + e.message; return; }
  return savePng(url, name, note);
}

/** "time = 2024-12-04 06:00" for every dimension fixed by a slider. */
async function fixedText(info, v) {
  const parts = [], nameBits = [];
  for (let d = 0; d < info.shape.length; d++) {
    if (d === v.rowAxis || d === v.colAxis) continue;
    const c = await coordValues(info.coords && info.coords[d], info.shape[d]);
    parts.push(`${info.dims[d]} = ${coordLabel(c, v.index[d])}`);
    nameBits.push(`${info.dims[d]}${v.index[d]}`);
  }
  return { text: parts.join(', '), name: nameBits.join('-') };
}

async function drawPlot(info, body, bar, token, t0) {
  const nd = info.shape.length, v = state.view;
  const rows = info.shape[v.rowAxis], cols = v.colAxis >= 0 ? info.shape[v.colAxis] : 1;
  const line = nd === 1 || v.colAxis < 0, ax = v.rowAxis;
  const view = line
    ? { ...v, rowStart: 0, rowCount: rows, rowStep: Math.ceil(rows / LINE_MAX), colAxis: -1 }
    : { ...v, rowStart: 0, colStart: 0, rowCount: rows, colCount: cols, ...plotSteps(rows, cols, PLOT_MAX) };
  const r = await request('read', info.path, { view, decode: state.decode, purpose: 'plot', ...(info.complex ? { part: partFor(info, 'plot') } : {}) });
  if (state.drawToken !== token) return;
  state.lastHs = { ...r, single: info.shape.map((_, d) => d !== v.rowAxis && d !== v.colAxis) };
  const canvas = el('canvas', { class: 'plot', id: line ? 'line-canvas' : 'heatmap-canvas', role: 'img', 'aria-label': `Plot of ${info.name}` });
  const hover = el('div', { class: 'hover mono', id: 'plot-readout', role: 'status' });
  const note = el('span', { class: 'muted note', id: 'plot-note', role: 'status' });
  const tools = el('div', { class: 'plotbar', id: 'plot-controls' });
  const width = Math.max(320, Math.min(1000, body.clientWidth - 8));
  const units = info.complex ? PART_LABELS[partFor(info, 'plot')] : info.cf && info.cf.units;
  const sampled = r.step.some(s => s > 1) ? `sampled every ${r.step.filter(s => s > 1).join('×')}` : 'all values';
  state.closeSeries = null;
  if (line) {
    body.replaceChildren(tools, canvas, hover);
    const c = await coordValues(info.coords && info.coords[ax], rows);
    if (state.drawToken !== token) return;
    const idx = r.values.map((_, i) => r.start[ax] + i * r.step[ax]);
    const xs = c ? idx.map(i => (c.times ? (c.times[i] != null ? c.times[i] : i) : c.values[i])) : idx;
    const ys = r.values.map(x => x[0]);
    const p = linePlot(canvas, xs, ys, { width, xLabel: info.dims[ax], yLabel: units });
    if (p) canvas.addEventListener('mousemove', e => { const i = p.hit(e.offsetX); if (i === null) return; hover.textContent = `${info.dims[ax]}=${coordLabel(c, idx[i])}  value=${fmtNum(ys[i])}`; });
    tools.append(el('button', { class: 'secondary', id: 'plot-save-png', title: 'Save this plot as a PNG picture', onclick: () => pngOf(() => linePng(xs, ys, { title: cf(info), xLabel: info.dims[ax], yLabel: units }), `${safeName(info.name)}.png`, note) }, 'Save PNG'), note);
    showStats(bar, r, `${sampled}, ${Math.round(performance.now() - t0)} ms`);
    return;
  }
  const k = rgbChannels(info);
  const rgbOn = k && v.rowAxis === 0 && v.colAxis === 1;
  if (rgbOn) {
    const rgbBox = el('input', { type: 'checkbox', id: 'plot-rgb', checked: state.plot.rgb });
    rgbBox.addEventListener('change', () => { state.plot.rgb = rgbBox.checked; savePlotPrefs(); drawTab(info, body, bar); });
    tools.append(el('label', { class: 'chk', title: 'Show the 3 or 4 channels together as one picture' }, rgbBox, ` RGB${k === 4 ? 'A' : ''} image`));
  }
  if (rgbOn && state.plot.rgb) {
    // One read per channel, same rows, columns and sampling as the heatmap.
    const chans = await Promise.all(Array.from({ length: k }, (_, c) => {
      const index = v.index.slice(); index[2] = c;
      return c === v.index[2] ? Promise.resolve(r) : request('read', info.path, { view: { ...view, index }, decode: false, purpose: 'plot', ...(info.complex ? { part: partFor(info, 'plot') } : {}) });
    }));
    if (state.drawToken !== token) return;
    canvas.id = 'rgb-canvas';
    body.replaceChildren(tools, canvas, hover);
    const pic = rgbImage(canvas, chans.map(c => c.values), { width });
    canvas.dataset.cellSize = String(pic.scale);
    const saveRgb = el('button', { class: 'secondary', id: 'plot-save-png', title: 'Save the picture as PNG, one pixel per value shown' }, 'Save PNG');
    saveRgb.addEventListener('click', () => savePng(pic.pngUrl(), `${safeName(info.name)}.png`, note));
    tools.append(saveRgb, note);
    canvas.addEventListener('mousemove', e => {
      const h = pic.hit(e.offsetX, e.offsetY); if (!h) return;
      const ri = r.start[0] + h.r * r.step[0], ci = r.start[1] + h.c * r.step[1];
      hover.textContent = `${info.dims[0]}=${ri}  ${info.dims[1]}=${ci}  ${['R', 'G', 'B', 'A'].slice(0, k).map((ch, c) => `${ch}=${fmtNum(chans[c].values[h.r][h.c])}`).join(' ')}`;
    });
    showStats(bar, r, `RGB${k === 4 ? 'A' : ''} picture, ${sampled}, ${Math.round(performance.now() - t0)} ms`);
    return;
  }
  const seriesBox = el('div', { class: 'series', id: 'series', hidden: true });
  body.replaceChildren(tools, canvas, hover, seriesBox);
  const [rc, cc] = await Promise.all([coordValues(info.coords && info.coords[v.rowAxis], rows), coordValues(info.coords && info.coords[v.colAxis], cols)]);
  if (state.drawToken !== token) return;
  const geo = await geoOverlay(info, v, r, rc, cc).catch(() => null);
  if (state.drawToken !== token) return;
  const flat = []; for (const row of r.values) for (const x of row) flat.push(x);
  const P = state.plot;
  const fromAttrs = attrRange(info.attrs, { decoded: r.decoded });
  // Controls: colour map, reverse, range mode (+ custom min/max), log scale, Save PNG.
  const cmapSel = el('select', { id: 'plot-cmap', 'aria-label': 'Colour map' });
  for (const [k, label] of COLORMAPS) cmapSel.append(el('option', { value: k, selected: P.cmap === k, text: label }));
  const rev = el('input', { type: 'checkbox', id: 'plot-reverse', checked: P.reverse });
  const rangeSel = el('select', { id: 'plot-range', 'aria-label': 'Colour range' });
  const mode = () => (P.range === 'attrs' && !fromAttrs ? 'p2_98' : P.range);
  for (const [k, label] of RANGE_MODES) {
    if (k === 'attrs' && !fromAttrs) continue;
    rangeSel.append(el('option', { value: k, selected: mode() === k, text: k === 'attrs' ? `${label} (${fromAttrs.source})` : label }));
  }
  const custom = () => P.custom[info.path] || {};
  const minIn = el('input', { type: 'number', step: 'any', id: 'plot-min', 'aria-label': 'Colour range min', value: custom().min ?? '' });
  const maxIn = el('input', { type: 'number', step: 'any', id: 'plot-max', 'aria-label': 'Colour range max', value: custom().max ?? '' });
  const customBox = el('span', { class: 'ctl', id: 'plot-custom' }, 'min ', minIn, ' max ', maxIn);
  const logBox = el('input', { type: 'checkbox', id: 'plot-log' });
  const coastBox = geo ? el('input', { type: 'checkbox', id: 'plot-coast', checked: P.coast }) : null;
  const saveBtn = el('button', { class: 'secondary', id: 'plot-save-png', title: 'Save this heatmap with its title, axes and colour bar as a PNG picture' }, 'Save PNG');
  tools.append(
    el('label', { class: 'ctl' }, 'Colour map ', cmapSel),
    el('label', { class: 'chk' }, rev, ' Reverse'),
    el('label', { class: 'ctl' }, 'Range ', rangeSel), customBox,
    el('label', { class: 'chk' }, logBox, ' Log scale'),
    ...(coastBox ? [el('label', { class: 'chk', title: 'Natural Earth 1:110m coastlines on latitude-longitude grids' }, coastBox, ' Coastlines')] : []),
    saveBtn, note);
  const lines = () => (geo && P.coast ? geo.lines : null);
  const flipY = !!(geo && geo.northUp);
  let p = null, rr = null;
  const paint = () => {
    customBox.hidden = mode() !== 'custom';
    rr = resolveRange(flat, { mode: mode(), custom: custom(), attrs: info.attrs, decoded: r.decoded, log: P.log });
    // While playing, every frame uses the colour range of the first frame, so the colours compare across steps.
    const pl = state.play;
    if (pl && pl.path === info.path && rr && !rr.error) {
      if (!pl.range || pl.range.log !== rr.log) pl.range = { lo: rr.lo, hi: rr.hi, log: rr.log };
      else rr = { ...rr, lo: pl.range.lo, hi: pl.range.hi };
    }
    logBox.disabled = !(rr && rr.logOk);
    logBox.checked = !!(rr && rr.log);
    note.className = rr && rr.error ? 'err note' : 'muted note';
    note.textContent = rr && rr.error ? rr.error : '';
    p = heatmap(canvas, r.values, { width, cmap: colormap(P.cmap, P.reverse), range: rr, flipY, lines: lines() });
    if (p) { canvas.dataset.cellSize = String(p.scale); canvas.dataset.rows = String(p.rows); canvas.dataset.cols = String(p.cols); }
    saveBtn.disabled = !p;
  };
  const change = () => { savePlotPrefs(); paint(); };
  cmapSel.addEventListener('change', () => { P.cmap = cmapSel.value; change(); });
  rev.addEventListener('change', () => { P.reverse = rev.checked; change(); });
  rangeSel.addEventListener('change', () => {
    P.range = rangeSel.value;
    if (P.range === 'custom' && !P.custom[info.path] && rr) { P.custom[info.path] = { min: String(rr.lo), max: String(rr.hi) }; minIn.value = String(rr.lo); maxIn.value = String(rr.hi); }
    change();
  });
  const setCustom = () => { P.custom[info.path] = { min: minIn.value, max: maxIn.value }; change(); };
  minIn.addEventListener('change', setCustom); maxIn.addEventListener('change', setCustom);
  logBox.addEventListener('change', () => { P.log = logBox.checked; change(); });
  if (coastBox) coastBox.addEventListener('change', () => { P.coast = coastBox.checked; change(); });
  paint();
  const cellAt = e => { const h = p && p.hit(e.offsetX, e.offsetY); if (!h) return null; return { h, ri: r.start[v.rowAxis] + h.r * r.step[v.rowAxis], ci: r.start[v.colAxis] + h.c * r.step[v.colAxis] }; };
  const readout = x => `${info.dims[v.rowAxis]}=${coordLabel(rc, x.ri)}  ${info.dims[v.colAxis]}=${coordLabel(cc, x.ci)}  value=${fmtNum(r.values[x.h.r][x.h.c])}`;
  canvas.addEventListener('mousemove', e => { const x = cellAt(e); if (x) hover.textContent = readout(x); });
  canvas.addEventListener('click', e => {
    const x = cellAt(e); if (!x) return;
    hover.textContent = readout(x);
    if (nd >= 3) {
      const keep = state.seriesAxis && state.seriesAxis.path === info.path ? state.seriesAxis.axis : undefined;
      state.seriesAt = { path: info.path, rowAxis: v.rowAxis, colAxis: v.colAxis, ri: x.ri, ci: x.ci, axis: keep };
      showSeries(info, seriesBox, width);
    }
  });
  saveBtn.addEventListener('click', async () => {
    if (!p || !rr) return;
    try {
      const fx = await fixedText(info, v);
      const rowTick = i => coordLabel(rc, r.start[v.rowAxis] + i * r.step[v.rowAxis]);
      const colTick = i => coordLabel(cc, r.start[v.colAxis] + i * r.step[v.colAxis]);
      const title = cf(info) + (fx.text ? ', ' + fx.text : '');
      const url = heatmapPng(r.values, { title, cmap: colormap(P.cmap, P.reverse), range: rr, rowLabel: info.dims[v.rowAxis], colLabel: info.dims[v.colAxis], rowTick, colTick, units, flipY, lines: lines() });
      await savePng(url, `${safeName(info.name)}${fx.name ? '-' + fx.name : ''}.png`, note);
    } catch (e) { note.className = 'err note'; note.textContent = 'Could not draw the picture: ' + e.message; }
  });
  const sa = state.seriesAt;
  if (nd >= 3 && sa && sa.path === info.path && sa.rowAxis === v.rowAxis && sa.colAxis === v.colAxis) showSeries(info, seriesBox, width);
  else state.seriesAt = null;
  const playing = state.play && state.play.path === info.path ? ', colour range fixed while playing' : '';
  showStats(bar, r, `${sampled}, ${Math.round(performance.now() - t0)} ms${playing}`);
}

/**
 * Series at a point: values along one other dimension at the clicked cell, the sliders fixing the rest.
 * The dimension is the first one that is not the row or column dimension unless the user picks another.
 */
async function showSeries(info, box, width) {
  const v = state.view, sa = state.seriesAt;
  const others = info.dims.map((_, d) => d).filter(d => d !== v.rowAxis && d !== v.colAxis);
  if (!others.length || !sa) return;
  if (!others.includes(sa.axis)) sa.axis = others[0];
  const close = () => { state.seriesAt = null; state.closeSeries = null; box.hidden = true; box.replaceChildren(); };
  state.closeSeries = close;
  const index = v.index.slice();
  index[v.rowAxis] = sa.ri; index[v.colAxis] = sa.ci;
  box.hidden = false;
  const myToken = {}; box.token = myToken;
  box.replaceChildren(el('p', { class: 'muted', text: 'Reading series…' }));
  let s;
  try {
    s = await request('series', info.path, { axis: sa.axis, index, decode: state.decode, ...(info.complex ? { part: partFor(info, 'plot') } : {}) });
  } catch (e) {
    if (box.token !== myToken) return;
    box.replaceChildren(el('div', { class: 'serieshead' }, el('span', { class: 'err', text: e.message }), el('span', { class: 'grow' }), el('button', { class: 'secondary', id: 'series-close', 'aria-label': 'Close series', title: 'Close (Escape)', onclick: close }, '✕')));
    return;
  }
  if (box.token !== myToken || state.seriesAt !== sa) return;
  const title = seriesTitle(s, fmtNum);
  const dimSel = el('select', { id: 'series-dim', 'aria-label': 'Series along dimension', disabled: others.length < 2 });
  for (const d of others) dimSel.append(el('option', { value: d, selected: d === sa.axis, text: `${info.dims[d]} (${info.shape[d]})` }));
  dimSel.addEventListener('change', () => { sa.axis = Number(dimSel.value); state.seriesAxis = { path: info.path, axis: sa.axis }; showSeries(info, box, width); });
  const note = el('span', { class: 'muted note', id: 'series-note', role: 'status', text: s.step > 1 ? `every ${s.step}th of ${s.len} values` : '' });
  const xs = s.coord ? s.values.map((_, i) => (s.coord.times ? (s.coord.times[i] != null ? s.coord.times[i] : s.indices[i]) : s.coord.values[i])) : s.indices;
  const ys = s.values;
  const units = s.units || undefined;
  const canvas = el('canvas', { class: 'plot', id: 'series-canvas', role: 'img', 'aria-label': title });
  const hover = el('div', { class: 'hover mono', id: 'series-readout', role: 'status' });
  const csv = () => seriesCsv(s);
  box.replaceChildren(
    el('div', { class: 'serieshead' },
      el('span', { class: 'seriestitle', id: 'series-title', text: title }),
      el('label', { class: 'ctl' }, 'Along ', dimSel),
      el('button', { class: 'secondary', id: 'series-save-png', onclick: () => pngOf(() => linePng(xs, ys, { title, xLabel: s.dim, yLabel: units }), `${safeName(s.name)}-${s.fixed.map(f => safeName(f.dim) + f.index).join('-')}-${safeName(s.dim)}.png`, note) }, 'Save PNG'),
      el('button', { class: 'secondary', id: 'series-copy-csv', onclick: () => { vscode.postMessage({ type: 'copy', text: csv() }); note.className = 'muted note'; note.textContent = `Copied ${ys.length} rows`; } }, 'Copy as CSV'),
      note, el('span', { class: 'grow' }),
      el('button', { class: 'secondary', id: 'series-close', 'aria-label': 'Close series', title: 'Close (Escape)', onclick: close }, '✕')),
    canvas, hover);
  const p = linePlot(canvas, xs, ys, { width, height: 240, xLabel: s.dim, yLabel: units });
  if (p) canvas.addEventListener('mousemove', e => { const i = p.hit(e.offsetX); if (i === null) return; hover.textContent = `${s.dim}=${typeof xs[i] === 'number' ? fmtNum(xs[i]) : xs[i]}  value=${fmtNum(ys[i])}`; });
}

vscode.postMessage({ type: 'ready' });
