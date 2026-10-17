// These fixtures are deliberately fictional, never advertised as live menu data.
const wrap = data => ({ success: true, code: 200, message: '演示响应', data });
const call = (tool, input, output, durationMs) => ({ tool, input, output: wrap(output), durationMs });
const base = { storeCode: '9000001', beType: 1, orderType: 1 };
const common = [
  call('now-time-info', {}, { date: '2026-10-16', formatted: '2026-10-16 12:00:00', timezone: 'GMT+08:00' }, 82),
  call('query-nearby-stores', { beType: 1, searchType: 2, city: '演示城市', keyword: '演示广场' }, [{ storeCode: '9000001', storeName: '演示广场餐厅（虚构）', businessStatus: true }], 176),
  call('query-meals', { ...base }, { categories: [{ name: '演示套餐', meals: [{ code: 'DEMO_COMBO' }] }], meals: { DEMO_COMBO: { name: '演示双人补给餐', currentPrice: '32.00', originalPrice: '38.00' } } }, 214),
  call('query-meal-detail', { ...base, code: 'DEMO_COMBO' }, { code: 'DEMO_COMBO', name: '演示双人补给餐', rounds: [{ id: 1, minQuantity: 2, maxQuantity: 2, choices: [{ code: 'DEMO_BURGER', name: '演示汉堡', quantity: 2, maxQuantity: 2, isDefault: 1 }] }] }, 159)
];
const coupon = { couponId: 'demo-coupon-id', couponCode: 'demo-coupon-code', title: '演示立减券', products: [{ productCode: 'DEMO_COMBO', productName: '演示双人补给餐' }] };
const cart = { ...base, items: [{ productCode: 'DEMO_COMBO', quantity: 1, couponId: coupon.couponId, couponCode: coupon.couponCode,
  roundList: [{ round: '1', comboItemList: [{ code: 'DEMO_BURGER', quantity: 2 }] }] }] };
const quote = { price: 2740, productPrice: 2740, originalPrice: 3800, discount: 1060, deliveryPrice: 0, packingPrice: 0, tablewarePrice: 0 };

export const DEMO_CASES = [
  { id: 'price-unit', title: '报价怎么放大了100倍？', subtitle: '金额单位 · 门店券校验', tag: '2处问题', description: '接口调用成功，页面金额却显示异常。沿着调用记录找出展示与券校验的问题。',
    run: { title: '报价展示与优惠券检查', source: 'demo', calls: [...common, call('query-my-coupons', {}, [coupon], 188), { ...call('calculate-price', cart, quote, 421), meta: { displayedTotal: 2740 } }] } },
  { id: 'missing-code', title: '门店查到了，菜单却打不开', subtitle: '得来速 · 业务编码', tag: '1处问题', description: '得来速门店查询已返回 beCode，下一步读取菜单时却遗漏了它。',
    run: { title: '得来速业务编码检查', source: 'demo', context: { storeBinding: { storeCode: '9000002', beCode: 'DEMO_DT' } }, calls: [common[0], call('query-nearby-stores', { beType: 5, searchType: 2, city: '演示城市', keyword: '演示公园' }, [{ storeCode: '9000002', beCode: 'DEMO_DT', storeName: '演示公园得来速（虚构）' }], 197), { tool: 'query-meals', input: { storeCode: '9000002', beType: 5, orderType: 1 }, durationMs: 0, output: null, note: '在发送前被参数检查拦截。' }] } },
  { id: 'healthy', title: '一条完整的健康链路', subtitle: '6次调用 · 整单核价', tag: '全部通过', description: '保留门店上下文、校验可用券、换算金额，看看一份清楚的记录应该是什么样。',
    run: { title: '到店自取健康链路', source: 'demo', calls: [...common, call('query-store-coupons', { ...base }, [coupon], 188), { ...call('calculate-price', cart, quote, 421), meta: { displayedTotal: 27.40 } }] } },
  { id: 'auth', title: '连接返回401，应该查哪里？', subtitle: '认证失败 · 本机配置', tag: '认证错误', description: '连接失败时明确停止，区分认证问题与业务参数问题。',
    run: { title: '认证失败诊断', source: 'demo', calls: [{ tool: 'now-time-info', input: {}, error: { status: 401, message: 'MCP HTTP 401（模拟错误）' }, durationMs: 119 }] } }
];

export const SAMPLE_INPUTS = {
  'now-time-info': {},
  'query-nearby-stores': { beType: 1, searchType: 2, city: '上海市', keyword: '人民广场' },
  'delivery-query-addresses': {},
  'delivery-query-stores': { addressId: '<配送地址查询返回值>', beType: 2 },
  'query-meals': { storeCode: '<门店查询返回值>', beType: 1, orderType: 1 },
  'query-meal-detail': { storeCode: '<门店查询返回值>', beType: 1, orderType: 1, code: '<菜单返回值>' },
  'query-store-coupons': { storeCode: '<门店查询返回值>', beType: 1, orderType: 1 },
  'calculate-price': { storeCode: '<门店查询返回值>', beType: 1, orderType: 1, items: [{ productCode: '<菜单返回值>', quantity: 1 }] },
  'query-promotions': { storeCode: '<门店查询返回值>', beCode: '<团餐门店返回值>', beType: 6, orderType: 2 },
  'query-meal-assistance': { storeCode: '<门店查询返回值>', beCode: '<团餐门店返回值>', beType: 6, orderType: 2 },
  'list-nutrition-foods': {}
};
