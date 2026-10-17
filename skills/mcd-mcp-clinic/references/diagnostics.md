# 诊断规则与边界

依据：https://github.com/M-China/mcd-mcp-server

运行时inputSchema及工具说明优先。以下约束于2026-10-16固化。

| 业务 | beType | orderType | beCode |
| --- | --- | --- | --- |
| 到店自取 | 1 | 1 | 不传 |
| 麦乐送 | 2 | 2 | 从delivery-query-stores取得 |
| 得来速 | 5 | 1 | 从query-nearby-stores取得 |
| 企业团餐 | 6 | 2 | 从delivery-query-stores取得 |

storeCode和beCode取自同一条门店结果。位置搜索用searchType=2及字符串city / keyword，收藏搜索用searchType=1。

逐步使用该调用之前的成功门店记录解析编码绑定，不将后来另一渠道的绑定用于检查历史调用。菜单、商品详情、门店券和核价模板匹配同一门店、beType、orderType、beCode及reservationDate；业务失败的响应不能提供菜单或特调证据。

明确预约时传reservationDate，北京时间yyyy-MM-dd HH:mm。格式合法不代表当前可预约，仍需核对完整可选时段。

query-my-coupons是卡包资产；query-store-coupons是指定门店业务场景可用券。未记录后者时指出缺少证据，不直接断言券无效。

calculate-price的price、productPrice、discount、配送／打包／餐具费为分，展示元时除以100；enjoyed.realDiscount与enjoyable.realDiscount为元，不一概转换。菜单展示价不等于整单核价。

商品数量为正整数。套餐使用详情轮次ID及choices，按已记录范围检查数量。特调选中项传selectedKey；未选中项有unselectedKey时仍需传递，数量为0，不以省略替代明确取消。

已取得同一业务上下文的商品详情时，必选轮次不能整组遗漏；轮次ID不能重复或超出详情列表。特调对象整组遗漏也会检查unselectedKey必需项；未知及重复特调编码需修正。没有详情时不推测这些约束。

query-promotions、query-meal-assistance限企业团餐。普通订单优惠查门店券。

401排查本机Token；429停止请求并按Retry-After手动重试；会话404对白名单查询重连一次。HTTP成功、导入记录或缺响应的静态检查不代表当前业务成功。

本机连接检查和真实调用同时检查工具isError及业务success/code；业务失败返回502并保留诊断报告。支持v1格式回放，网页、服务与CLI共用记录校验。

预约时间必须是有效日期格式的字符串。页面展示金额meta.displayedTotal使用非负数字（元），不将字符串、数组或布尔值隐式转换成金额。同一调用内不同商品的错误保留各自位置。

正文中含多个JSON对象时优先提取原始响应；脱敏覆盖常见字段命名变体、字段名中的凭证及正文里的JSON对象／数组。Markdown导出会转义错误详情，仍需人工检查额外自由文本。

## 最小记录示例

~~~json
{
  "title": "金额展示问题",
  "calls": [{
    "tool": "calculate-price",
    "input": {
      "storeCode": "9000001", "beType": 1, "orderType": 1,
      "items": [{ "productCode": "DEMO_PRODUCT", "quantity": 1 }]
    },
    "output": { "success": true, "code": 200, "data": { "price": 2740 } },
    "meta": { "displayedTotal": 2740 }
  }]
}
~~~

以上编码与价格为虚构数据。保存为本机JSON，用CLI inspect分析。
