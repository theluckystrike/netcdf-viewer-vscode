import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, DEFAULT_LIMITS } from '../src/core/protocol.mjs';

test('valid messages pass and are normalised', () => {
  assert.deepEqual(validateRequest({ type: 'ready' }), { ok: true, req: { type: 'ready' } });
  const r = validateRequest({ type: 'read', reqId: 3, path: '/t2m', view: { rowAxis: 1, colAxis: 2, index: [4, 0, 0], rowCount: 100, colCount: 30 }, decode: true, purpose: 'plot' });
  assert.equal(r.ok, true);
  assert.equal(r.req.view.rowStep, 1);
  assert.equal(r.req.purpose, 'plot');
  assert.equal(validateRequest({ type: 'list', reqId: 1, path: '/' }).ok, true);
});

test('bad messages are refused with a reason', () => {
  for (const m of [null, 'x', { type: 'eval', code: '1' }, { type: 'list', path: '/' }, { type: 'list', reqId: 1, path: 'relative' },
    { type: 'info', reqId: 1, path: '/' + 'a'.repeat(5000) }, { type: 'read', reqId: 1, path: '/x', view: { rowStart: -1 } },
    { type: 'read', reqId: 1, path: '/x', view: { rowCount: 1.5 } }, { type: 'read', reqId: 1, path: '/x', view: { index: ['0'] } },
    { type: 'read', reqId: 1, path: '/x', view: { index: new Array(40).fill(0) } }, { type: 'copy', text: 5 }]) {
    const r = validateRequest(m);
    assert.equal(r.ok, false, JSON.stringify(m));
    assert.match(r.error, /\w/);
  }
});

test('size limit gives a clear message', () => {
  const r = validateRequest({ type: 'read', reqId: 1, path: '/x', view: { rowCount: 2000, colCount: 2000 } }, DEFAULT_LIMITS);
  assert.equal(r.ok, false);
  assert.match(r.error, /4000000 values.*limit is 1000000.*maxReadValues/);
});
