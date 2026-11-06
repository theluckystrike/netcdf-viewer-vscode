// Canvas plots: 1D line plot and 2D heatmap with a colorbar. Values never become HTML.
import { viridis, colorRange, ticks, fmtNum } from './util.js';

function css(name, dflt) { return getComputedStyle(document.body).getPropertyValue(name).trim() || dflt; }

function setup(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.font = `11px ${css('--vscode-font-family', 'sans-serif')}`;
  return g;
}

export function linePlot(canvas, xs, ys, opts = {}) {
  const W = opts.width || 760, H = opts.height || 320, L = 64, R = 16, T = 14, B = 40;
  const g = setup(canvas, W, H);
  const fg = css('--vscode-foreground', '#ccc'), grid = css('--vscode-panel-border', '#444'), line = css('--vscode-charts-blue', '#3794ff');
  let y0 = Infinity, y1 = -Infinity;
  for (const y of ys) if (typeof y === 'number' && Number.isFinite(y)) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const xnum = xs.every(x => typeof x === 'number' && Number.isFinite(x));
  const X = xnum ? xs : xs.map((_, i) => i);
  const x0 = Math.min(...X), x1 = Math.max(...X);
  if (!Number.isFinite(y0)) { g.fillStyle = fg; g.fillText('No finite values to plot.', L, T + 20); return null; }
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const px = x => L + (x1 === x0 ? 0.5 : (x - x0) / (x1 - x0)) * (W - L - R);
  const py = y => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  g.strokeStyle = grid; g.fillStyle = fg; g.lineWidth = 1;
  for (const t of ticks(y0, y1, 5)) { const y = py(t); g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); g.textAlign = 'right'; g.fillText(fmtNum(t), L - 6, y + 4); }
  g.textAlign = 'center';
  if (xnum) for (const t of ticks(x0, x1, 6)) g.fillText(fmtNum(t), px(t), H - B + 16);
  else { const n = xs.length; for (let k = 0; k < 5 && n; k++) { const i = Math.round(k * (n - 1) / 4); g.fillText(String(xs[i]).slice(0, 16), px(i), H - B + 16); } }
  if (opts.xLabel) g.fillText(opts.xLabel, (L + W - R) / 2, H - 6);
  g.strokeStyle = line; g.lineWidth = 1.5; g.beginPath();
  let pen = false;
  for (let i = 0; i < ys.length; i++) {
    const y = ys[i];
    if (typeof y !== 'number' || !Number.isFinite(y)) { pen = false; continue; }
    if (pen) g.lineTo(px(X[i]), py(y)); else { g.moveTo(px(X[i]), py(y)); pen = true; }
  }
  g.stroke();
  return { hit(mx) { const t = (mx - L) / (W - L - R); if (t < 0 || t > 1) return null; let best = 0, bd = Infinity; const xv = x0 + t * (x1 - x0); for (let i = 0; i < X.length; i++) { const d = Math.abs(X[i] - xv); if (d < bd) { bd = d; best = i; } } return best; } };
}

export function heatmap(canvas, rows, opts = {}) {
  const nr = rows.length, nc = nr ? rows[0].length : 0;
  const maxW = opts.width || 760, maxH = opts.height || 340, CB = 96;
  const scale = Math.max(0.25, Math.min((maxW - CB) / Math.max(1, nc), maxH / Math.max(1, nr), 8));
  const w = Math.max(1, Math.round(nc * scale)), h = Math.max(1, Math.round(nr * scale));
  const g = setup(canvas, w + CB, Math.max(h, 120));
  const flat = []; for (const r of rows) for (const v of r) flat.push(v);
  const range = colorRange(flat);
  const fg = css('--vscode-foreground', '#ccc');
  if (!range) { g.fillStyle = fg; g.fillText('No finite values to plot.', 8, 20); return null; }
  const img = new ImageData(Math.max(1, nc), Math.max(1, nr));
  const { lo, hi } = range;
  for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
    const v = rows[r][c], k = (r * nc + c) * 4;
    if (typeof v !== 'number' || !Number.isFinite(v)) { img.data[k] = 128; img.data[k + 1] = 128; img.data[k + 2] = 128; img.data[k + 3] = 90; continue; }
    const [R, G, B] = viridis((v - lo) / (hi - lo));
    img.data[k] = R; img.data[k + 1] = G; img.data[k + 2] = B; img.data[k + 3] = 255;
  }
  const off = document.createElement('canvas'); off.width = Math.max(1, nc); off.height = Math.max(1, nr);
  off.getContext('2d').putImageData(img, 0, 0);
  g.imageSmoothingEnabled = false;
  g.drawImage(off, 0, 0, w, h);
  const bx = w + 14, bh = Math.max(h, 120) - 20;
  for (let i = 0; i < bh; i++) { const [R, G, B] = viridis(1 - i / bh); g.fillStyle = `rgb(${R},${G},${B})`; g.fillRect(bx, 10 + i, 12, 1); }
  g.fillStyle = fg; g.textAlign = 'left';
  g.fillText(fmtNum(hi), bx + 16, 14); g.fillText(fmtNum(lo), bx + 16, 10 + bh);
  return { range, hit(mx, my) { const c = Math.floor(mx / scale), r = Math.floor(my / scale); return r >= 0 && c >= 0 && r < nr && c < nc ? { r, c } : null; } };
}
