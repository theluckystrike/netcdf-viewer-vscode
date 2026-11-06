// Screenshots of the real webview bundle driven by the real worker over CDP.
// The page's acquireVsCodeApi().postMessage goes through a CDP binding into a Session in this Node process,
// so every value on screen comes from the sample file. Usage: node shoot.mjs <port> <sample> <outdir> <scenario>
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/core/session.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const [port, sample, outDir, scenario] = process.argv.slice(2);
const theme = `:root{--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,Monaco,monospace;
--vscode-foreground:#cccccc;--vscode-editor-background:#1f1f1f;--vscode-panel-border:#2b2b2b;--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;
--vscode-badge-background:#616161;--vscode-badge-foreground:#f8f8f8;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#ccc;
--vscode-focusBorder:#0078d4;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#fff;--vscode-charts-blue:#3794ff;--vscode-errorForeground:#f48771}`;
const harness = path.join(here, 'harness.html');
fs.writeFileSync(harness, `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${theme}</style><link rel="stylesheet" href="file://${root}/media/webview.css"></head>
<body><div id="app"></div><script>window.acquireVsCodeApi = () => ({ postMessage: m => window.__host(JSON.stringify(m)) });</script>
<script src="file://${root}/dist/webview.js"></script></body></html>`);

const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const waits = new Map();
const send = (method, params = {}) => new Promise(r => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const evalJs = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const session = new Session({
  fileName: path.basename(sample), timeoutMs: 20000,
  post: m => send('Runtime.evaluate', { expression: `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(m)} }))` }),
  copy: () => {},
  createWorker: () => new Worker(path.join(root, 'src', 'worker.mjs'), { workerData: { filePath: path.resolve(sample), opts: {} } }),
});
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
  if (m.method === 'Runtime.bindingCalled' && m.params.name === '__host') session.handle(JSON.parse(m.params.payload));
});
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
await send('Runtime.enable');
await send('Runtime.addBinding', { name: '__host' });
await send('Page.enable');
await send('Page.navigate', { url: 'file://' + harness });
await sleep(1500);
const clickText = async (sel, text) => evalJs(`(() => { const n = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.includes(${JSON.stringify(text)})); if (n) { n.click(); return true; } return false; })()`);
const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(outDir, name), Buffer.from(r.result.data, 'base64')); console.log('wrote', name); };
const setIndex = async (i, v) => evalJs(`(() => { const r = document.querySelectorAll('.ctl.slider input[type=range]')[${i}]; r.value = ${v}; r.dispatchEvent(new Event('input')); return true; })()`);

if (scenario === 'era5') {
  await clickText('#tree .node', 't2m'); await sleep(900);
  await setIndex(0, 13); await sleep(1200);
  await evalJs(`(() => { const c = document.querySelector('canvas.plot'); const b = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('mousemove', { clientX: b.x + 300, clientY: b.y + 90, bubbles: true })); })()`);
  await sleep(200);
  await shot('screenshot.png');
  await clickText('.tab', 'Table'); await sleep(900);
  await shot('table.png');
  await clickText('#tree .node', '/ (file)'); await sleep(900);
  await shot('overview.png');
} else if (scenario === 'argo') {
  await clickText('#tree .node', 'temp'); await sleep(900);
  await evalJs(`(() => { const s = document.querySelectorAll('.controls select')[0]; s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(1000);
  await clickText('.tab', 'Table'); await sleep(900);
  await shot('netcdf3-table.png');
} else if (scenario === 'beamline') {
  await clickText('#tree .node', 'entry'); await sleep(600);
  await clickText('#tree .node', 'instrument'); await sleep(600);
  await clickText('#tree .node', 'detector'); await sleep(600);
  await clickText('#tree .node', 'image'); await sleep(1200);
  await shot('hdf5-image.png');
  await clickText('#tree .node', 'data'); await sleep(600);
  await clickText('#tree .node', 'spectrum'); await sleep(600);
  await clickText('.tab', 'Plot'); await sleep(1200);
  await shot('hdf5-spectrum.png');
}
console.log('errors on page:', await evalJs(`[...document.querySelectorAll('.err')].map(e => e.textContent).join(' | ')`));
await send('Target.closeTarget', { targetId: t.id }).catch(() => {});
ws.close(); session.dispose();
process.exit(0);
