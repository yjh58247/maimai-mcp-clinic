import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { inspectCall } from '../skills/mcd-mcp-clinic/scripts/lib/diagnostics.mjs';

const base = { storeCode: '1450713', beType: 1, orderType: 1 };
const modification = { items: [{ values: [{ code: 'sauce', selectedKey: 'yes', unselectedKey: 'no', maxQuantity: 1 }] }] };
const cancelled = { values: [{ code: 'sauce', key: 'no', quantity: 0 }] };
const detail = { tool: 'query-meal-detail', input: { ...base, code: 'combo' }, output: { data: {
  modification, rounds: [{ id: 'main', minQuantity: 1, maxQuantity: 1, choices: [{ code: 'burger', maxQuantity: 1, modification }] }],
} } };
const validItem = () => ({ productCode: 'combo', quantity: 1, modification: structuredClone(cancelled),
  roundList: [{ round: 'main', comboItemList: [{ code: 'burger', quantity: 1, modification: structuredClone(cancelled) }] }] });
const inspect = (item, previous = [detail]) => inspectCall({ tool: 'calculate-price', input: { ...base, items: [item] } }, {}, previous);

for (const [name, change, expected] of [
  ['omitted modification object', item => { delete item.modification; }, 'MODIFICATION_OMITTED'],
  ['omitted combo child modification', item => { delete item.roundList[0].comboItemList[0].modification; }, 'MODIFICATION_OMITTED'],
  ['omitted required round list', item => { delete item.roundList; }, 'COMBO_QUANTITY'],
  ['unknown round with all required choices present', item => { item.roundList.push({ round: 'invented', comboItemList: [{ code: 'burger', quantity: 1 }] }); }, 'COMBO_ROUND'],
  ['duplicate round', item => { item.roundList.push(structuredClone(item.roundList[0])); }, 'COMBO_DUPLICATE_ROUND'],
  ['duplicate modification key', item => { item.modification.values.push(structuredClone(item.modification.values[0])); }, 'MODIFICATION_DUPLICATE'],
  ['unknown modification key', item => { item.modification.values.push({ code: 'invented', key: 'yes', quantity: 1 }); }, 'MODIFICATION_CHOICE'],
]) test(name + ' is rejected with upstream detail evidence', () => {
  const item = validItem(); change(item);
  assert.ok(inspect(item).some(f => f.code === expected), expected);
});
test('valid combo and explicit cancellation remain accepted', () => assert.deepEqual(inspect(validItem()), []));
test('missing optional rounds and unknown definitions are not invented as errors', () => {
  const optional = structuredClone(detail); optional.output.data.rounds[0].minQuantity = 0;
  const item = validItem(); delete item.roundList;
  assert.deepEqual(inspect(item, [optional]), []);
  assert.deepEqual(inspect({ productCode: 'combo', quantity: 1 }, []), []);
});

const post = (url, path, body) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function withClient(client, run) {
  const { server } = createApp({ token: 'synthetic-only-credential', clientFactory: () => client });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run('http://127.0.0.1:' + server.address().port); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const client = (call, connect = async () => ({ protocolVersion: '2025-06-18' })) => ({
  tools: [{ name: 'now-time-info' }, { name: 'query-meals' }], call, connect,
});
for (const output of [
  { isError: true, content: [{ type: 'text', text: 'tool failed' }] },
  { structuredContent: { success: false, code: 401, message: 'expired' } },
  { content: [{ type: 'text', text: '{"code":500,"message":"business failure"}' }] },
]) test('connection check refuses tool/business errors and retains the failed response', async () => {
  await withClient(client(async () => output), async url => {
    const response = await post(url, '/api/live/connect', {});
    assert.equal(response.status, 502);
    const data = await response.json();
    assert.ok(data.report.findings.some(f => f.code === 'BUSINESS_ERROR'));
    assert.equal(data.report.calls[0].output.isError, output.isError);
    assert.equal((await (await fetch(url + '/api/status')).json()).connected, false);
  });
});
test('a live business error returns an error status and remains in the chain', async () => {
  await withClient(client(async name => name === 'now-time-info' ? { data: { date: '2026-10-17' } } : { success: false, code: 500 }), async url => {
    await post(url, '/api/live/connect', {});
    const response = await post(url, '/api/live/call', { tool: 'query-meals', input: base });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).report.calls.length, 2);
  });
});
test('a pending reconnect clears previous ready status and its call history', async () => {
  let count = 0, finish, started;
  const pending = new Promise(resolve => { finish = resolve; });
  const begun = new Promise(resolve => { started = resolve; });
  await withClient(client(async () => ({ data: {} }), async () => {
    if (++count > 1) { started(); await pending; throw new Error('simulated failure'); }
    return {};
  }), async url => {
    await post(url, '/api/live/connect', {});
    const reconnect = post(url, '/api/live/connect', {});
    await begun;
    try { assert.equal((await (await fetch(url + '/api/status')).json()).connected, false); }
    finally { finish(); await reconnect; }
    assert.equal((await post(url, '/api/live/call', { tool: 'now-time-info', input: {} })).status, 400);
  });
});
test('malformed or unsupported imported report versions return useful validation errors', async () => {
  await withClient(client(async () => ({})), async url => {
    const calls = [{ tool: 'now-time-info', input: {} }];
    for (const body of [
      { format: 'mcd-clinic-report', schemaVersion: 2, calls },
      { format: 'unrelated-report', schemaVersion: 1, calls },
      { calls: [{ tool: '', input: {} }] },
      { calls: [{ tool: 12, input: {} }] },
    ]) {
      const response = await post(url, '/api/analyze', body);
      assert.equal(response.status, 400);
      assert.equal(typeof (await response.json()).error, 'string');
    }
    assert.equal((await post(url, '/api/analyze', { format: 'mcd-clinic-report', schemaVersion: 1, calls })).status, 200);
  });
});

test('omitted combo selections are blocked before sending a real quote', async () => {
  let quotes = 0;
  const fake = client(async name => {
    if (name === 'query-meal-detail') return detail.output;
    if (name === 'calculate-price') quotes++;
    return { data: {} };
  });
  fake.tools.push({ name: 'query-meal-detail' }, { name: 'calculate-price' });
  await withClient(fake, async url => {
    await post(url, '/api/live/connect', {});
    await post(url, '/api/live/call', { tool: detail.tool, input: detail.input });
    const response = await post(url, '/api/live/call', { tool: 'calculate-price', input: { ...base, items: [{ productCode: 'combo', quantity: 1 }] } });
    assert.equal(response.status, 422); assert.equal(quotes, 0);
    const codes = (await response.json()).report.findings.map(f => f.code);
    assert.ok(codes.includes('MODIFICATION_OMITTED')); assert.ok(codes.includes('COMBO_QUANTITY'));
  });
});
