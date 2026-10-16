import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApp } from '../server.mjs';

async function withApp(options, run) {
  const { server } = createApp(options);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  try { await run(url); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const post = (url, path, body, headers = {}) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('static app and offline API work without a Token', async () => withApp({}, async url => {
  const home = await fetch(url);
  assert.equal(home.status, 200); assert.ok((await home.text()).includes('麦麦'));
  assert.ok(home.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  const shared = await fetch(url + '/context.mjs');
  assert.equal(shared.status, 200);
  assert.ok(shared.headers.get('content-type').startsWith('text/javascript'));
  assert.ok((await shared.text()).includes('sameBusinessContext'));
  assert.equal((await fetch(url + '/skills/mcd-mcp-clinic/scripts/lib/context.mjs')).status, 404);
  const demos = await (await fetch(url + '/api/demos')).json(); assert.equal(demos.cases.length, 4);
  const healthy = await (await post(url, '/api/demo', { caseId: 'healthy' })).json();
  assert.equal(healthy.report.summary.passed, 6);
  const noToken = await post(url, '/api/live/connect', {}); assert.equal(noToken.status, 400);
  assert.equal((await (await fetch(url + '/api/status')).json()).tokenConfigured, false);
}));
test('foreign origins, rebinding hosts, private files and mutation calls are rejected', async () => withApp({}, async url => {
  assert.equal((await post(url, '/api/analyze', {}, { Origin: 'https://outside.example' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => { http.get(url + '/api/status', { headers: { Host: 'outside.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject); });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(url + '/.env')).status, 404);
  assert.equal((await fetch(url + '/server.mjs')).status, 404);
  assert.equal((await post(url, '/api/live/call', { tool: 'create-order', input: {} })).status, 403);
}));
test('imported reports are rechecked, redacted, and cannot assert live provenance', async () => withApp({ token: 'test-server-token-abcdef' }, async url => {
  const response = await post(url, '/api/analyze', { source: 'live', calls: [{ tool: 'now-time-info', input: {}, output: { token: 'test-server-token-abcdef', orderId: 'private-order' } }] });
  const text = await response.text();
  assert.ok(!text.includes('test-server-token-abcdef')); assert.ok(!text.includes('private-order'));
  assert.equal(JSON.parse(text).report.source, 'manual');
  const status = await (await fetch(url + '/api/status')).text(); assert.ok(!status.includes('test-server-token-abcdef'));
}));
test('invalid JSON, nonobject bodies and oversized imports are handled explicitly', async () => withApp({}, async url => {
  assert.equal((await post(url, '/api/analyze', [])).status, 400);
  assert.equal((await post(url, '/api/analyze', { calls: [null] })).status, 400);
  assert.equal((await post(url, '/api/analyze', { calls: [], padding: 'x'.repeat(1_000_000) })).status, 413);
  assert.equal((await fetch(url + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ broken' })).status, 400);
}));
test('preflight blocks bad requests before calling MCP; valid results are redacted', async () => {
  let toolCalls = 0;
  const tools = [{ name: 'now-time-info' }, { name: 'query-meals', inputSchema: { type: 'object', required: ['storeCode', 'beType', 'orderType'] } }];
  const client = { tools, connect: async () => ({ protocolVersion: '2025-06-18' }), call: async name => { toolCalls++; return { data: { date: '2026-10-16', token: 'server-private-credential', tool: name } }; } };
  await withApp({ token: 'server-private-credential', clientFactory: () => client }, async url => {
    assert.equal((await post(url, '/api/live/connect', {})).status, 200);
    assert.equal(toolCalls, 1);
    const blocked = await post(url, '/api/live/call', { tool: 'query-meals', input: { storeCode: '1450713', beType: 5, orderType: 1 } });
    assert.equal(blocked.status, 422); assert.equal(toolCalls, 1);
    const accepted = await post(url, '/api/live/call', { tool: 'query-meals', input: { storeCode: '1450713', beType: 1, orderType: 1 } });
    assert.equal(accepted.status, 200); assert.equal(toolCalls, 2);
    assert.ok(!(await accepted.text()).includes('server-private-credential'));
  });
});
test('nested malformed parameters produce reports and are blocked before real tool calls', async () => {
  let calls = 0;
  const base = { storeCode: '1450713', beType: 1, orderType: 1 };
  const detail = { modification: { items: [{ values: [{ code: 'sauce', selectedKey: 'yes', unselectedKey: 'no' }] }] },
    rounds: [{ id: 1, minQuantity: 1, maxQuantity: 1, choices: [{ code: 'burger' }] }] };
  const client = { tools: ['now-time-info', 'query-meal-detail', 'calculate-price'].map(name => ({ name })),
    connect: async () => ({ protocolVersion: '2025-06-18' }),
    call: async name => { calls++; return { success: true, code: 200, data: name === 'query-meal-detail' ? detail : {} }; } };
  await withApp({ token: 'synthetic-credential', clientFactory: () => client }, async url => {
    await post(url, '/api/live/connect', {});
    const prior = { tool: 'query-meal-detail', input: { ...base, code: 'combo' }, output: { data: detail } };
    await post(url, '/api/live/call', { tool: prior.tool, input: prior.input });
    const before = calls;
    for (const extra of [
      { modification: { values: [null] } },
      { roundList: [{ round: '1', comboItemList: 'invalid' }] },
      { roundList: [{ round: '1', comboItemList: [null] }] },
    ]) {
      const request = { tool: 'calculate-price', input: { ...base, items: [{ productCode: 'combo', quantity: 1, ...extra }] } };
      const analyzed = await post(url, '/api/analyze', { calls: [prior, request] });
      assert.equal(analyzed.status, 200);
      assert.ok((await analyzed.json()).report.summary.errors > 0);
      const blocked = await post(url, '/api/live/call', request);
      assert.equal(blocked.status, 422);
      assert.ok((await blocked.json()).report.summary.errors > 0);
      assert.equal(calls, before);
    }
  });
});
test('switching channels preserves valid history and still blocks mismatched business codes', async () => {
  let calls = 0;
  const storeCode = '1450713';
  const client = {
    tools: ['now-time-info', 'query-nearby-stores', 'delivery-query-stores', 'query-meals'].map(name => ({ name })),
    connect: async () => ({ protocolVersion: '2025-06-18' }),
    call: async name => {
      calls++;
      return { success: true, code: 200, data: name === 'query-nearby-stores' ? [{ storeCode, beCode: 'drive-code' }]
        : name === 'delivery-query-stores' ? [{ storeCode, beCode: 'delivery-code' }] : {} };
    },
  };
  await withApp({ token: 'synthetic-credential', clientFactory: () => client }, async url => {
    await post(url, '/api/live/connect', {});
    for (const request of [
      { tool: 'query-nearby-stores', input: { beType: 5, searchType: 2, city: '演示城市', keyword: '演示门店' } },
      { tool: 'query-meals', input: { storeCode, beType: 5, orderType: 1, beCode: 'drive-code' } },
      { tool: 'delivery-query-stores', input: { beType: 2 } },
      { tool: 'query-meals', input: { storeCode, beType: 2, orderType: 2, beCode: 'delivery-code' } },
    ]) {
      const response = await post(url, '/api/live/call', request);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).report.summary.errors, 0);
    }
    const before = calls;
    const wrong = await post(url, '/api/live/call', { tool: 'query-meals', input: { storeCode, beType: 5, orderType: 1, beCode: 'wrong-code' } });
    assert.equal(wrong.status, 422);
    assert.equal(calls, before);
    const blockedReport = (await wrong.json()).report;
    assert.ok(blockedReport.findings.some(finding => finding.code === 'STORE_BINDING'));
  });
});
