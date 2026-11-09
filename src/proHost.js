'use strict';
// Host side of the Pro tools (compare two files, export a subset): commands, free tries, progress and the report.
// Each file gets its own reader thread (the same worker as the viewer), so the editor never blocks.
// The tools only read the files; they write only the file the user picks in a save dialog.
const path = require('path');
const { Worker } = require('worker_threads');
const { Session } = require('./core/session.mjs');
const { compareFiles } = require('./core/ncompare.mjs');
const { parseRange, writeSubset, CSV_MAX_VALUES, NC_MAX_VALUES } = require('./core/subset.mjs');
const { walk } = require('./core/blocks.mjs');
const { createPro } = require('./pro');
const { describe } = require('./pro/describe');
const { render } = require('./pro/table');
const { openReportPanel } = require('./pro/panel');

const OPEN_FILTERS = ['nc', 'nc4', 'netcdf', 'cdf', 'h5', 'hdf5', 'he5', 'hdf', 'nxs', 'h5ad', 'mat', 'jld2', 'loom'];
// Gate builds only (esbuild define); release builds trust only the live key inside src/license.
const TEST_KEY = typeof __ZOVO_TEST_PUBKEY__ === 'string' ? __ZOVO_TEST_PUBKEY__ : ''; // eslint-disable-line no-undef
const isUri = u => !!u && typeof u === 'object' && typeof u.scheme === 'string' && typeof u.path === 'string';
const baseName = uri => path.basename(uri.fsPath || uri.path);
const nf = new Intl.NumberFormat('en-US');

/**
 * deps: { vscode, context, settings() } -> { pro, state(), runCompare(uriA, uriB), runSubset(uri, varPath), onDidChange }
 */
function registerPro({ vscode, context, settings, prefix = 'hdf5NetcdfExplorer' }) {
  const pro = createPro({ vscode, context, prefix, testKey: TEST_KEY || undefined });
  const show = () => vscode.workspace.getConfiguration(prefix).get('showProFeatures', true) !== false;
  const state = () => ({ show: show() || pro.licensed, licensed: pro.licensed, trials: pro.trials() });

  /** A reader thread for one file. */
  async function openReader(uri) {
    if (uri.scheme !== 'file') throw new Error(`Only files on this computer can be read (this file is on ${uri.scheme}).`);
    const s = settings();
    const session = new Session({
      fileName: baseName(uri), post: () => {}, timeoutMs: Math.max(s.timeoutMs, 60000),
      limits: { maxReadValues: s.maxReadValues, maxPathLength: 4096, maxDims: 32, maxPage: 2000 },
      createWorker: () => new Worker(path.join(context.extensionPath, 'dist', 'worker.mjs'), { workerData: { filePath: uri.fsPath, opts: { maxReadValues: s.maxReadValues, maxFileSizeMB: s.maxFileSizeMB } } }),
    });
    try { await session.spawn(); } catch (e) { session.dispose(); throw e; }
    return { session, call: (op, payload) => session.call(op, payload), close: () => session.dispose(), name: baseName(uri), uri };
  }

  function activeUri() {
    const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab && tab.input;
    const u = input && (input.uri || input.modified);
    if (isUri(u) && u.scheme === 'file') return u;
    const ed = vscode.window.activeTextEditor;
    return ed && ed.document.uri.scheme === 'file' ? ed.document.uri : null;
  }
  const dataUri = u => (u && OPEN_FILTERS.includes(path.extname(u.fsPath || u.path).slice(1).toLowerCase()) ? u : null);

  async function pickFile(title, openLabel, near) {
    const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel, title, defaultUri: near ? vscode.Uri.file(path.dirname(near.fsPath)) : undefined,
      filters: { 'NetCDF / HDF5': OPEN_FILTERS, 'All files': ['*'] } });
    return r && r[0] ? r[0] : null;
  }

  function withProgress(title, fn) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
      let last = 0;
      const report = (f, text) => { const pct = Math.floor(f * 100); if (pct > last) { progress.report({ increment: pct - last, message: text }); last = pct; } };
      return fn({ cancelled: () => token.isCancellationRequested, progress: report });
    });
  }

  async function saveReport(report, desc, near, format) {
    const stem = `compare-${report.fileA}-vs-${report.fileB}`.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120);
    const ext = format === 'md' ? 'md' : format;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(path.dirname(near.fsPath), `${stem}.${ext}`)),
      filters: format === 'csv' ? { CSV: ['csv'] } : format === 'md' ? { Markdown: ['md'] } : { JSON: ['json'] },
      saveLabel: 'Save report', title: 'Save the report',
    });
    if (!target) return;
    if ((report._paths || []).includes(path.resolve(target.fsPath))) { vscode.window.showErrorMessage('Pick another file name. The report never writes over a data file.'); return; }
    await vscode.workspace.fs.writeFile(target, Buffer.from(render(format, desc, report), 'utf8'));
    const a = await vscode.window.showInformationMessage(`Saved ${baseName(target)}.`, 'Open');
    if (a === 'Open') await vscode.commands.executeCommand('vscode.open', target);
  }

  /** Compare file A (the open file or a pick) with file B (a pick). */
  async function runCompare(uriA, uriB) {
    if (!(await pro.allowed('compare'))) return;
    if (!uriA) uriA = await pickFile('Compare: pick the first file (A)', 'Pick A');
    if (!uriA) return;
    if (!uriB) uriB = await pickFile(`Compare ${baseName(uriA)} with...`, 'Compare', uriA);
    if (!uriB) return;
    let a = null, b = null;
    try {
      a = await openReader(uriA);
      b = await openReader(uriB);
    } catch (e) {
      if (a) a.close();
      vscode.window.showErrorMessage(`Could not open the file for the compare. ${e.message || e}`);
      return;
    }
    await pro.useTrial('compare');
    try {
      const s = settings();
      const tolerance = Math.max(0, Number(vscode.workspace.getConfiguration(prefix).get('compareTolerance', 0)) || 0);
      const report = await withProgress(`Comparing ${a.name} with ${b.name}`, o => compareFiles({ callA: a.call, callB: b.call, nameA: a.name, nameB: b.name, maxValues: s.maxReadValues, tolerance, ...o }));
      report._paths = [path.resolve(uriA.fsPath), path.resolve(uriB.fsPath)];
      const desc = describe(report);
      openReportPanel({ vscode, viewType: `${prefix}.proReport`, title: `Compare: ${a.name} vs ${b.name}`, desc, onSave: f => saveReport(report, desc, uriA, f) });
      return report;
    } catch (e) {
      vscode.window.showErrorMessage(`The compare stopped. ${e.message || e}`);
    } finally { a.close(); b.close(); }
  }

  /** Decoded coordinate labels for the range prompts and the CSV: { values, times, units } or null. */
  async function readCoord(r, cpath, n, maxValues) {
    if (!cpath) return null;
    try {
      const ci = await r.call('info', { path: cpath });
      if (!ci.numeric || ci.shape.length !== 1 || ci.shape[0] !== n) return null;
      const values = [], times = [];
      let anyTime = false;
      for (let s = 0; s < n; s += maxValues) {
        const c = Math.min(maxValues, n - s);
        const x = await r.call('read', { path: cpath, view: { rowAxis: 0, colAxis: -1, index: [0], rowStart: s, rowCount: c }, decode: true });
        for (let i = 0; i < x.values.length; i++) { values.push(x.values[i][0]); const t = x.times ? x.times[i][0] : null; times.push(t); if (t != null) anyTime = true; }
      }
      return { values, times: anyTime ? times : null, units: ci.cf && ci.cf.units, path: cpath };
    } catch { return null; }
  }

  const fmt = v => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)))) : String(v));

  /** Export a subset of one variable: pick the variable, a range per dimension, the format and the file. */
  async function runSubset(uri, varPath) {
    if (!(await pro.allowed('subset'))) return;
    if (!uri) uri = await pickFile('Export a subset: pick a NetCDF or HDF5 file', 'Pick file');
    if (!uri) return;
    let r;
    try { r = await openReader(uri); } catch (e) { vscode.window.showErrorMessage(`Could not open ${baseName(uri)}. ${e.message || e}`); return; }
    try {
      const s = settings();
      let info = null;
      if (varPath) { try { info = await r.call('info', { path: varPath }); } catch { info = null; } }
      if (!info || info.kind !== 'dataset' || !info.numeric || info.compound) {
        const { items } = await walk(p => r.call('list', { path: p }));
        const picks = items.filter(x => x.kind === 'dataset' && (x.shape || []).length && !/^string|char|compound/i.test(x.dtype)).map(x => ({ label: x.path, description: `${x.dtype} ${(x.shape || []).map((n, i) => (x.dims && x.dims[i] ? `${x.dims[i]}=${n}` : n)).join(' × ')}`, path: x.path }));
        if (!picks.length) { vscode.window.showWarningMessage(`${r.name} has no numeric variable to export.`); return; }
        const pick = await vscode.window.showQuickPick(picks, { title: `Export a subset of ${r.name} (1/3): variable`, matchOnDescription: true });
        if (!pick) return;
        info = await r.call('info', { path: pick.path });
        if (!info.numeric || info.compound) { vscode.window.showWarningMessage('Pick a numeric variable.'); return; }
      }
      const nd = info.shape.length;
      const coords = [];
      const sel = [];
      for (let d = 0; d < nd; d++) {
        const n = info.shape[d];
        const dim = (info.dims && info.dims[d]) || `dim${d}`;
        const c = await readCoord(r, info.coords && info.coords[d], n, s.maxReadValues);
        coords.push(c);
        const lab = i => (c ? (c.times && c.times[i] != null ? c.times[i] : fmt(c.values[i])) : String(i));
        const span = n ? `${lab(0)} to ${lab(n - 1)}${c && c.units && !(c.times && c.times[0] != null) ? ' ' + c.units : ''}` : 'empty';
        const example = c ? (c.times && c.times[0] != null ? `, or dates such as ${String(c.times[0]).slice(0, 10)}..${String(c.times[n - 1]).slice(0, 10)}` : `, or values such as ${fmt(c.values[0])}..${fmt(c.values[Math.max(0, n - 1)])}`) : '';
        const text = await vscode.window.showInputBox({
          title: `Export a subset of ${info.name} (2/3): ${dim}, dimension ${d + 1} of ${nd}`,
          prompt: `${dim} has ${nf.format(n)} values, ${span}. Leave empty for all, or type an index (5), indices (0:99 or 0:99:2)${example}.`,
          value: '', placeHolder: 'all',
          validateInput: v => { const x = parseRange(v, n, c); return x.ok ? { message: `Selected: ${x.text}`, severity: 1 } : x.error; },
        });
        if (text === undefined) return;
        const x = parseRange(text, n, c);
        if (!x.ok) { vscode.window.showErrorMessage(x.error); return; }
        sel.push(x);
      }
      const total = sel.reduce((p, x) => p * x.count, 1);
      // Too big for any format: say so now, before the format and file pickers, and keep the free try.
      if (total > NC_MAX_VALUES) { vscode.window.showErrorMessage(`This subset has ${nf.format(total)} values. Pick a smaller range.`); return; }
      const bytesNc = total * (info.dtype === 'float32' ? 4 : 8);
      const fmtPick = await vscode.window.showQuickPick([
        { label: 'NetCDF (.nc)', description: `about ${bytesNc < 1048576 ? `${Math.max(1, Math.round(bytesNc / 1024))} KB` : `${(bytesNc / 1048576).toFixed(1)} MB`}`, detail: 'NetCDF-3 64-bit offset with the coordinates and attributes. Opens in xarray, CDO, NCO, Panoply and this viewer.', format: 'nc' },
        { label: 'CSV (.csv)', description: total > CSV_MAX_VALUES ? `too large: ${nf.format(total)} values, CSV stops at ${nf.format(CSV_MAX_VALUES)}` : `${nf.format(total)} rows`, detail: 'One row per point: the coordinates, then the value. Fill values are empty cells.', format: 'csv' },
      ], { title: `Export a subset of ${info.name} (3/3): ${nf.format(total)} values`, placeHolder: 'File format' });
      if (!fmtPick) return;
      const stem = `${info.name}_subset`.replace(/[^A-Za-z0-9_.-]+/g, '_');
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(path.dirname(uri.fsPath), `${stem}.${fmtPick.format}`)),
        filters: fmtPick.format === 'nc' ? { NetCDF: ['nc'] } : { CSV: ['csv'] }, saveLabel: 'Export subset', title: 'Export subset',
      });
      if (!target) return;
      if (path.resolve(target.fsPath) === path.resolve(uri.fsPath)) { vscode.window.showErrorMessage('Pick a new file name. The export never overwrites the file it reads.'); return; }
      if (fmtPick.format === 'csv' && total > CSV_MAX_VALUES) { vscode.window.showErrorMessage(`This subset has ${nf.format(total)} values. CSV export stops at ${nf.format(CSV_MAX_VALUES)}; save it as NetCDF, or pick a smaller range.`); return; }
      await pro.useTrial('subset');
      const res = await withProgress(`Exporting ${info.name} to ${baseName(target)}`, o => writeSubset(r.call, info, sel, coords, { path: target.fsPath, format: fmtPick.format }, { maxValues: s.maxReadValues, sourceName: r.name, ...o }));
      if (res.cancelled) { vscode.window.showInformationMessage('Export cancelled. Nothing was written.'); return; }
      const a = await vscode.window.showInformationMessage(`Saved ${baseName(target)}: ${nf.format(res.values)} values of ${info.name}.`, 'Open', 'Reveal in Explorer');
      if (a === 'Open') await vscode.commands.executeCommand('vscode.open', target);
      else if (a === 'Reveal in Explorer') await vscode.commands.executeCommand('revealInExplorer', target);
      return res;
    } catch (e) {
      vscode.window.showErrorMessage(`The subset export stopped. ${e.message || e}`);
    } finally { r.close(); }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(`${prefix}.compareFiles`, (arg, list) => {
      const two = Array.isArray(list) && list.length >= 2 && list.every(isUri) ? list : null;
      if (two) return runCompare(two[0], two[1]);
      return runCompare(isUri(arg) ? arg : dataUri(activeUri()));
    }),
    vscode.commands.registerCommand(`${prefix}.exportSubset`, arg => runSubset(isUri(arg) ? arg : dataUri(activeUri()))),
    vscode.window.registerUriHandler({ handleUri: uri => pro.handleUri(uri) }),
  );
  return { pro, state, runCompare, runSubset, onDidChange: pro.onDidChange };
}

module.exports = { registerPro };
