import test from 'node:test';
import assert from 'node:assert/strict';
import { McpClient } from '../skills/mcd-mcp-clinic/scripts/lib/mcp-client.mjs';
const token = 'test-only-credential';
const jsonResponse = (id, result, headers = {}) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json', ...headers } });

test('initialize, initialized notification, paginated discovery and calls preserve session/version', async () => {
  const requests = [];
  const client = new McpClient({ token, fetchImpl: async (url, request) => {
    assert.equal(url, 'https://mcp.mcd.cn'); assert.equal(request.redirect, 'error');
    const body = JSON.parse(request.body); requests.push(body);
    if (body.method === 'initialize') return jsonResponse(body.id, { protocolVersion: '2025-06-18', serverInfo: { name: 'test-server' } }, { 'mcp-session-id': 'session-test' });
    assert.equal(request.headers['Mcp-Session-Id'], 'session-test');
    assert.equal(request.headers['MCP-Protocol-Version'], '2025-06-18');
    assert.ok(request.headers.Accept.includes('text/event-stream'));
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') return jsonResponse(body.id, body.params.cursor ? { tools: [{ name: 'query-meals' }] } : { tools: [{ name: 'now-time-info' }], nextCursor: 'page-two' });
    return jsonResponse(body.id, { content: [{ type: 'text', text: '{"data":{"date":"2026-10-16"}}' }] });
  } });
  const connected = await client.connect();
  assert.equal(connected.tools.length, 2);
  const result = await client.call('now-time-info', {});
  assert.ok(result.content[0].text.includes('2026-10-16'));
  assert.equal(requests.filter(r => r.method === 'tools/list').length, 2);
});
test('SSE parser handles chunk boundaries, notifications and cancels a stream after matching response', async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({ start(controller) {
    for (const chunk of [': keepalive\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r', '\n\r\ndata: {"jsonrpc":"2.0","id":1,"res', 'ult":{"tools":[]}}\r\n\r\n']) controller.enqueue(encoder.encode(chunk));
  }, cancel() { cancelled = true; } });
  const client = new McpClient({ token, fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) });
  assert.deepEqual(await client.rpc('tools/list', {}), { tools: [] });
  assert.equal(cancelled, true);
});
test('mutation tools are rejected before making a network call', async () => {
  let requests = 0;
  const client = new McpClient({ token, fetchImpl: async () => { requests++; } });
  for (const name of ['create-order', 'auto-bind-coupons', 'draw-lottery', 'mall-create-order']) await assert.rejects(client.call(name, {}), error => error.status === 403);
  assert.equal(requests, 0);
});
test('HTTP 429 is not automatically retried', async () => {
  let requests = 0;
  const client = new McpClient({ token, fetchImpl: async () => { requests++; return new Response('rate limit', { status: 429 }); } });
  client.tools = [{ name: 'now-time-info' }];
  await assert.rejects(client.call('now-time-info', {}), error => error.status === 429);
  assert.equal(requests, 1);
});
test('expired read-only session is reinitialized and retried once', async () => {
  let initializeCount = 0, callCount = 0;
  const client = new McpClient({ token, fetchImpl: async (url, request) => {
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    const body = JSON.parse(request.body);
    if (body.method === 'initialize') { initializeCount++; return jsonResponse(body.id, { protocolVersion: '2025-03-26' }, { 'mcp-session-id': 'renewed' }); }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') return jsonResponse(body.id, { tools: [{ name: 'now-time-info' }] });
    callCount++;
    return callCount === 1 ? new Response(null, { status: 404 }) : jsonResponse(body.id, { data: { ok: true } });
  } });
  client.session = 'old'; client.tools = [{ name: 'now-time-info' }];
  assert.deepEqual(await client.call('now-time-info', {}), { data: { ok: true } });
  assert.equal(initializeCount, 1); assert.equal(callCount, 2);
});
test('request timeout aborts the fetch and produces a useful diagnostic', async () => {
  const client = new McpClient({ token, timeoutMs: 20, fetchImpl: async (url, request) => new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  await assert.rejects(client.rpc('tools/list', {}), error => error.status === 408);
});
test('mismatched response IDs and JSON-RPC errors cannot be mistaken for success', async () => {
  const wrong = new McpClient({ token, fetchImpl: async () => jsonResponse(999, {}) });
  await assert.rejects(wrong.rpc('tools/list', {}), /ID/);
  const rpcError = new McpClient({ token, fetchImpl: async () => new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad params"}}', { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(rpcError.rpc('tools/list', {}), error => error.status === -32602);
});

test('failed discovery clears old tools and closes both previous and partial sessions', async () => {
  const deleted = [];
  const client = new McpClient({ token, fetchImpl: async (url, request) => {
    if (request.method === 'DELETE') { deleted.push(request.headers['Mcp-Session-Id']); return new Response(null, { status: 204 }); }
    const body = JSON.parse(request.body);
    if (body.method === 'initialize') return jsonResponse(body.id, { protocolVersion: '2025-06-18' }, { 'mcp-session-id': 'partial' });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return new Response(null, { status: 503 });
  } });
  client.session = 'old'; client.tools = [{ name: 'now-time-info' }];
  await assert.rejects(client.connect(), error => error.status === 503);
  assert.deepEqual(client.tools, []); assert.equal(client.session, null);
  assert.deepEqual(deleted, ['old', 'partial']);
});
for (const invalid of [null, { tools: [null] }, { tools: [{ name: '' }] }]) {
  test('malformed discovery data is rejected without leaving usable stale tools', async () => {
    const client = new McpClient({ token, fetchImpl: async (url, request) => {
      const body = JSON.parse(request.body);
      if (body.method === 'initialize') return jsonResponse(body.id, { protocolVersion: '2025-06-18' });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return jsonResponse(body.id, invalid);
    } });
    client.tools = [{ name: 'now-time-info' }];
    await assert.rejects(client.connect(), /有效的工具数组/);
    assert.deepEqual(client.tools, []);
  });
}
test('a repeated tools/list cursor stops pagination immediately', async () => {
  let pages = 0;
  const client = new McpClient({ token, fetchImpl: async (url, request) => {
    const body = JSON.parse(request.body);
    if (body.method === 'initialize') return jsonResponse(body.id, { protocolVersion: '2025-06-18' });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    pages++; return jsonResponse(body.id, { tools: [{ name: 'now-time-info' }], nextCursor: 'repeated' });
  } });
  await assert.rejects(client.connect(), /游标/);
  assert.equal(pages, 2); assert.deepEqual(client.tools, []);
});
