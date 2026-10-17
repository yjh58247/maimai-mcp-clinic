import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCall } from '../skills/mcd-mcp-clinic/scripts/lib/diagnostics.mjs';
import { McpClient } from '../skills/mcd-mcp-clinic/scripts/lib/mcp-client.mjs';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

const inspect = (input, properties) => inspectCall({ tool: 'now-time-info', input }, {}, [], [
  { name: 'now-time-info', inputSchema: { type: 'object', properties } },
]);
test('schema string lengths count Unicode code points rather than UTF-16 units', () => {
  assert.deepEqual(inspect({ keyword: '🍔' }, { keyword: { type: 'string', maxLength: 1 } }), []);
  assert.ok(inspect({ keyword: '🍔' }, { keyword: { type: 'string', minLength: 2 } }).some(f => f.code === 'SCHEMA'));
  assert.deepEqual(inspect({ keyword: '汉🍔' }, { keyword: { type: 'string', minLength: 2, maxLength: 2 } }), []);
});
test('schema validates typed additional properties including nested required fields', () => {
  const schema = { extras: { type: 'object', additionalProperties: { type: 'object', required: ['quantity'],
    properties: { quantity: { type: 'integer', minimum: 1 } } } } };
  assert.deepEqual(inspect({ extras: { first: { quantity: 1 } } }, schema), []);
  for (const value of [{ quantity: '1' }, {}, { quantity: 0 }]) {
    const result = inspect({ extras: { first: value } }, schema);
    assert.ok(result.some(f => f.code === 'SCHEMA' && f.detail.includes('extras.first')));
  }
});
test('schema diagnostics stay bounded for an invalid array below the one-megabyte input limit', () => {
  const input = { counts: Array(150_000).fill(0) };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 1_000_000);
  const result = inspect(input, { counts: { type: 'array', items: { type: 'integer', minimum: 1 } } });
  assert.ok(result.some(f => f.code === 'SCHEMA'));
  assert.ok(JSON.stringify(result).length < 4000);
});
test('bounded error collection still detects an invalid entry at the end of a long valid array', () => {
  const input = { counts: Array(150_000).fill(1) }; input.counts[149_999] = 0;
  const result = inspect(input, { counts: { type: 'array', items: { type: 'integer', minimum: 1 } } });
  assert.ok(result.some(f => f.code === 'SCHEMA' && f.detail.includes('counts[149999]')));
});
test('pattern properties are validated and are not incorrectly treated as additional fields', () => {
  const data = { type: 'object', patternProperties: { '^label-': { type: 'string' } }, additionalProperties: { type: 'integer' } };
  assert.deepEqual(inspect({ data: { 'label-name': 'allowed', count: 1 } }, { data }), []);
  assert.deepEqual(inspect({ data: { 'label-name': 'allowed' } }, { data: { ...data, additionalProperties: false } }), []);
  assert.ok(inspect({ data: { 'label-name': 1 } }, { data }).some(f => f.code === 'SCHEMA'));
  assert.ok(inspect({ data: { count: '1' } }, { data }).some(f => f.code === 'SCHEMA'));
  assert.ok(inspect({ data: { 'label-name': 'text' } }, { data: { ...data, properties: { 'label-name': { type: 'integer' } } } }).some(f => f.code === 'SCHEMA'));
});
test('invalid pattern definitions produce a diagnostic rather than crashing validation', () => {
  assert.ok(inspect({ data: {} }, { data: { type: 'object', patternProperties: { '[': { type: 'string' } } } })
    .some(f => f.code === 'SCHEMA' && f.detail.includes('工具定义')));
});
test('large invalid schema input is rejected with 422 before a real tool call', async () => {
  let calls = 0;
  const client = { tools: [{ name: 'now-time-info', inputSchema: { type: 'object', properties: {
    counts: { type: 'array', items: { type: 'integer', minimum: 1 } },
  } } }], connect: async () => ({}), close: async () => {}, call: async () => { calls++; return { data: {} }; } };
  const app = createApp({ token: 'synthetic-only', clientFactory: () => client });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const post = (path, body) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/live/connect', {})).status, 200);
    const response = await post('/api/live/call', { tool: 'now-time-info', input: { counts: Array(150_000).fill(0) } });
    assert.equal(response.status, 422); assert.equal(calls, 1);
    assert.ok((await response.json()).report.findings.some(f => f.code === 'SCHEMA'));
  } finally {
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await app.close();
  }
});

const rpcResponse = (id, result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }),
  { headers: { 'content-type': 'application/json' } });
test('a JSON-RPC application error with code 404 does not renew the HTTP session or retry a tool', async () => {
  let initializations = 0, calls = 0;
  const client = new McpClient({ token: 'synthetic-only', fetchImpl: async (url, request) => {
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    const body = JSON.parse(request.body);
    if (body.method === 'initialize') { initializations++; return rpcResponse(body.id, { protocolVersion: '2025-06-18' }); }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') return rpcResponse(body.id, { tools: [{ name: 'now-time-info' }] });
    calls++;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: 404, message: 'application-level missing data' } }),
      { headers: { 'content-type': 'application/json' } });
  } });
  client.session = 'existing'; client.tools = [{ name: 'now-time-info' }];
  await assert.rejects(client.call('now-time-info', {}), error => error.status === 404 && /JSON-RPC/.test(error.message));
  assert.equal(initializations, 0); assert.equal(calls, 1); assert.equal(client.session, 'existing');
});
test('SSE handles carriage-return line endings and split CRLF without inventing an event boundary', async () => {
  for (const chunks of [
    ['data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\r\r'],
    ['data: {"jsonrpc":"2.0",\r', '\ndata: "id":1,"result":{"ok":true}}\r', '\n\r', '\n'],
  ]) {
    const body = new ReadableStream({ start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    } });
    const client = new McpClient({ token: 'synthetic-only', fetchImpl: async () => new Response(body,
      { headers: { 'content-type': 'text/event-stream' } }) });
    assert.deepEqual(await client.rpc('tools/list', {}), { ok: true });
  }
});
test('closing an MCP session releases an unread DELETE response body', async () => {
  let cancelled = false;
  const client = new McpClient({ token: 'synthetic-only', fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; },
  })) });
  client.session = 'existing';
  await client.close();
  assert.equal(cancelled, true); assert.equal(client.session, null);
});
