import { randomUUID } from 'node:crypto';
import { redact } from './redact.mjs';
import { isRecord, canonicalTool, extractPayload, hasBusinessError, findMatchingCall, resolveCallContext } from './context.mjs';
export { canonicalTool, extractPayload } from './context.mjs';

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

function schemaErrors(value, schema, path = '参数') {
  const errors = [];
  // The report displays eight schema errors. Stop once those are known rather
  // than allocating an unbounded list and spreading it onto the call stack.
  const add = message => { if (errors.length < 8) errors.push(message); };
  function check(value, schema, path, depth) {
    if (errors.length >= 8) return;
    if (schema === false) { add(path + ' 不被当前接口允许'); return; }
    if (!isRecord(schema) || depth > 12) return;
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    const matches = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? isRecord(value) : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
    if (types.length && !types.some(matches)) { add(`${path} 类型应为 ${types.join(' / ')}`); return; }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) add(`${path} 不在接口允许的取值中`);
    if (typeof value === 'number' && schema.minimum != null && value < schema.minimum) add(`${path} 小于 ${schema.minimum}`);
    if (typeof value === 'number' && schema.maximum != null && value > schema.maximum) add(`${path} 大于 ${schema.maximum}`);
    if (typeof value === 'string') {
      let length = 0;
      for (const character of value) length++;
      if (schema.minLength != null && length < schema.minLength) add(`${path} 太短`);
      if (schema.maxLength != null && length > schema.maxLength) add(`${path} 太长`);
    }
    if (isRecord(value)) {
      const patterns = [];
      for (const [pattern, rule] of Object.entries(isRecord(schema.patternProperties) ? schema.patternProperties : {})) {
        try { patterns.push([new RegExp(pattern, 'u'), rule]); }
        catch { add(`${path} 的接口字段匹配规则无效，需确认工具定义`); return; }
      }
      for (const key of (Array.isArray(schema.required) ? schema.required : [])) {
        if (!Object.hasOwn(value, key)) add(`${path}.${key} 为必填项`);
        if (errors.length >= 8) return;
      }
      for (const [key, val] of Object.entries(value)) {
        if (errors.length >= 8) return;
        const declared = isRecord(schema.properties) && Object.hasOwn(schema.properties, key);
        if (declared) check(val, schema.properties[key], `${path}.${key}`, depth + 1);
        let matched = false;
        for (const [pattern, rule] of patterns) {
          if (pattern.test(key)) { matched = true; check(val, rule, `${path}.${key}`, depth + 1); }
          if (errors.length >= 8) return;
        }
        if (!declared && !matched) {
          if (schema.additionalProperties === false) add(`${path}.${key} 不在允许的字段中`);
          else if (isRecord(schema.additionalProperties)) check(val, schema.additionalProperties, `${path}.${key}`, depth + 1);
        }
      }
    }
    if (Array.isArray(value)) {
      if (schema.minItems != null && value.length < schema.minItems) add(`${path} 至少需要 ${schema.minItems} 项`);
      if (schema.maxItems != null && value.length > schema.maxItems) add(`${path} 最多允许 ${schema.maxItems} 项`);
      for (const [i, val] of value.entries()) {
        if (errors.length >= 8) return;
        check(val, schema.items, `${path}[${i}]`, depth + 1);
      }
    }
  }
  check(value, schema, path, 0);
  return errors;
}

function validReservation(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) return false;
  const date = new Date(value.replace(' ', 'T') + ':00+08:00');
  return !Number.isNaN(date.valueOf()) && new Date(date.valueOf() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') === value;
}

export function inspectCall(call, context = {}, previous = [], tools = []) {
  const tool = canonicalTool(call.tool);
  const args = call.input === undefined ? {} : call.input;
  const findings = [];
  const add = (code, severity, title, detail, fix, extra = {}) => findings.push({ code, severity, title, detail, fix, tool, ...extra });
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    add('ARG_OBJECT', 'error', '参数必须是 JSON 对象', '工具参数不接受数组或空值。', '将参数改为一个 JSON 对象。');
    return findings;
  }
  context = resolveCallContext(args, previous, context);
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
    if ([2, 5, 6].includes(args.beType) && (typeof args.beCode !== 'string' || !args.beCode.trim())) add('BE_CODE_REQUIRED', 'error', '业务编码 beCode 缺失', '得来速、外送和团餐需要同时传递 storeCode 与 beCode。', '从门店查询结果取得同一条记录的 beCode；不要自行编造。', { before: { storeCode: args.storeCode, beType: args.beType }, after: { storeCode: args.storeCode, beType: args.beType, beCode: '<门店查询返回值>' } });
    if (args.beCode != null && typeof args.beCode !== 'string') add('BE_CODE_TYPE', 'error', '业务编码类型不正确', 'beCode 应保留门店工具返回的字符串类型。', '使用同一条门店结果的 beCode 字符串。');
    if (args.beType === 1 && args.beCode) add('PICKUP_BE_CODE', 'warning', '到店自取无需传 beCode', '当前到店自取请求携带了业务编码。', 'beType=1 时移除 beCode。');
    if (tool === 'query-promotions' && args.beType !== 6) add('PROMOTIONS_SCOPE', 'error', '促销查询仅适用于企业团餐', 'query-promotions 不是普通到店优惠查询。', '企业团餐使用 beType=6、orderType=2；普通订单改查 query-store-coupons。');
    if (tool === 'query-meal-assistance' && args.beType !== 6) add('ASSISTANCE_SCOPE', 'error', '助餐查询仅适用于企业团餐', '当前场景不支持企业助餐服务。', '仅在 beType=6 的团餐链路中调用。');
    const binding = context.storeBinding;
    if (binding && String(binding.storeCode) === args.storeCode && [2, 5, 6].includes(args.beType) && args.beCode && args.beCode !== binding.beCode) add('STORE_BINDING', 'error', '门店与业务编码配对不一致', '传入 beCode 与记录中的门店查询结果不一致。', '使用同一条门店记录中的 storeCode 和 beCode。');
    if (context.reservation && !args.reservationDate) add('RESERVATION_REQUIRED', 'error', '预约场景缺少时间', '记录声明为预约点餐，当前调用未带预约时间。', '从门店返回的可选预约时段中选择并传 reservationDate。');
    if (args.reservationDate != null && !validReservation(args.reservationDate)) add('RESERVATION_FORMAT', 'error', '预约时间格式或日期无效', '接口使用北京时间，格式为 yyyy-MM-dd HH:mm。', '例如 2026-10-20 12:30；该时段还需在门店可预约范围内。');
  }
  if (tool === 'calculate-price') {
    const inspectModificationShape = (selected, path) => {
      if (selected === undefined) return;
      if (!isRecord(selected) || !Array.isArray(selected.values)) {
        add('MODIFICATION_SHAPE', 'error', '特调参数结构不正确', path + ' 应为包含 values 数组的对象。', '按商品详情填写特调对象和 values 数组。');
        return;
      }
      selected.values.forEach((value, index) => {
        const location = path + '.values[' + index + ']';
        if (!isRecord(value) || typeof value.code !== 'string' || !value.code || typeof value.key !== 'string' || !value.key) {
          add('MODIFICATION_ITEM', 'error', '特调项结构不正确', location + ' 需要非空字符串 code、key。', '每个特调项使用 { code, key, quantity } 对象。');
        } else if (!Number.isInteger(value.quantity) || value.quantity < 0) {
          add('MODIFICATION_QUANTITY', 'error', '特调数量不正确', location + '.quantity 需要大于等于0的整数。', '选中项按详情填写数量；取消项使用数量0。');
        }
      });
    };
    if (!Array.isArray(args.items) || !args.items.length) add('EMPTY_CART', 'error', '核价餐单为空', 'calculate-price 需要至少一项商品。', '从当前门店菜单中选取商品，并传 items。');
    for (const [itemIndex, item] of (Array.isArray(args.items) ? args.items : []).entries()) {
      if (!isRecord(item)) { add('CART_ITEM', 'error', '商品项不是有效对象', 'items[' + itemIndex + '] 应包含商品编码和数量。', '每项使用 { productCode, quantity } 对象。'); continue; }
      if (!Number.isInteger(item.quantity) || item.quantity < 1) add('QUANTITY', 'error', '商品数量应为正整数', 'items[' + itemIndex + '].quantity 需为大于等于1的整数。', '修正该商品的 quantity。');
      if (typeof item.productCode !== 'string' || !item.productCode.trim()) add('PRODUCT_CODE', 'error', '商品编码缺失或类型错误', 'items[' + itemIndex + '].productCode 需要非空字符串。', '使用本次 query-meals 返回的 productCode。');
      if (Boolean(item.couponId) !== Boolean(item.couponCode)) add('COUPON_PAIR', 'error', '优惠券参数不完整', '使用优惠券时应携带同一张券的 couponId 与 couponCode。', '从门店可用券结果取得完整参数，或同时移除两项。');
      const path = 'items[' + itemIndex + ']';
      inspectModificationShape(item.modification, path + '.modification');
      if (item.roundList !== undefined) {
        if (!Array.isArray(item.roundList)) {
          add('COMBO_SHAPE', 'error', '套餐轮次结构不正确', path + '.roundList 应为数组。', '每个轮次使用 { round, comboItemList } 对象。');
        } else item.roundList.forEach((round, roundIndex) => {
          const location = path + '.roundList[' + roundIndex + ']';
          if (!isRecord(round) || typeof round.round !== 'string' || !round.round || !Array.isArray(round.comboItemList)) {
            add('COMBO_SHAPE', 'error', '套餐轮次结构不正确', location + ' 需要字符串 round 和 comboItemList 数组。', '使用商品详情返回的轮次ID，并以数组填写套餐子项。');
            return;
          }
          round.comboItemList.forEach((choice, choiceIndex) => {
            const child = location + '.comboItemList[' + choiceIndex + ']';
            if (!isRecord(choice) || typeof choice.code !== 'string' || !choice.code) {
              add('COMBO_ITEM', 'error', '套餐子项结构不正确', child + ' 需要包含字符串 code 的对象。', '从当前轮次的 choices 选取商品编码。');
              return;
            }
            if (!Number.isInteger(choice.quantity) || choice.quantity < 1) add('COMBO_ITEM_QUANTITY', 'error', '套餐子项数量不符', child + '.quantity 需要正整数。', '按商品详情填写子项数量。');
            inspectModificationShape(choice.modification, child + '.modification');
          });
        });
      }
      const detailCall = findMatchingCall(previous, 'query-meal-detail', args, p => p.input?.code === item.productCode);
      const detail = extractPayload(detailCall?.output)?.data;
      const inspectModification = (selected, definition, location) => {
        if (!Array.isArray(definition?.items)) return;
        if (selected !== undefined && (!isRecord(selected) || !Array.isArray(selected.values))) return;
        const chosen = (selected?.values || []).filter(isRecord);
        const available = definition.items.flatMap(group => (Array.isArray(group?.values) ? group.values : []).filter(isRecord));
        const seen = new Set();
        for (const [index, value] of chosen.entries()) {
          if (seen.has(value.code)) add('MODIFICATION_DUPLICATE', 'error', '特调项重复传递', location + '.values[' + index + '] 的 code 重复。', '同一个特调项只保留一个明确的选中或取消状态。');
          seen.add(value.code);
          if (!available.some(option => option.code === value.code)) add('MODIFICATION_CHOICE', 'error', '特调项不在已返回列表中', location + '.values[' + index + '] 的 code 不在当前详情中。', '刷新同一门店与渠道的详情，从返回特调项中选择。');
        }
        for (const value of available) {
          const sent = chosen.find(v => v.code === value.code);
          if (value.unselectedKey && !sent) add('MODIFICATION_OMITTED', 'error', '特调取消项没有完整传递', location + ' 缺少详情中提供了 unselectedKey 的特调项。', '选中的项传 selectedKey；未选中的项传 unselectedKey 和数量0。');
          if (sent) {
            const expected = sent.quantity > 0 ? value.selectedKey : value.unselectedKey;
            if (expected && sent.key !== expected) add('MODIFICATION_KEY', 'error', '特调 key 与选中状态不一致', '特调项的 key 需要依据是否选中决定。', '数量大于0使用 selectedKey；取消时使用 unselectedKey。');
            if (!Number.isInteger(sent.quantity) || sent.quantity < 0 || (value.maxQuantity != null && sent.quantity > value.maxQuantity) || (sent.quantity > 0 && value.minQuantity != null && sent.quantity < value.minQuantity)) add('MODIFICATION_QUANTITY', 'error', '特调数量超出允许范围', '当前数量与商品详情中的可选数量不符。', '按详情返回的 minQuantity 与 maxQuantity 选择数量。');
          }
        }
      };
      inspectModification(item.modification, detail?.modification, path + '.modification');
      if (Array.isArray(detail?.rounds) && detail.rounds.length && (item.roundList === undefined || Array.isArray(item.roundList))) {
        const selections = (item.roundList || []).filter(isRecord);
        const definitions = detail.rounds.filter(round => isRecord(round) && (round.id ?? round.round) != null);
        const seen = new Set();
        for (const [index, round] of selections.entries()) {
          const id = String(round.round);
          if (seen.has(id)) add('COMBO_DUPLICATE_ROUND', 'error', '套餐轮次重复传递', path + '.roundList[' + index + '] 的 round 重复。', '同一个轮次合并为一条记录，再核对该轮次的总数量。');
          seen.add(id);
          if (!definitions.some(value => String(value.id ?? value.round) === id)) add('COMBO_ROUND', 'error', '套餐轮次不在已返回列表中', path + '.roundList[' + index + '] 的 round 不在当前详情中。', '使用本次商品详情返回的轮次ID。');
        }
        for (const round of definitions) {
          const selection = selections.find(r => String(r.round) === String(round.id ?? round.round));
          const choices = Array.isArray(selection?.comboItemList) ? selection.comboItemList.filter(isRecord) : [];
          const count = choices.reduce((sum, choice) => sum + (Number(choice.quantity) || 0), 0);
          if ((round.minQuantity != null && count < round.minQuantity) || (round.maxQuantity != null && count > round.maxQuantity)) add('COMBO_QUANTITY', 'error', '套餐轮次的选配数量不符', path + '.roundList 中轮次 ' + String(round.id ?? round.round) + ' 的数量不满足详情范围。', '按该轮次 minQuantity / maxQuantity 完成选配，必选轮次不能整组省略。');
          for (const choice of choices) {
            const definition = Array.isArray(round.choices) ? round.choices.find(c => isRecord(c) && c.code === choice.code) : undefined;
            if (!definition) add('COMBO_CHOICE', 'error', '套餐选项不在已返回列表中', '当前选择不在这次商品详情返回的 choices 中。', '刷新当前门店商品详情，并从返回选项中选择。');
            if (!Number.isInteger(choice.quantity) || choice.quantity < 1 || (definition?.maxQuantity != null && choice.quantity > definition.maxQuantity)) add('COMBO_ITEM_QUANTITY', 'error', '套餐子项数量不符', '子项数量应为正整数，并且不超过该选项上限。', '按 choices[].maxQuantity 修正数量。');
            inspectModification(choice.modification, definition?.modification, path + '.roundList[round=' + String(round.id ?? round.round) + '].comboItemList[code=' + choice.code + '].modification');
          }
        }
      }
    }
    const withCoupon = Array.isArray(args.items) && args.items.some(item => item && (item.couponId || item.couponCode));
    if (withCoupon && !findMatchingCall(previous, 'query-store-coupons', args)) {
      add('COUPON_STORE_CHECK', 'warning', '未记录当前门店的可用券校验', '卡包中拥有的券不等于当前门店、渠道、时段可用。当前记录可能不包含上游调用。', '调用同一业务上下文的 query-store-coupons，再用 calculate-price 核价。');
    }
    const payload = extractPayload(call.output);
    const cents = payload?.data?.price;
    const displayed = call.meta?.displayedTotal;
    const validDisplayed = typeof displayed === 'number' && Number.isFinite(displayed) && displayed >= 0;
    if (displayed != null && !validDisplayed) add('DISPLAYED_TOTAL', 'error', '页面金额不是有效数字', 'meta.displayedTotal 应为大于等于0的数字，单位为元。', '传入数字金额，不使用字符串、数组或布尔值。');
    if (!call.error && !hasBusinessError(call.output) && Number.isFinite(cents) && validDisplayed && Math.abs(displayed - cents / 100) > 0.005) {
      add('PRICE_UNIT', 'error', '核价金额展示错误', `price=${cents} 的单位是分，应展示 ¥${(cents / 100).toFixed(2)}。`, '将 calculate-price 的 price 除以100；保留两位小数。', { before: { price: cents, displayedTotal: Number(displayed) }, after: { price: cents, displayedTotal: cents / 100 } });
    }
  }
  if (call.error) {
    const code = call.error.status || call.error.code;
    const friendly = code === 401 ? ['认证失败', '在本机更新 MCP Token，重启服务后重试。'] : code === 429 ? ['触发接口限流', '停止批量调用，按服务端 Retry-After 等待后手动重试。'] : code === 404 ? ['会话或资源已失效', '重新连接，再从门店查询开始。'] : ['调用未成功', '查看错误摘要及当前接口定义，修正后重试。'];
    add('TOOL_ERROR', 'error', friendly[0], String(call.error.message || '未取得成功结果。'), friendly[1]);
  } else {
    const payload = extractPayload(call.output);
    if (hasBusinessError(call.output)) add('BUSINESS_ERROR', 'error', '接口返回业务错误', String(payload?.message || 'MCP 工具结果标记为错误。'), '根据业务错误重新核对门店、商品与权限；不能将此次结果当成成功报价。');
  }
  return findings.filter((item, i, all) => all.findIndex(other => other.code === item.code && other.detail === item.detail) === i);
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
