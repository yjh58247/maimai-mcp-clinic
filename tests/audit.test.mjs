import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCall, analyzeRun } from '../skills/mcd-mcp-clinic/scripts/lib/diagnostics.mjs';
import { redact, markdownReport } from '../skills/mcd-mcp-clinic/scripts/lib/redact.mjs';
import { extractPayload } from '../skills/mcd-mcp-clinic/scripts/lib/context.mjs';
import { McpClient } from '../skills/mcd-mcp-clinic/scripts/lib/mcp-client.mjs';

const base = { storeCode: '1450713', beType: 1, orderType: 1 };
for (const reservationDate of [['2026-10-20 12:30'], {}, true, 123, '2026-02-30 12:30']) {
  test('invalid reservation values are diagnosed without throwing: ' + JSON.stringify(reservationDate), () => {
    assert.ok(inspectCall({ tool: 'query-meals', input: { ...base, reservationDate } }).some(f => f.code === 'RESERVATION_FORMAT'));
  });
}
test('schema checks every array element, numeric maxima and forbidden extra fields', () => {
  const tools = [{ name: 'now-time-info', inputSchema: { type: 'object', additionalProperties: false,
    properties: { values: { type: 'array', maxItems: 100, items: { type: 'integer', maximum: 5 } } } } }];
  const findings = inspectCall({ tool: 'now-time-info', input: { values: [...Array(100).fill(1), 'bad'], extra: true } }, {}, [], tools);
  const detail = findings.find(f => f.code === 'SCHEMA')?.detail || '';
  assert.ok(detail.includes('[100]')); assert.ok(detail.includes('extra'));
  assert.ok(inspectCall({ tool: 'now-time-info', input: { values: [6] } }, {}, [], tools).some(f => f.code === 'SCHEMA'));
});
test('independent invalid cart fields retain each concrete location', () => {
  const findings = inspectCall({ tool: 'calculate-price', input: { ...base, items: [0, 1].map(() => ({ productCode: '1100', quantity: 0 })) } });
  assert.equal(findings.filter(f => f.code === 'QUANTITY').length, 2);
});
test('non-numeric displayed amounts do not silently coerce to zero', () => {
  for (const displayedTotal of [false, '', [], {}, -1]) {
    assert.ok(inspectCall({ tool: 'calculate-price', input: { ...base, items: [{ productCode: '1100', quantity: 1 }] },
      output: { data: { price: 0 } }, meta: { displayedTotal } }).some(f => f.code === 'DISPLAYED_TOTAL'));
  }
});
test('redaction covers common sensitive key spellings and never leaks a configured secret in a key', () => {
  const secret = 'synthetic-key-credential-abcdef';
  const input = { coupon_code: 'private-coupon', user_id: 123456, phoneNumber: 13800138000,
    email_address: 'private-address-value', [secret]: 'value', storeCode: '1450713', productCode: '1100' };
  const safe = JSON.stringify(redact(input, [secret]));
  for (const privateValue of ['private-coupon', '123456', '13800138000', 'private-address-value', secret]) assert.ok(!safe.includes(privateValue), privateValue);
  assert.ok(safe.includes('1450713')); assert.ok(safe.includes('1100'));
});
test('JSON embedded in prose redacts private objects and arrays, preserving non-private evidence', () => {
  const text = 'Response: {"deliveryAddress":{"street":"private-street"},"coupon_code":["private-code"],"data":{"price":2550}}\nDone.';
  const safe = redact(text);
  assert.ok(!safe.includes('private-street')); assert.ok(!safe.includes('private-code')); assert.ok(safe.includes('2550'));
});
test('multiple JSON fragments do not hide the original business error', () => {
  assert.equal(extractPayload({ content: [{ type: 'text', text: 'Original: {"success":false,"code":401}\nGuidance: {"display":"text"}' }] }).code, 401);
});
test('Markdown export includes error details as escaped text', () => {
  const report = analyzeRun({ calls: [{ tool: 'now-time-info', input: {}, error: { status: 500, message: '<script>alert(1)</script> | reason' } }] });
  const md = markdownReport(report);
  const renderedText = md.split('```json')[0];
  assert.ok(renderedText.includes('reason')); assert.ok(!renderedText.includes('<script>')); assert.ok(renderedText.includes('&lt;script&gt;'));
});
test('429 supplies Retry-After guidance and releases the unread response body', async () => {
  let cancelled = false;
  const client = new McpClient({ token: 'synthetic-only', fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { status: 429, headers: { 'Retry-After': '12' } }) });
  await assert.rejects(client.rpc('tools/list', {}), error => error.status === 429 && error.retryAfter === 12 && error.message.includes('12'));
  assert.equal(cancelled, true);
});
test('a tool removed during session renewal is not sent again', async () => {
  let calls = 0;
  const client = new McpClient({ token: 'synthetic-only', fetchImpl: async (url, request) => {
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    const body = JSON.parse(request.body);
    if (body.method === 'tools/call') { calls++; return new Response(null, { status: 404 }); }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize'
      ? { protocolVersion: '2025-06-18' } : { tools: [{ name: 'query-meals' }] } }),
      { headers: { 'content-type': 'application/json', ...(body.method === 'initialize' ? { 'mcp-session-id': 'renewed' } : {}) } });
  } });
  client.session = 'old'; client.tools = [{ name: 'now-time-info' }];
  await assert.rejects(client.call('now-time-info', {}), /未发现/);
  assert.equal(calls, 1);
});
