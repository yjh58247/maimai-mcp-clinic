import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { findMatchingCall, selectionFromTrace, requestTemplate } from '../skills/mcd-mcp-clinic/scripts/lib/context.mjs';
import { inspectCall } from '../skills/mcd-mcp-clinic/scripts/lib/diagnostics.mjs';

const base = { storeCode: '1450713', beType: 1, orderType: 1 };
const ok = (tool, input, data) => ({ tool, input, output: { success: true, code: 200, data } });
const store = () => ok('query-nearby-stores', { beType: 1, searchType: 2 }, [{ storeCode: base.storeCode }]);
const menu = () => ok('query-meals', base, { meals: { combo: { name: '演示套餐' } } });
const detail = () => ok('query-meal-detail', { ...base, code: 'combo' }, {
  modification: { items: [{ values: [{ code: 'sauce', selectedKey: 'yes', unselectedKey: 'no', selectedQuantity: 1 }] }] },
  rounds: [{ id: 'main', minQuantity: 1, maxQuantity: 1, choices: [{ code: 'burger', isDefault: 1, quantity: 1 }] }],
});
const quote = items => ({ tool: 'calculate-price', input: { ...base, items } });
const item = extra => ({ productCode: 'combo', quantity: 1, ...extra });
test('failed refresh of the same menu clears selectable products instead of silently using old success', () => {
  const failed = { tool: 'query-meals', input: base, error: { status: 503 } };
  assert.deepEqual(selectionFromTrace([store(), menu(), failed]).products, []);
});
test('failed refresh of the same product cannot provide older modification and combo defaults', () => {
  const failed = { ...detail(), output: { success: false, code: 503 } };
  const generated = requestTemplate({ ...base, items: [item()] }, { context: base, productCode: 'combo', calls: [detail(), failed] });
  assert.equal(generated.items[0].modification, undefined);
  assert.equal(generated.items[0].roundList, undefined);
});
test('failed coupon refresh does not count an older success as current verification', () => {
  const prior = ok('query-store-coupons', base, []);
  const failed = { ...prior, error: { status: 503 } };
  const findings = inspectCall(quote([item({ couponId: 'synthetic-id', couponCode: 'synthetic-code' })]), {}, [prior, failed]);
  assert.ok(findings.some(f => f.code === 'COUPON_STORE_CHECK'));
});
test('latest failed store search clears selectors rather than reverting to the prior channel', () => {
  const failed = { tool: 'query-nearby-stores', input: { beType: 5, searchType: 2 }, error: { status: 503 } };
  const selected = selectionFromTrace([store(), menu(), failed]);
  assert.deepEqual(selected.stores, []); assert.deepEqual(selected.products, []);
});
test('successful quote responses require a finite nonnegative numeric price', () => {
  for (const price of ['2550', null, -1, Infinity, false, {}, undefined]) {
    const findings = inspectCall({ ...quote([item()]), output: { success: true, code: 200, data: { price } } });
    assert.ok(findings.some(f => f.code === 'QUOTE_AMOUNT'), String(price));
  }
});
test('each incomplete coupon pair has its own cart location', () => {
  const findings = inspectCall(quote([item({ couponId: 'synthetic-a' }), item({ couponId: 'synthetic-b' })]));
  const pairs = findings.filter(f => f.code === 'COUPON_PAIR');
  assert.equal(pairs.length, 2);
  assert.ok(pairs[0].detail.includes('items[0]')); assert.ok(pairs[1].detail.includes('items[1]'));
});
test('unknown combo choices retain every separate cart location', () => {
  const invalid = () => item({ roundList: [{ round: 'main', comboItemList: [{ code: 'unknown', quantity: 1 }] }] });
  const findings = inspectCall(quote([invalid(), invalid()]), {}, [detail()]);
  const choices = findings.filter(f => f.code === 'COMBO_CHOICE');
  assert.equal(choices.length, 2);
  assert.ok(choices[0].detail.includes('items[0]')); assert.ok(choices[1].detail.includes('items[1]'));
});
test('invalid modification keys retain every separate cart location', () => {
  const invalid = () => item({ modification: { values: [{ code: 'sauce', key: 'wrong', quantity: 1 }] } });
  const findings = inspectCall(quote([invalid(), invalid()]), {}, [detail()]);
  const keys = findings.filter(f => f.code === 'MODIFICATION_KEY');
  assert.equal(keys.length, 2);
  assert.ok(keys[0].detail.includes('items[0]')); assert.ok(keys[1].detail.includes('items[1]'));
});
test('CLI transport failures return exit code 1 while still emitting a diagnostic JSON report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinic-cli-network-'));
  const mock = join(directory, 'fetch.mjs');
  try {
    await writeFile(mock, `globalThis.fetch = async (url, request) => {
      if (request.method === 'DELETE') return new Response(null, {status:204});
      const body = JSON.parse(request.body);
      if (body.method === 'notifications/initialized') return new Response(null,{status:202});
      if (body.method === 'tools/call') return process.env.CLINIC_TEST_BUSINESS
        ? new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{success:false,code:503}}),{headers:{'content-type':'application/json'}})
        : new Response(null,{status:503});
      return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:body.method === 'initialize'
        ? {protocolVersion:'2025-06-18'} : {tools:[{name:'now-time-info'}]}}),{headers:{'content-type':'application/json'}});
    };`);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, resolve(import.meta.dirname, '../skills/mcd-mcp-clinic/scripts/clinic.mjs'), 'connect', '--json'],
      { encoding: 'utf8', env: { ...process.env, MCD_MCP_TOKEN: 'synthetic-only', CLINIC_TEST_BUSINESS: '' }, windowsHide: true });
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).findings.some(f => f.code === 'TOOL_ERROR'));
    const business = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, resolve(import.meta.dirname, '../skills/mcd-mcp-clinic/scripts/clinic.mjs'), 'connect', '--json'],
      { encoding: 'utf8', env: { ...process.env, MCD_MCP_TOKEN: 'synthetic-only', CLINIC_TEST_BUSINESS: '1' }, windowsHide: true });
    assert.equal(business.status, 2);
    assert.ok(JSON.parse(business.stdout).findings.some(f => f.code === 'BUSINESS_ERROR'));
  } finally { await unlink(mock); await rmdir(directory); }
});
test('parameter-only checks do not invalidate recorded success', () => {
  const prior = detail();
  const dryRun = { tool: prior.tool, input: prior.input, note: '未发送到 MCP。' };
  assert.equal(findMatchingCall([prior, dryRun], prior.tool, base), prior);
  const currentMenu = menu();
  assert.equal(selectionFromTrace([store(), currentMenu, { tool: currentMenu.tool, input: currentMenu.input }]).products.length, 1);
});
test('a failed refresh for another product or channel does not invalidate matching evidence', () => {
  const prior = detail();
  for (const input of [{ ...prior.input, code: 'other' }, { ...prior.input, beType: 5, beCode: 'other-channel' }]) {
    assert.equal(findMatchingCall([prior, { tool: prior.tool, input, error: { status: 503 } }], prior.tool, base,
      call => call.input?.code === 'combo'), prior);
  }
});
test('successful refresh restores the latest menu and product defaults', () => {
  const latest = detail(); latest.output.data.modification.items[0].values[0].selectedKey = 'fresh';
  const calls = [store(), menu(), detail(), { tool: 'query-meal-detail', input: detail().input, error: { status: 503 } }, latest];
  const generated = requestTemplate({ ...base, items: [item()] }, { context: base, productCode: 'combo', calls });
  assert.equal(generated.items[0].modification.values[0].key, 'fresh');
  assert.equal(selectionFromTrace([store(), { tool: 'query-meals', input: base, error: { status: 503 } }, menu()]).products.length, 1);
});
test('zero quotes, parameter-only checks and existing business failures retain correct classifications', () => {
  const request = quote([item()]);
  assert.deepEqual(inspectCall({ ...request, output: { data: { price: 0 } }, meta: { displayedTotal: 0 } }), []);
  assert.deepEqual(inspectCall(request), []);
  const failed = inspectCall({ ...request, output: { success: false, code: 503, data: {} } });
  assert.ok(failed.some(f => f.code === 'BUSINESS_ERROR'));
  assert.ok(!failed.some(f => f.code === 'QUOTE_AMOUNT'));
});
test('modification diagnostics retain the original array index after malformed entries', () => {
  const findings = inspectCall(quote([item({ modification: { values: [null, { code: 'sauce', key: 'wrong', quantity: 1 }] } })]), {}, [detail()]);
  assert.ok(findings.some(f => f.code === 'MODIFICATION_ITEM' && f.detail.includes('values[0]')));
  assert.ok(findings.some(f => f.code === 'MODIFICATION_KEY' && f.detail.includes('values[1]')));
});
test('CLI imported and simulated transport errors remain diagnostic exit code 2', async () => {
  const cli = resolve(import.meta.dirname, '../skills/mcd-mcp-clinic/scripts/clinic.mjs');
  const simulated = spawnSync(process.execPath, [cli, 'demo', 'auth', '--json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(simulated.status, 2);
  const directory = await mkdtemp(join(tmpdir(), 'clinic-cli-replay-'));
  const path = join(directory, 'report.json');
  try {
    await writeFile(path, JSON.stringify({ calls: [{ tool: 'now-time-info', input: {}, error: { status: 503, message: 'synthetic historical failure' } }] }));
    const replay = spawnSync(process.execPath, [cli, 'inspect', path, '--json'], { encoding: 'utf8', windowsHide: true });
    assert.equal(replay.status, 2); assert.equal(JSON.parse(replay.stdout).source, 'import');
  } finally { await unlink(path); await rmdir(directory); }
});
test('JSON-RPC 404 diagnostics do not suggest HTTP session renewal', () => {
  const run = error => inspectCall({ tool: 'now-time-info', input: {}, error }).find(f => f.code === 'TOOL_ERROR');
  assert.ok(!run({ status: 404, message: 'JSON-RPC 404: missing application data' }).fix.includes('重新连接'));
  assert.ok(run({ status: 404, message: 'MCP HTTP 404' }).fix.includes('重新连接'));
});
