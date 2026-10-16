import test from 'node:test';
import assert from 'node:assert/strict';
import { businessContext, sameBusinessContext, selectionFromTrace, requestTemplate, findMatchingCall } from '../skills/mcd-mcp-clinic/scripts/lib/context.mjs';

const pickup = { storeCode: '1450713', beType: 1, orderType: 1 };
const drive = { ...pickup, beType: 5, beCode: 'drive-business' };
const at = '2026-10-20 12:00';
const ok = (tool, input, data) => ({ tool, input, output: { success: true, code: 200, data } });
const stores = context => ok('query-nearby-stores', { beType: context.beType, searchType: 2 },
  [{ storeCode: context.storeCode, storeName: '测试门店', ...(context.beCode ? { beCode: context.beCode } : {}) }]);
const menu = context => ok('query-meals', context, { meals: { combo: { name: '测试套餐' } } });
const detail = (context, key) => ok('query-meal-detail', { ...context, code: 'combo' }, {
  modification: { items: [{ values: [{ code: 'sauce', selectedKey: key, unselectedKey: 'cancel', selectedQuantity: 1 }] }] },
  rounds: [{ id: 1, choices: [{ code: 'burger', isDefault: 1, quantity: 1 }] }],
});
const template = { ...pickup, items: [{ productCode: 'sample-product', quantity: 1 }] };

test('store query context derives order type and removes unused pickup business code', () => {
  assert.equal(businessContext({ beType: 5 }).orderType, 1);
  assert.equal(businessContext({ beType: 2 }).orderType, 2);
  assert.equal(businessContext({ ...pickup, beCode: 'unused' }).beCode, undefined);
});
for (const [field, value] of [['storeCode', '1450714'], ['beType', 6], ['orderType', 2], ['beCode', 'different'], ['reservationDate', at]]) {
  test('business context separates ' + field, () => {
    assert.equal(sameBusinessContext(drive, { ...drive, [field]: value }), false);
  });
}
test('failed tool responses never supply matching detail evidence', () => {
  const original = detail(drive, 'right-key');
  for (const failed of [
    { ...original, error: { status: 502 } },
    { ...original, output: { ...original.output, isError: true } },
    { ...original, output: { ...original.output, success: false } },
    { ...original, output: { ...original.output, code: 400 } },
    { ...original, output: null },
  ]) {
    assert.equal(findMatchingCall([failed], 'query-meal-detail', drive), undefined);
    const generated = requestTemplate(template, { context: drive, productCode: 'combo', calls: [failed] });
    assert.equal(generated.items[0].modification, undefined);
  }
});
test('changing pickup to drive-through clears the old menu and does not reuse its modification', () => {
  const calls = [stores(pickup), menu(pickup), detail(pickup, 'pickup-only'), stores(drive)];
  assert.equal(selectionFromTrace(calls).products.length, 0);
  calls.push(menu(drive));
  const selected = selectionFromTrace(calls);
  const generated = requestTemplate(template, { context: selected.activeContext, productCode: selected.selectedProduct, calls });
  assert.equal(generated.beType, 5);
  assert.equal(generated.beCode, 'drive-business');
  assert.equal(generated.items[0].modification, undefined);
  assert.equal(generated.items[0].roundList, undefined);
  calls.push(detail(drive, 'drive-only'));
  assert.equal(requestTemplate(template, { context: drive, productCode: 'combo', calls }).items[0].modification.values[0].key, 'drive-only');
});
test('reservation is preserved between menu, detail and quote templates', () => {
  const context = { ...pickup, reservationDate: at };
  const calls = [stores(pickup), menu(context), detail(context, 'reserved-key')];
  const selected = selectionFromTrace(calls);
  for (const sample of [{ ...pickup, code: 'sample' }, template]) {
    const generated = requestTemplate(sample, { context: selected.activeContext, productCode: selected.selectedProduct, calls });
    assert.equal(generated.reservationDate, at);
  }
  assert.equal(requestTemplate(template, { context: selected.activeContext, productCode: 'combo', calls }).items[0].modification.values[0].key, 'reserved-key');
});
test('changing the reservation slot excludes previous detail defaults', () => {
  const first = { ...pickup, reservationDate: at }, next = { ...pickup, reservationDate: '2026-10-20 13:00' };
  const calls = [stores(pickup), menu(first), detail(first, 'old-slot-key'), menu(next)];
  const selected = selectionFromTrace(calls);
  const generated = requestTemplate(template, { context: selected.activeContext, productCode: 'combo', calls });
  assert.equal(generated.reservationDate, next.reservationDate);
  assert.equal(generated.items[0].modification, undefined);
});
test('a failed new reservation request clears the previous slot menu', () => {
  const failed = menu({ ...pickup, reservationDate: at });
  failed.output.isError = true;
  const selected = selectionFromTrace([stores(pickup), menu(pickup), failed]);
  assert.equal(selected.activeContext.reservationDate, at);
  assert.deepEqual(selected.products, []);
});
test('malformed upstream store entries do not break selectors', () => {
  const call = stores(pickup);
  call.output.data.unshift(null, [], 'invalid');
  assert.equal(selectionFromTrace([call]).stores.length, 1);
});
