// Validates messages from the webview. The webview is treated as untrusted input:
// every field is type-checked and clamped before it reaches the worker.

export const DEFAULT_LIMITS = { maxReadValues: 1_000_000, maxPathLength: 4096, maxDims: 32, maxPage: 2000 };

const isStr = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max;
const int = (v, lo, hi, dflt) => { if (v === undefined) return dflt; if (!Number.isInteger(v) || v < lo || v > hi) throw new Error('bad number'); return v; };

/** Returns { ok: true, req } or { ok: false, error }. */
export function validateRequest(msg, limits = DEFAULT_LIMITS) {
  try {
    if (!msg || typeof msg !== 'object') throw new Error('not an object');
    switch (msg.type) {
      case 'ready': return { ok: true, req: { type: 'ready' } };
      case 'copy':
        if (typeof msg.text !== 'string' || msg.text.length > 100_000) throw new Error('bad text');
        return { ok: true, req: { type: 'copy', text: msg.text } };
      case 'list': case 'info': {
        const reqId = int(msg.reqId, 0, 2 ** 31, undefined);
        if (reqId === undefined) throw new Error('missing reqId');
        if (!isStr(msg.path, limits.maxPathLength) || msg.path[0] !== '/') throw new Error('bad path');
        return { ok: true, req: { type: msg.type, reqId, path: msg.path } };
      }
      case 'read': {
        const reqId = int(msg.reqId, 0, 2 ** 31, undefined);
        if (reqId === undefined) throw new Error('missing reqId');
        if (!isStr(msg.path, limits.maxPathLength) || msg.path[0] !== '/') throw new Error('bad path');
        const v = msg.view || {};
        const BIG = Number.MAX_SAFE_INTEGER;
        const index = Array.isArray(v.index) ? v.index : [];
        if (index.length > limits.maxDims || !index.every(x => Number.isInteger(x) && x >= 0 && x <= BIG)) throw new Error('bad index');
        const view = {
          rowAxis: int(v.rowAxis, 0, limits.maxDims - 1, 0),
          colAxis: int(v.colAxis, -1, limits.maxDims - 1, -1),
          index,
          rowStart: int(v.rowStart, 0, BIG, 0), rowCount: int(v.rowCount, 0, BIG, 100),
          colStart: int(v.colStart, 0, BIG, 0), colCount: int(v.colCount, 0, BIG, 1),
          rowStep: int(v.rowStep, 1, BIG, 1), colStep: int(v.colStep, 1, BIG, 1),
        };
        if (view.rowCount * Math.max(1, view.colCount) > limits.maxReadValues) {
          return { ok: false, error: `This read asks for ${view.rowCount * Math.max(1, view.colCount)} values. The limit is ${limits.maxReadValues} (setting hdf5NetcdfExplorer.maxReadValues).` };
        }
        return { ok: true, req: { type: 'read', reqId, path: msg.path, view, decode: msg.decode !== false, purpose: msg.purpose === 'plot' ? 'plot' : 'table' } };
      }
      case 'export': {
        // Export the whole slice that is on screen. Only the axes and the fixed indices come from the webview;
        // the host reads the shape itself, and the user picks the file in a save dialog.
        const reqId = int(msg.reqId, 0, 2 ** 31, undefined);
        if (reqId === undefined) throw new Error('missing reqId');
        if (!isStr(msg.path, limits.maxPathLength) || msg.path[0] !== '/') throw new Error('bad path');
        const v = msg.view || {};
        const index = Array.isArray(v.index) ? v.index : [];
        if (index.length > limits.maxDims || !index.every(x => Number.isInteger(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER)) throw new Error('bad index');
        const view = { rowAxis: int(v.rowAxis, 0, limits.maxDims - 1, 0), colAxis: int(v.colAxis, -1, limits.maxDims - 1, -1), index };
        if (view.colAxis === view.rowAxis) throw new Error('bad axes');
        return { ok: true, req: { type: 'export', reqId, path: msg.path, view, decode: msg.decode !== false } };
      }
      default: throw new Error('unknown type');
    }
  } catch (e) {
    return { ok: false, error: 'Invalid request: ' + e.message };
  }
}
