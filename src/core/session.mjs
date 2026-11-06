// One session per open editor: validates webview messages, relays them to the worker thread,
// enforces a timeout per read, and restarts the worker when a read hangs.
import { validateRequest, DEFAULT_LIMITS } from './protocol.mjs';

export class Session {
  constructor({ createWorker, post, copy, limits = DEFAULT_LIMITS, timeoutMs = 20000, fileName }) {
    Object.assign(this, { createWorker, post, copy, limits, timeoutMs, fileName });
    this.seq = 1; this.calls = new Map(); this.worker = null; this.disposed = false; this.opened = null;
  }

  spawn() {
    const w = this.createWorker();
    this.worker = w;
    w.on('message', m => { const c = this.calls.get(m.id); if (!c) return; this.calls.delete(m.id); clearTimeout(c.timer); m.ok ? c.resolve(m.data) : c.reject(new Error(m.error)); });
    w.on('error', e => this.failAll(w, 'The reader stopped: ' + e.message));
    w.on('exit', () => this.failAll(w, 'The reader stopped.'));
    this.opened = this.call('open', {});
    return this.opened;
  }

  failAll(w, msg) {
    if (this.worker !== w) return;
    for (const c of this.calls.values()) { clearTimeout(c.timer); c.reject(new Error(msg)); }
    this.calls.clear();
    this.worker = null;
  }

  call(op, payload) {
    if (!this.worker) this.spawn();
    const id = this.seq++;
    const w = this.worker;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`This read took longer than ${Math.round(this.timeoutMs / 1000)} s and was stopped. Try a smaller slice; very large chunks must be read whole.`));
        if (this.worker === w) { this.worker = null; w.terminate(); }
      }, this.timeoutMs);
      this.calls.set(id, { resolve, reject, timer });
      w.postMessage({ id, op, ...payload });
    });
  }

  /** Called with the init message data once the webview says ready. */
  async init() {
    try {
      const o = await (this.opened || this.spawn());
      return { type: 'init', fileName: this.fileName, format: o.format, label: o.label, size: o.size };
    } catch (e) {
      return { type: 'init', fileName: this.fileName, error: e.message };
    }
  }

  async handle(msg) {
    if (this.disposed) return;
    const v = validateRequest(msg, this.limits);
    if (!v.ok) {
      if (msg && Number.isInteger(msg.reqId)) this.post({ type: 'result', reqId: msg.reqId, ok: false, error: v.error });
      return;
    }
    const r = v.req;
    if (r.type === 'ready') { this.post(await this.init()); return; }
    if (r.type === 'copy') { if (this.copy) await this.copy(r.text); return; }
    try {
      if (!this.worker) await this.spawn();
      const data = await this.call(r.type, r.type === 'read' ? { path: r.path, view: r.view, decode: r.decode } : { path: r.path });
      this.post({ type: 'result', reqId: r.reqId, ok: true, data });
    } catch (e) {
      this.post({ type: 'result', reqId: r.reqId, ok: false, error: e.message });
    }
  }

  async reload() {
    const w = this.worker; this.worker = null;
    if (w) { this.failAll(w, 'reloaded'); await w.terminate(); }
    this.opened = null;
    this.post({ type: 'reload' });
  }

  dispose() {
    this.disposed = true;
    const w = this.worker; this.worker = null;
    if (w) { this.failAll(w, 'closed'); w.terminate(); }
  }
}
