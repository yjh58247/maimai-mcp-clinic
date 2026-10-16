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
