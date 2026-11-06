// Webview UI. All file content goes into the DOM as text nodes (textContent), never parsed as HTML.
import { fmtNum, fmtBytes, shapeText, pythonSnippet } from './util.js';
import { linePlot, heatmap } from './plot.js';

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

const state = { init: null, selected: null, info: null, view: null, tab: 'table', decode: true, coordCache: new Map(), tree: new Map(), filter: '' };

window.addEventListener('message', ev => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'init') { state.init = m; render(); return; }
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
    app.append(el('div', { class: 'fatal' }, el('h2', { text: 'Cannot open ' + i.fileName }), el('p', { text: i.error })));
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
        li.append(el('span', { class: 'twisty', text: sub && sub.open ? '▾' : '▸' }), el('span', { text: it.name }), el('span', { class: 'muted', text: ` ${it.children}` }));
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
      li.append(el('span', { class: 'icon', text: icon }), el('span', { text: it.name }), el('span', { class: 'muted', text: ' ' + (it.kind === 'dataset' ? `${it.dtype} ${shapeText(it.shape, null)}` : it.kind === 'external' ? it.target : it.kind) }));
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
    // Show the last two dims (lat x lon for most climate data) and fix the others at 0.
    state.view.rowAxis = nd - 2; state.view.colAxis = nd - 1;
  }
  state.tab = info.compound || !info.numeric || nd === 0 ? 'table' : (nd >= 2 ? 'plot' : state.tab);
  showDataset(info, detail);
}

function showGroup(info, detail) {
  const n = state.tree.get(info.path);
  const kids = el('div');
  detail.replaceChildren(
    el('h2', { text: info.path === '/' ? (state.init.fileName) : info.name }),
    kv([['Format', info.format], ['Path', info.path], ['Items', info.children]]),
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
  const cf = info.cf || {};
  const nd = info.shape.length;
  const lib = state.init.format === 'netcdf3' || /NetCDF/.test(state.init.label) ? 'xarray' : 'h5py';
  const copyBtn = (label, fn) => el('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'copy', text: fn() }) }, label);
  const coordsText = (info.coords || []).map((c, i) => c ? `${info.dims[i]} → ${c}` : null).filter(Boolean).join(', ');
  const head = el('div', { class: 'dhead' },
    el('h2', null, el('span', { class: 'mono', text: info.name }), cf.long_name ? el('span', { class: 'muted', text: '  ' + cf.long_name }) : null),
    el('div', { class: 'actions' },
      copyBtn('Copy path', () => info.path),
      copyBtn(lib === 'xarray' ? 'Copy xarray code' : 'Copy h5py code', () => pythonSnippet({ fileName: state.init.fileName, path: info.path, lib, shape: info.shape, dims: info.dims, hs: state.lastHs }))));
  const meta = kv([
    ['Path', info.path], ['Type', info.dtype], ['Shape', shapeText(info.shape, info.dims)],
    ['Units', cf.units], ['Standard name', cf.standard_name], ['Calendar', cf.time ? cf.calendar || 'standard' : undefined],
    ['Packing', packingText(cf.packing)], ['Coordinates', coordsText || cf.coordinates],
    ['Chunks', info.chunks ? info.chunks.join(' × ') : undefined], ['Compression', compression(info)],
    ['Size in memory', fmtBytes(info.bytes)], ['Max shape', info.maxshape && info.maxshape.some((m, i) => m !== info.shape[i]) ? info.maxshape.map(m => (m === null || m < 0 ? '∞' : m)).join(' × ') : undefined],
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

function buildControls(info, box, redraw) {
  const nd = info.shape.length, v = state.view;
  if (info.numeric && (info.cf && info.cf.packing || info.cf && info.cf.time)) {
    const cb = el('input', { type: 'checkbox', id: 'dec', checked: state.decode, onchange: e => { state.decode = e.target.checked; redraw(); } });
    box.append(el('label', { class: 'chk' }, cb, ' Apply CF decoding (scale, offset, fill, time)'));
  }
  if (nd < 2) return;
  const axisSel = (which) => {
    const s = el('select', { 'aria-label': which === 'rowAxis' ? 'Row dimension' : 'Column dimension', onchange: e => {
      const a = Number(e.target.value), other = which === 'rowAxis' ? 'colAxis' : 'rowAxis';
      if (a === v[other]) v[other] = v[which];
      v[which] = a; v.rowStart = 0; v.colStart = 0;
      box.replaceChildren(); buildControls(info, box, redraw); redraw();
    } });
    info.dims.forEach((d, i) => s.append(el('option', { value: i, selected: v[which] === i, text: `${d} (${info.shape[i]})` })));
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
    const set = x => { v.index[d] = Math.max(0, Math.min(n - 1, Math.trunc(Number(x) || 0))); num.value = v.index[d]; range.value = v.index[d]; setLab(); clearTimeout(t); t = setTimeout(redraw, 120); };
    range.addEventListener('input', e => set(e.target.value));
    num.addEventListener('change', e => set(e.target.value));
    box.append(el('span', { class: 'ctl slider' }, `${info.dims[d]} `, range, num, lab));
    setLab();
  }
}

function showStats(bar, r, note) {
  const s = r.stats;
  if (!s) { bar.textContent = ''; return; }
  const parts = s.count ? [`min ${fmtNum(s.min)}`, `max ${fmtNum(s.max)}`, `mean ${fmtNum(s.mean)}`, `std ${fmtNum(s.std)}`] : ['no finite values'];
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
  body.replaceChildren(el('p', { class: 'muted', text: 'Reading…' }));
  const t0 = performance.now();
  try {
    if (state.tab === 'plot') {
      const rows = info.shape[v.rowAxis], cols = v.colAxis >= 0 ? info.shape[v.colAxis] : 1;
      const view = nd === 1
        ? { ...v, rowStart: 0, rowCount: rows, rowStep: Math.ceil(rows / LINE_MAX), colAxis: -1 }
        : { ...v, rowStart: 0, colStart: 0, rowCount: rows, colCount: cols, rowStep: Math.ceil(rows / PLOT_MAX), colStep: Math.ceil(cols / PLOT_MAX) };
      const r = await request('read', info.path, { view, decode: state.decode, purpose: 'plot' });
      if (state.drawToken !== token) return;
      state.lastHs = { ...r, single: info.shape.map((_, d) => d !== v.rowAxis && d !== v.colAxis) };
      const canvas = el('canvas', { class: 'plot', role: 'img', 'aria-label': `Plot of ${info.name}` });
      const hover = el('div', { class: 'hover mono' });
      body.replaceChildren(canvas, hover);
      const width = Math.max(320, Math.min(1000, body.clientWidth - 8));
      if (nd === 1) {
        const c = await coordValues(info.coords && info.coords[0], rows);
        const idx = r.values.map((_, i) => r.start[0] + i * r.step[0]);
        const xs = c ? idx.map(i => (c.times ? i : c.values[i])) : idx;
        const ys = r.values.map(x => x[0]);
        const p = linePlot(canvas, xs, ys, { width, xLabel: info.dims[0] });
        if (p) canvas.addEventListener('mousemove', e => { const i = p.hit(e.offsetX); if (i === null) return; hover.textContent = `${info.dims[0]}=${coordLabel(c, idx[i])}  value=${fmtNum(ys[i])}`; });
      } else {
        const p = heatmap(canvas, r.values, { width });
        const [rc, cc] = await Promise.all([coordValues(info.coords && info.coords[v.rowAxis], rows), coordValues(info.coords && info.coords[v.colAxis], cols)]);
        if (p) canvas.addEventListener('mousemove', e => { const h = p.hit(e.offsetX, e.offsetY); if (!h) return; const ri = r.start[v.rowAxis] + h.r * r.step[v.rowAxis], ci = r.start[v.colAxis] + h.c * r.step[v.colAxis]; hover.textContent = `${info.dims[v.rowAxis]}=${coordLabel(rc, ri)}  ${info.dims[v.colAxis]}=${coordLabel(cc, ci)}  value=${fmtNum(r.values[h.r][h.c])}`; });
      }
      const sampled = r.step.some(s => s > 1) ? `sampled every ${r.step.filter(s => s > 1).join('×')}` : 'all values';
      showStats(bar, r, `${sampled}, ${Math.round(performance.now() - t0)} ms`);
      return;
    }
    const view = { ...v, rowCount: PAGE_ROWS, colCount: v.colAxis >= 0 ? PAGE_COLS : 1 };
    const r = await request('read', info.path, { view, decode: state.decode, purpose: 'table' });
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
        const txt = r.times && r.times[i][c] ? r.times[i][c] : fmtNum(val);
        tr.append(el('td', { class: val === null ? 'fill' : typeof val === 'string' && !r.times ? 'str' : '', title: r.times ? fmtNum(val) : undefined, text: txt }));
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
  } catch (e) {
    if (state.drawToken !== token) return;
    body.replaceChildren(el('p', { class: 'err', text: e.message }));
    bar.textContent = '';
  }
}
const cf = info => (info.cf && info.cf.units ? `${info.name} (${info.cf.units})` : info.name);

vscode.postMessage({ type: 'ready' });
