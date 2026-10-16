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

明确预约时传reservationDate，北京时间yyyy-MM-dd HH:mm。格式合法不代表当前可预约，仍需核对完整可选时段。

query-my-coupons是卡包资产；query-store-coupons是指定门店业务场景可用券。未记录后者时指出缺少证据，不直接断言券无效。

calculate-price的price、productPrice、discount、配送／打包／餐具费为分，展示元时除以100；enjoyed.realDiscount与enjoyable.realDiscount为元，不一概转换。菜单展示价不等于整单核价。

商品数量为正整数。套餐使用详情轮次ID及choices，按已记录范围检查数量。特调选中项传selectedKey；未选中项有unselectedKey时仍需传递，数量为0，不以省略替代明确取消。

query-promotions、query-meal-assistance限企业团餐。普通订单优惠查门店券。

401排查本机Token；429停止请求并按Retry-After手动重试；会话404对白名单查询重连一次。HTTP成功、导入记录或缺响应的静态检查不代表当前业务成功。

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
