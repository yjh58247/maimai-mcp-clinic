import { randomUUID } from 'node:crypto';
import { redact } from './redact.mjs';

export const SAFE_TOOLS = new Set([
  'now-time-info', 'query-nearby-stores', 'delivery-query-addresses', 'delivery-query-stores',
  'query-meals', 'query-meal-detail', 'query-store-coupons', 'calculate-price',
  'query-promotions', 'query-meal-assistance', 'list-nutrition-foods'
]);
export const TOOL_LABELS = {
  'now-time-info': '服务器时间', 'query-nearby-stores': '查询门店', 'delivery-query-addresses': '配送地址',
  'delivery-query-stores': '配送门店', 'query-meals': '读取菜单', 'query-meal-detail': '商品详情',
  'query-store-coupons': '门店可用券', 'query-my-coupons': '用户卡包', 'calculate-price': '整单核价',
  'query-promotions': '团餐促销', 'query-meal-assistance': '团餐助餐', 'list-nutrition-foods': '营养数据'
};
export const canonicalTool = name => String(name || '').replace(/^.*__/, '').replace(/_/g, '-');

export function extractPayload(raw) {
  if (!raw) return null;
  if (raw.structuredContent) return raw.structuredContent;
  if (raw.content && Array.isArray(raw.content)) {
    for (const item of raw.content) {
      if (item.type !== 'text') continue;
      const text = String(item.text || '').trim();
      const candidates = [text, text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], text.slice(text.indexOf('{')), text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
      for (const candidate of candidates) {
        if (!candidate) continue;
        try { return JSON.parse(candidate); } catch {}
      }
    }
    return null;
  }
  return raw;
}

function schemaErrors(value, schema, path = '参数', depth = 0) {
  if (!schema || depth > 12) return [];
  const errors = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const matches = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (types.length && !types.some(matches)) return [`${path} 类型应为 ${types.join(' / ')}`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} 不在接口允许的取值中`);
  if (typeof value === 'number' && schema.minimum != null && value < schema.minimum) errors.push(`${path} 小于 ${schema.minimum}`);
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path} 太短`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path} 太长`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (value[key] === undefined) errors.push(`${path}.${key} 为必填项`);
    for (const [key, val] of Object.entries(value)) if (schema.properties?.[key]) errors.push(...schemaErrors(val, schema.properties[key], `${path}.${key}`, depth + 1));
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path} 至少需要 ${schema.minItems} 项`);
    value.slice(0, 100).forEach((val, i) => errors.push(...schemaErrors(val, schema.items, `${path}[${i}]`, depth + 1)));
  }
  return errors;
}

function validReservation(value) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) return false;
  const date = new Date(value.replace(' ', 'T') + ':00+08:00');
  return !Number.isNaN(date.valueOf()) && new Date(date.valueOf() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') === value;
}

export function inspectCall(call, context = {}, previous = [], tools = []) {
  const tool = canonicalTool(call.tool);
  const args = call.input || {};
  const findings = [];
  const add = (code, severity, title, detail, fix, extra = {}) => findings.push({ code, severity, title, detail, fix, tool, ...extra });
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    add('ARG_OBJECT', 'error', '参数必须是 JSON 对象', '工具参数不接受数组或空值。', '将参数改为一个 JSON 对象。');
    return findings;
  }
  const schema = tools.find(t => canonicalTool(t.name) === tool)?.inputSchema;
  if (tools.length && !tools.some(t => canonicalTool(t.name) === tool)) add('TOOL_NOT_FOUND', 'error', '当前服务未发现此工具', '该工具不在本次 tools/list 结果中。', '按当前服务返回的工具名称与 schema 调用。');
  const errors = schemaErrors(args, schema);
  if (errors.length) add('SCHEMA', 'error', '参数与当前接口定义不符', errors.slice(0, 8).join('；'), '按照本次 tools/list 返回的 inputSchema 修正参数。');
  if (tool === 'query-nearby-stores') {
    if (![1, 5].includes(args.beType)) add('STORE_CHANNEL', 'error', '缺少取餐方式', '附近门店查询需要明确到店自取或得来速。', '到店自取传 beType=1；得来速传 beType=5。');
    if (![1, 2].includes(args.searchType)) add('SEARCH_TYPE', 'error', '缺少门店搜索方式', '门店搜索需区分收藏与按位置查询。', '收藏门店传 searchType=1；位置搜索传 searchType=2。');
    if (args.searchType === 2 && (typeof args.city !== 'string' || !args.city.trim() || typeof args.keyword !== 'string' || !args.keyword.trim())) add('STORE_LOCATION', 'error', '位置搜索缺少城市或关键词', '当前请求选择了按位置搜索。', '补全字符串类型的 city 和 keyword，再查询门店。');
  }
  const commerce = ['query-meals', 'query-meal-detail', 'query-store-coupons', 'calculate-price', 'query-promotions', 'query-meal-assistance'];
  if (commerce.includes(tool)) {
    if (typeof args.storeCode !== 'string' || !/^\d+$/.test(args.storeCode)) add('STORE_CODE', 'error', '门店编码格式不正确', 'storeCode 应来自门店工具返回，且为数字字符串。', '重新选择门店，保留 storeCode 的字符串类型。');
    if (![1, 2, 5, 6].includes(args.beType)) add('BE_TYPE', 'error', '业务类型缺失或无效', '需要明确本次点餐的业务场景。', '传 beType：1自取、2麦乐送、5得来速、6团餐。');
    const expected = [1, 5].includes(args.beType) ? 1 : [2, 6].includes(args.beType) ? 2 : null;
    if (expected && args.orderType !== expected) add('CHANNEL_MISMATCH', 'error', '业务类型与订单类型不匹配', `当前 beType=${args.beType} 应对应 orderType=${expected}。`, `将 orderType 改为 ${expected}，并确认门店来源正确。`, { before: { orderType: args.orderType, beType: args.beType }, after: { orderType: expected, beType: args.beType } });
    if ([2, 5, 6].includes(args.beType) && !args.beCode) add('BE_CODE_REQUIRED', 'error', '业务编码 beCode 缺失', '得来速、外送和团餐需要同时传递 storeCode 与 beCode。', '从门店查询结果取得同一条记录的 beCode；不要自行编造。', { before: { storeCode: args.storeCode, beType: args.beType }, after: { storeCode: args.storeCode, beType: args.beType, beCode: '<门店查询返回值>' } });
    if (args.beCode != null && typeof args.beCode !== 'string') add('BE_CODE_TYPE', 'error', '业务编码类型不正确', 'beCode 应保留门店工具返回的字符串类型。', '使用同一条门店结果的 beCode 字符串。');
    if (args.beType === 1 && args.beCode) add('PICKUP_BE_CODE', 'warning', '到店自取无需传 beCode', '当前到店自取请求携带了业务编码。', 'beType=1 时移除 beCode。');
    if (tool === 'query-promotions' && args.beType !== 6) add('PROMOTIONS_SCOPE', 'error', '促销查询仅适用于企业团餐', 'query-promotions 不是普通到店优惠查询。', '企业团餐使用 beType=6、orderType=2；普通订单改查 query-store-coupons。');
    if (tool === 'query-meal-assistance' && args.beType !== 6) add('ASSISTANCE_SCOPE', 'error', '助餐查询仅适用于企业团餐', '当前场景不支持企业助餐服务。', '仅在 beType=6 的团餐链路中调用。');
    const binding = context.storeBinding;
    if (binding && String(binding.storeCode) === args.storeCode && [2, 5, 6].includes(args.beType) && args.beCode && args.beCode !== binding.beCode) add('STORE_BINDING', 'error', '门店与业务编码配对不一致', '传入 beCode 与记录中的门店查询结果不一致。', '使用同一条门店记录中的 storeCode 和 beCode。');
    if (context.reservation && !args.reservationDate) add('RESERVATION_REQUIRED', 'error', '预约场景缺少时间', '记录声明为预约点餐，当前调用未带预约时间。', '从门店返回的可选预约时段中选择并传 reservationDate。');
    if (args.reservationDate && !validReservation(args.reservationDate)) add('RESERVATION_FORMAT', 'error', '预约时间格式或日期无效', '接口使用北京时间，格式为 yyyy-MM-dd HH:mm。', '例如 2026-10-20 12:30；该时段还需在门店可预约范围内。');
  }
  if (tool === 'calculate-price') {
    if (!Array.isArray(args.items) || !args.items.length) add('EMPTY_CART', 'error', '核价餐单为空', 'calculate-price 需要至少一项商品。', '从当前门店菜单中选取商品，并传 items。');
    for (const item of Array.isArray(args.items) ? args.items : []) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) { add('CART_ITEM', 'error', '商品项不是有效对象', 'items 中每一项都应包含商品编码和数量。', '每项使用 { productCode, quantity } 对象。'); continue; }
      if (!Number.isInteger(item.quantity) || item.quantity < 1) add('QUANTITY', 'error', '商品数量应为正整数', '商品数量需为大于等于1的整数。', '修正 items[].quantity。');
      if (!item.productCode || typeof item.productCode !== 'string') add('PRODUCT_CODE', 'error', '商品编码缺失或类型错误', '商品编码需要保留字符串类型。', '使用本次 query-meals 返回的 productCode。');
      if (Boolean(item.couponId) !== Boolean(item.couponCode)) add('COUPON_PAIR', 'error', '优惠券参数不完整', '使用优惠券时应携带同一张券的 couponId 与 couponCode。', '从门店可用券结果取得完整参数，或同时移除两项。');
      const detailCall = [...previous].reverse().find(p => canonicalTool(p.tool) === 'query-meal-detail' && p.input?.code === item.productCode && p.input?.storeCode === args.storeCode && p.input?.beType === args.beType && (p.input?.reservationDate || '') === (args.reservationDate || '') && !p.error);
      const detail = extractPayload(detailCall?.output)?.data;
      const inspectModification = (selected, definition) => {
        if (!selected || !Array.isArray(definition?.items)) return;
        const chosen = Array.isArray(selected.values) ? selected.values : [];
        for (const group of definition.items) for (const value of group.values || []) {
          const sent = chosen.find(v => v.code === value.code);
          if (value.unselectedKey && !sent) add('MODIFICATION_OMITTED', 'error', '特调取消项没有完整传递', '某个特调项提供了 unselectedKey，但请求里完全省略了该项。', '选中的项传 selectedKey；未选中的项传 unselectedKey 和数量0。');
          if (sent) {
            const expected = sent.quantity > 0 ? value.selectedKey : value.unselectedKey;
            if (expected && sent.key !== expected) add('MODIFICATION_KEY', 'error', '特调 key 与选中状态不一致', '特调项的 key 需要依据是否选中决定。', '数量大于0使用 selectedKey；取消时使用 unselectedKey。');
            if (!Number.isInteger(sent.quantity) || sent.quantity < 0 || (value.maxQuantity != null && sent.quantity > value.maxQuantity) || (sent.quantity > 0 && value.minQuantity != null && sent.quantity < value.minQuantity)) add('MODIFICATION_QUANTITY', 'error', '特调数量超出允许范围', '当前数量与商品详情中的可选数量不符。', '按详情返回的 minQuantity 与 maxQuantity 选择数量。');
          }
        }
      };
      inspectModification(item.modification, detail?.modification);
      if (Array.isArray(detail?.rounds) && detail.rounds.length && Array.isArray(item.roundList)) {
        for (const round of detail.rounds) {
          const selection = item.roundList.find(r => r && String(r.round) === String(round.id ?? round.round));
          const count = (selection?.comboItemList || []).reduce((sum, choice) => sum + (Number(choice.quantity) || 0), 0);
          if ((round.minQuantity != null && count < round.minQuantity) || (round.maxQuantity != null && count > round.maxQuantity)) add('COMBO_QUANTITY', 'error', '套餐轮次的选配数量不符', '已记录的商品详情限定了此轮次的可选数量。', '按该轮次 minQuantity / maxQuantity 完成选配。');
          for (const choice of selection?.comboItemList || []) {
            const definition = round.choices?.find(c => c.code === choice.code);
            if (!definition) add('COMBO_CHOICE', 'error', '套餐选项不在已返回列表中', '当前选择不在这次商品详情返回的 choices 中。', '刷新当前门店商品详情，并从返回选项中选择。');
            if (!Number.isInteger(choice.quantity) || choice.quantity < 1 || (definition?.maxQuantity != null && choice.quantity > definition.maxQuantity)) add('COMBO_ITEM_QUANTITY', 'error', '套餐子项数量不符', '子项数量应为正整数，并且不超过该选项上限。', '按 choices[].maxQuantity 修正数量。');
            inspectModification(choice.modification, definition?.modification);
          }
        }
      }
    }
    const withCoupon = Array.isArray(args.items) && args.items.some(item => item && (item.couponId || item.couponCode));
    if (withCoupon && !previous.some(p => canonicalTool(p.tool) === 'query-store-coupons' && p.input?.storeCode === args.storeCode && p.input?.orderType === args.orderType && p.input?.beType === args.beType && (p.input?.beCode || '') === (args.beCode || '') && (p.input?.reservationDate || '') === (args.reservationDate || '') && p.output && !p.error && !p.output.isError && extractPayload(p.output)?.success !== false && (extractPayload(p.output)?.code == null || [0, 200, '0', '200'].includes(extractPayload(p.output).code)))) {
      add('COUPON_STORE_CHECK', 'warning', '未记录当前门店的可用券校验', '卡包中拥有的券不等于当前门店、渠道、时段可用。当前记录可能不包含上游调用。', '调用同一业务上下文的 query-store-coupons，再用 calculate-price 核价。');
    }
    const payload = extractPayload(call.output);
    const cents = payload?.data?.price;
    const displayed = call.meta?.displayedTotal;
    if (typeof cents === 'number' && displayed != null && Number.isFinite(Number(displayed)) && Math.abs(Number(displayed) - cents / 100) > 0.005) {
      add('PRICE_UNIT', 'error', '核价金额展示错误', `price=${cents} 的单位是分，应展示 ¥${(cents / 100).toFixed(2)}。`, '将 calculate-price 的 price 除以100；保留两位小数。', { before: { price: cents, displayedTotal: Number(displayed) }, after: { price: cents, displayedTotal: cents / 100 } });
    }
  }
  if (call.error) {
    const code = call.error.status || call.error.code;
    const friendly = code === 401 ? ['认证失败', '在本机更新 MCP Token，重启服务后重试。'] : code === 429 ? ['触发接口限流', '停止批量调用，按服务端 Retry-After 等待后手动重试。'] : code === 404 ? ['会话或资源已失效', '重新连接，再从门店查询开始。'] : ['调用未成功', '查看错误摘要及当前接口定义，修正后重试。'];
    add('TOOL_ERROR', 'error', friendly[0], String(call.error.message || '未取得成功结果。'), friendly[1]);
  } else {
    const payload = extractPayload(call.output);
    if (call.output?.isError || payload?.success === false || (payload?.code != null && ![0, 200, '0', '200'].includes(payload.code))) add('BUSINESS_ERROR', 'error', '接口返回业务错误', String(payload?.message || 'MCP 工具结果标记为错误。'), '根据业务错误重新核对门店、商品与权限；不能将此次结果当成成功报价。');
  }
  return findings.filter((item, i, all) => all.findIndex(other => other.code === item.code) === i);
}

export function analyzeRun(raw = {}, { tools = [], secrets = [] } = {}) {
  const calls = Array.isArray(raw.calls) ? raw.calls.slice(0, 100) : [];
  const context = raw.context || {};
  const findings = [];
  const inspected = calls.map((call, index) => {
    const issues = inspectCall(call, context, calls.slice(0, index), tools).map(f => ({ ...f, callIndex: index }));
    findings.push(...issues);
    return { ...call, tool: canonicalTool(call.tool), label: TOOL_LABELS[canonicalTool(call.tool)] || canonicalTool(call.tool), findings: issues, status: issues.some(f => f.severity === 'error') ? 'error' : issues.length ? 'warning' : 'passed' };
  });
  const source = ['demo', 'live', 'import', 'manual'].includes(raw.source) ? raw.source : 'manual';
  const report = {
    format: 'mcd-clinic-report', schemaVersion: 1, id: randomUUID(),
    title: String(raw.title || 'MCP 调用体检').slice(0, 120),
    createdAt: new Date().toISOString(), source,
    sourceLabel: { demo: '离线演示 · 虚构数据', live: '本机真实 MCP 调用', import: '导入回放 · 未进行实时验证', manual: '手动检查 · 未进行实时调用' }[source],
    context,
    summary: { total: calls.length, passed: inspected.filter(c => c.status === 'passed').length, attention: inspected.filter(c => c.status !== 'passed').length, errors: findings.filter(f => f.severity === 'error').length, warnings: findings.filter(f => f.severity === 'warning').length, timedCalls: calls.filter(call => Number.isFinite(call.durationMs)).length, durationMs: calls.reduce((sum, call) => sum + (Number.isFinite(call.durationMs) ? Math.max(0, call.durationMs) : 0), 0) },
    findings, calls: inspected
  };
  return redact(report, secrets);
}
