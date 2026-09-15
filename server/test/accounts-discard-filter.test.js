import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendDiscardedAtFilters, parseDiscardedAtRange } from '../modules/accounts/index.js';

test('废弃时间范围：规范化 ISO 起止时间', () => {
  const range = parseDiscardedAtRange({
    discarded_from: '2026-09-05T00:00:00+08:00',
    discarded_to: '2026-09-06T00:00:00+08:00',
  });
  assert.deepEqual(range, {
    from: '2026-09-04T16:00:00.000Z',
    to: '2026-09-05T16:00:00.000Z',
  });
});

test('废弃时间范围：允许只传单侧或完全不传', () => {
  assert.deepEqual(parseDiscardedAtRange({}), { from: null, to: null });
  assert.deepEqual(parseDiscardedAtRange({ discarded_from: '2026-09-05T00:00:00Z' }), {
    from: '2026-09-05T00:00:00.000Z',
    to: null,
  });
  assert.deepEqual(parseDiscardedAtRange({ discarded_to: '2026-09-06T00:00:00Z' }), {
    from: null,
    to: '2026-09-06T00:00:00.000Z',
  });
});

test('废弃时间范围：追加 SQL 条件使用左闭右开边界', () => {
  const filters = ['pool = ?'];
  const params = ['discard'];
  appendDiscardedAtFilters(filters, params, {
    discarded_from: '2026-09-05T00:00:00Z',
    discarded_to: '2026-09-06T00:00:00Z',
  });
  assert.deepEqual(filters, ['pool = ?', 'discarded_at >= ?', 'discarded_at < ?']);
  assert.deepEqual(params, ['discard', '2026-09-05T00:00:00.000Z', '2026-09-06T00:00:00.000Z']);
});

test('废弃时间范围：拒绝非法时间和无效区间', () => {
  assert.throws(() => parseDiscardedAtRange({ discarded_from: 'not-a-date' }), /discarded_from/);
  assert.throws(
    () => parseDiscardedAtRange({ discarded_from: '2026-09-06T00:00:00Z', discarded_to: '2026-09-06T00:00:00Z' }),
    /discarded_from 必须早于 discarded_to/,
  );
});
