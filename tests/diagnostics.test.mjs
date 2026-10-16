import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRun, inspectCall, extractPayload } from '../skills/mcd-mcp-clinic/scripts/lib/diagnostics.mjs';
import { DEMO_CASES } from '../skills/mcd-mcp-clinic/scripts/lib/demo.mjs';
import { redact, markdownReport } from '../skills/mcd-mcp-clinic/scripts/lib/redact.mjs';
const base = { storeCode: '1450713', beType: 1, orderType: 1 };
const quote = (input, extra = {}) => ({ tool: 'calculate-price', input, ...extra });
const codes = findings => findings.map(f => f.code);

test('healthy end-to-end fixture passes, failing fixtures locate the intended business problems', () => {
  assert.equal(analyzeRun(DEMO_CASES.find(c => c.id === 'healthy').run).findings.length, 0);
  assert.deepEqual(new Set(codes(analyzeRun(DEMO_CASES[0].run).findings)), new Set(['PRICE_UNIT', 'COUPON_STORE_CHECK']));
  assert.deepEqual(codes(analyzeRun(DEMO_CASES[1].run).findings), ['BE_CODE_REQUIRED']);
  assert.equal(analyzeRun(DEMO_CASES[3].run).findings[0].title, '认证失败');
});
test('malformed user input produces diagnostics instead of throwing', () => {
  assert.ok(codes(inspectCall({ tool: 'query-nearby-stores', input: { beType: 1, searchType: 2, city: 42, keyword: {} } })).includes('STORE_LOCATION'));
  assert.ok(codes(inspectCall(quote({ ...base, items: [null] }))).includes('CART_ITEM'));
});
for (const [beType, orderType] of [[5, 1], [2, 2], [6, 2]]) {
  test('business ' + beType + ' requires a paired beCode', () => {
    const input = { ...base, beType, orderType };
    assert.ok(codes(inspectCall({ tool: 'query-meals', input })).includes('BE_CODE_REQUIRED'));
    assert.equal(inspectCall({ tool: 'query-meals', input: { ...input, beCode: 'correct' } }).length, 0);
  });
}
test('channel mismatch and mismatched store binding are blocking errors', () => {
  const result = inspectCall({ tool: 'query-meals', input: { ...base, beType: 5, orderType: 2, beCode: 'wrong' } }, { storeBinding: { storeCode: base.storeCode, beCode: 'correct' } });
  assert.ok(codes(result).includes('CHANNEL_MISMATCH'));
  assert.ok(codes(result).includes('STORE_BINDING'));
  assert.ok(result.every(f => f.severity === 'error'));
});
test('reservation must be an actual calendar date and include time in booking context', () => {
  const run = reservationDate => inspectCall({ tool: 'query-meals', input: { ...base, reservationDate } }, { reservation: true });
  assert.ok(codes(run(undefined)).includes('RESERVATION_REQUIRED'));
  assert.ok(codes(run('2026-02-30 12:30')).includes('RESERVATION_FORMAT'));
  assert.ok(codes(run('2026-10-20 25:00')).includes('RESERVATION_FORMAT'));
  assert.equal(run('2026-10-20 12:30').length, 0);
});
test('quote conversion checks price in cents without confusing realDiscount in yuan', () => {
  const input = { ...base, items: [{ productCode: '1100', quantity: 1 }] };
  const good = quote(input, { output: { data: { price: 2550, enjoyable: { realDiscount: 5 } } }, meta: { displayedTotal: 25.5 } });
  assert.equal(inspectCall(good).length, 0);
  const bad = { ...good, meta: { displayedTotal: 2550 } };
  assert.deepEqual(codes(inspectCall(bad)), ['PRICE_UNIT']);
  assert.equal(inspectCall(bad)[0].after.displayedTotal, 25.5);
});
test('failed or stale-context store coupon calls do not count as successful validation', () => {
  const call = quote({ ...base, items: [{ productCode: '1100', quantity: 1, couponId: 'a', couponCode: 'b' }] });
  const check = { tool: 'query-store-coupons', input: base, output: { success: true, code: 200, data: [] } };
  assert.equal(inspectCall(call, {}, [check]).length, 0);
  for (const prior of [{ ...check, output: { success: false } }, { ...check, input: { ...base, reservationDate: '2026-10-20 12:00' } }, { ...check, output: null }]) {
    assert.ok(codes(inspectCall(call, {}, [prior])).includes('COUPON_STORE_CHECK'));
  }
});
test('current server schema validates nested required fields and numeric quantity', () => {
  const tools = [{ name: 'calculate-price', inputSchema: { type: 'object', required: ['storeCode', 'items'], properties: { storeCode: { type: 'string' }, items: { type: 'array', minItems: 1, items: { type: 'object', required: ['quantity'], properties: { quantity: { type: 'integer', minimum: 1 } } } } } } }];
  assert.ok(codes(inspectCall(quote({ ...base, items: [{ productCode: '1100', quantity: '2' }] }), {}, [], tools)).includes('SCHEMA'));
  assert.ok(codes(inspectCall({ tool: 'removed-tool', input: {} }, {}, [], tools)).includes('TOOL_NOT_FOUND'));
});
test('modification cancellation and combo choices are checked against recorded detail', () => {
  const detail = { tool: 'query-meal-detail', input: { ...base, code: 'combo' }, output: { data: { modification: { items: [{ values: [{ code: 'sauce', selectedKey: 'yes', unselectedKey: 'no', maxQuantity: 1 }] }] }, rounds: [{ id: 1, minQuantity: 1, maxQuantity: 1, choices: [{ code: 'burger', maxQuantity: 1 }] }] } } };
  const call = quote({ ...base, items: [{ productCode: 'combo', quantity: 1, modification: { values: [] }, roundList: [{ round: '1', comboItemList: [{ code: 'unlisted', quantity: 2 }] }] }] });
  const findings = inspectCall(call, {}, [detail]);
  for (const code of ['MODIFICATION_OMITTED', 'COMBO_QUANTITY', 'COMBO_CHOICE']) assert.ok(codes(findings).includes(code));
  call.input.items[0].modification.values = [{ code: 'sauce', key: 'no', quantity: 0 }];
  call.input.items[0].roundList[0].comboItemList = [{ code: 'burger', quantity: 1 }];
  assert.equal(inspectCall(call, {}, [detail]).length, 0);
});
test('MCP structured and text responses produce equivalent extracted business data', () => {
  const data = { success: false, code: 401, message: 'expired' };
  assert.deepEqual(extractPayload({ structuredContent: data }), data);
  assert.deepEqual(extractPayload({ content: [{ type: 'text', text: '# Original Response\n\n' + JSON.stringify(data) }] }), data);
  assert.deepEqual(extractPayload({ content: [{ type: 'text', text: '# Response\n' + JSON.stringify(data) + '\n# Display guidance' }] }), data);
  assert.ok(codes(inspectCall({ tool: 'now-time-info', input: {}, output: { structuredContent: data } })).includes('BUSINESS_ERROR'));
});
test('redaction removes credentials, private identifiers, phones and nested JSON text', () => {
  const secret = 'test-only-secret-abcdefghijkl';
  const input = { Authorization: 'Bearer ' + secret, note: 'Use Bearer ' + secret + ' contact example@example.test or 13800138000', couponCode: 'coupon-private', orderId: 'order-private', addressDetail: 'private place', content: [{ type: 'text', text: JSON.stringify({ mobilePhone: '13800138000', couponId: 'private-coupon', token: secret }) }], error: { message: secret }, productCode: '1100' };
  const safe = JSON.stringify(redact(input, [secret]));
  for (const privateValue of [secret, '13800138000', 'example@example.test', 'coupon-private', 'private-coupon', 'order-private', 'private place']) assert.ok(!safe.includes(privateValue), privateValue);
  assert.ok(safe.includes('1100'));
  const report = analyzeRun({ source: 'manual', calls: [{ tool: 'now-time-info', input: {}, output: input }] }, { secrets: [secret] });
  assert.ok(!markdownReport(report).includes(secret));
});
test('export and import retain diagnostic evidence while imported data is marked unverified', () => {
  const original = analyzeRun(DEMO_CASES[0].run);
  const imported = analyzeRun({ ...JSON.parse(JSON.stringify(original)), source: 'import' });
  assert.deepEqual(codes(imported.findings), codes(original.findings));
  assert.equal(imported.sourceLabel, '导入回放 · 未进行实时验证');
});
test('redaction handles private scalar fields inside JSON with surrounding prose', () => {
  const text = 'API response: {"lockerCode":"private-locker","userId":123456,"recipientName":"private-name","payH5Url":"https://private.example/pay"} Done.';
  const safe = JSON.stringify(redact({ content: [{ type: 'text', text }] }));
  for (const value of ['private-locker', '123456', 'private-name', 'private.example']) assert.ok(!safe.includes(value), value);
});
