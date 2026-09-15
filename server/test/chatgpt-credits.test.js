import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchChatgptCredits } from '../core/chatgpt-credits.mjs';

function usageFetch(balance) {
  return async () =>
  new Response(JSON.stringify({ plan_type: 'plus', credits: { has_credits: true, unlimited: false, balance } }), {
    status: 200,
  });
}

test('余额换算：credits / 25 为美元（1000 credits → $40）', async () => {
  const result = await fetchChatgptCredits({ accessToken: 'at', fetchImpl: usageFetch(1000) });
  assert.equal(result.balance, 40);
});

test('余额换算：小数 credits 也除以 25', async () => {
  const result = await fetchChatgptCredits({ accessToken: 'at', fetchImpl: usageFetch(123.5) });
  assert.equal(result.balance, 4.94);
});

test('无 credits 字段 → balance 为 0', async () => {
  const result = await fetchChatgptCredits({
    accessToken: 'at',
    fetchImpl: async () => new Response(JSON.stringify({ plan_type: null }), { status: 200 }),
  });
  assert.equal(result.balance, 0);
});
