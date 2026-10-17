// Shared by the portable Skill and the local browser; no credentials or Node APIs.
import { jsonFragments } from './json-text.mjs';
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const canonicalTool = name => String(name || '').replace(/^.*__/, '').replace(/_/g, '-');

export function extractPayload(raw) {
  if (!raw) return null;
  if (raw.structuredContent) return raw.structuredContent;
  if (Array.isArray(raw.content)) {
    for (const item of raw.content) {
      if (item?.type !== 'text') continue;
      const text = String(item.text || '').trim();
      try { return JSON.parse(text); } catch {}
      const first = jsonFragments(text, 1)[0];
      if (first) return first.value;
    }
    return null;
  }
  return raw;
}

export function hasBusinessError(output) {
  const payload = extractPayload(output);
  return Boolean(output?.isError || payload?.success === false ||
    (payload?.code != null && ![0, 200, '0', '200'].includes(payload.code)));
}

export function successfulCall(call) {
  return Boolean(call && !call.error && extractPayload(call.output) != null && !hasBusinessError(call.output));
}

const hasRecordedResult = call => Boolean(call?.error) || call?.output !== undefined;

export function businessContext(input = {}) {
  const beType = input?.beType;
  const context = { beType, orderType: input?.orderType ?? ([1, 5].includes(beType) ? 1 : [2, 6].includes(beType) ? 2 : undefined) };
  for (const key of ['storeCode', 'beCode', 'reservationDate']) {
    if (input?.[key] != null && input[key] !== '') context[key] = input[key];
  }
  if (beType === 1) delete context.beCode;
  return context;
}

export function sameBusinessContext(left, right, { ignoreReservation = false } = {}) {
  const a = businessContext(left), b = businessContext(right);
  const fields = ['storeCode', 'beType', 'orderType', 'beCode', ...(ignoreReservation ? [] : ['reservationDate'])];
  return fields.every(key => (a[key] ?? '') === (b[key] ?? ''));
}

export function findMatchingCall(calls, tool, input, predicate = () => true) {
  // A failed refresh supersedes older evidence for this exact request context.
  // Parameter-only checks have no response and must not invalidate real data.
  const latest = [...calls].reverse().find(call => canonicalTool(call?.tool) === tool && hasRecordedResult(call) &&
    sameBusinessContext(call.input, input) && predicate(call));
  return successfulCall(latest) ? latest : undefined;
}

export function resolveCallContext(input, previous, context = {}) {
  let storeBinding;
  for (const call of [...previous].reverse()) {
    if (!['query-nearby-stores', 'delivery-query-stores'].includes(canonicalTool(call?.tool)) ||
        !successfulCall(call) || call.input?.beType !== input?.beType) continue;
    const stores = extractPayload(call.output)?.data;
    const store = Array.isArray(stores) && stores.find(value => isRecord(value) && value.storeCode === input?.storeCode);
    if (store) { storeBinding = { ...store, beType: call.input.beType, orderType: businessContext(call.input).orderType }; break; }
  }
  const declared = context?.storeBinding;
  if (!storeBinding && isRecord(declared) && (declared.beType == null || declared.beType === input?.beType) &&
      (declared.orderType == null || declared.orderType === businessContext(input).orderType)) storeBinding = declared;
  return { ...context, storeBinding };
}

export function selectionFromTrace(calls = [], { storeCode = '', productCode = '' } = {}) {
  let stores = [], storeIndex = -1;
  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index];
    if (!['query-nearby-stores', 'delivery-query-stores'].includes(canonicalTool(call?.tool)) || !hasRecordedResult(call)) continue;
    if (!successfulCall(call)) break;
    const data = extractPayload(call.output)?.data;
    if (!Array.isArray(data)) break;
    stores = data.filter(value => isRecord(value) && typeof value.storeCode === 'string')
      .map(store => ({ ...store, ...businessContext({ ...store, beType: call.input?.beType }) }));
    storeIndex = index; break;
  }
  if (!stores.length) return { stores: [], products: [], selectedStore: '', selectedProduct: '', activeContext: {} };
  const selectedStore = stores.some(store => store.storeCode === storeCode) ? storeCode : stores[0]?.storeCode || '';
  let context = businessContext(stores.find(store => store.storeCode === selectedStore));
  // The attempted request selects the time slot; a failed response cannot supply its menu.
  const commerce = ['query-meals', 'query-meal-detail', 'query-store-coupons', 'calculate-price', 'query-promotions', 'query-meal-assistance'];
  for (const call of calls.slice(storeIndex + 1).reverse()) {
    if (commerce.includes(canonicalTool(call?.tool)) && isRecord(call.input) &&
        sameBusinessContext(call.input, context, { ignoreReservation: true })) { context = businessContext(call.input); break; }
  }
  const menuCall = findMatchingCall(calls, 'query-meals', context);
  const meals = extractPayload(menuCall?.output)?.data?.meals;
  const products = isRecord(meals) ? Object.entries(meals).map(([code, meal]) => ({ code, name: meal?.name || code })) : [];
  const selectedProduct = products.some(product => product.code === productCode) ? productCode : products[0]?.code || '';
  return { stores, products, selectedStore, selectedProduct, activeContext: context };
}

export function defaultModification(modification) {
  if (!Array.isArray(modification?.items)) return undefined;
  const values = modification.items.flatMap(group => (Array.isArray(group?.values) ? group.values : []).filter(isRecord).flatMap(value => {
    const selected = Number.isInteger(value.selectedQuantity) && value.selectedQuantity > 0;
    const key = selected ? value.selectedKey : value.unselectedKey;
    return typeof key === 'string' && key ? [{ code: value.code, key, quantity: selected ? value.selectedQuantity : 0 }] : [];
  }));
  return values.length ? { values } : undefined;
}

export function requestTemplate(template, { context, productCode, calls = [] } = {}) {
  const input = structuredClone(template);
  if ('storeCode' in input && context?.storeCode) {
    Object.assign(input, businessContext(context));
    for (const key of ['beCode', 'reservationDate']) if (!context[key] || (key === 'beCode' && context.beType === 1)) delete input[key];
  }
  if ('code' in input && productCode) input.code = productCode;
  if (Array.isArray(input.items) && productCode) {
    const item = { productCode, quantity: 1 };
    const detailCall = findMatchingCall(calls, 'query-meal-detail', input, call => call.input?.code === productCode);
    const detail = extractPayload(detailCall?.output)?.data;
    const modification = defaultModification(detail?.modification);
    if (modification) item.modification = modification;
    if (Array.isArray(detail?.rounds) && detail.rounds.length) {
      item.roundList = detail.rounds.filter(isRecord).map(round => ({
        round: String(round.id ?? round.round),
        comboItemList: (Array.isArray(round.choices) ? round.choices : []).filter(choice => isRecord(choice) && Number(choice.isDefault) === 1)
          .map(choice => ({ code: choice.code, quantity: choice.quantity || 1,
            ...(defaultModification(choice.modification) ? { modification: defaultModification(choice.modification) } : {}) })),
      }));
    }
    input.items = [item];
  }
  return input;
}
