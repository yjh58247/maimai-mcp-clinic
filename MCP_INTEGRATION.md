# 麦当劳 MCP 接入说明

## Server 与协议

- Server：`https://mcp.mcd.cn`；Streamable HTTP，支持JSON与SSE。
- 认证：本机环境变量 `MCD_MCP_TOKEN`；网页服务也可读未提交的.env。
- 初始化优先2025-06-18，可协商2025-03-26。
- 流程：initialize → notifications/initialized → tools/list → tools/call。
- 后续请求携带服务端分配的session ID及协商协议。会话404仅对白名单查询重连一次；429不自动重试。
- 重连前关闭旧会话；发现失败时清理会话和旧工具列表，重复分页游标停止读取。

依据：[麦当劳官方指南](https://github.com/M-China/mcd-mcp-server)、[MCP传输规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。

## 使用的 Tool 与验证范围

| Tool | 价值 | 已记录的验证 |
| --- | --- | --- |
| now-time-info | 验证工具可调用，取得服务器时间 | 原生HTTP与现有官方连接器均实测成功 |
| query-nearby-stores | 取得有效门店与业务上下文 | 上海人民广场位置搜索成功 |
| query-meals | 提供当前门店的商品编码 | 1450713门店菜单实测成功 |
| query-meal-detail | 读取套餐、默认特调与key | 商品1100实测成功 |
| calculate-price | 验证价格与分／元换算 | 商品1100数量1，price=2550，即25.50元 |
| query-store-coupons | 检查门店与渠道可用券证据 | 离线规则与白名单测试，未读真实卡包 |
| delivery-query-addresses | 用户手动检查外送流程时查询地址 | 接入支持，未读真实地址 |
| delivery-query-stores | 取得外送／团餐业务编码 | 接入支持，未做真实账号验证 |
| query-promotions | 团餐促销场景检查 | 业务范围测试，未做真实调用 |
| query-meal-assistance | 团餐核价前助餐查询 | 接入支持，未做真实调用 |
| list-nutrition-foods | 验证营养数据返回 | 接入支持，未做真实调用 |

前5项已通过本项目原生HTTP客户端携带本机Token完成官方端到端联调：协议2025-06-18、发现35个工具、5次查询与核价成功。原生快照见 `examples/native-http-smoke.json`，报告见 [原生HTTP验收](docs/NATIVE_HTTP_VERIFICATION.md)。此前的宿主连接器公共数据快照仍保留在 `examples/real-mcp-smoke.json`。配置中的Token不进入报告或发布包。

v0.1.1于2026-10-16首次完成原生联调；v0.1.2曾遇到TLS中断。2026-10-17的v0.1.3已再次成功完成上述5次真实调用，新版通过111项自动化测试，验收范围见[验证记录](docs/VERIFICATION.md)。

## 业务调用流程

1. 连接并读取当前tools/list及服务器时间。
2. 用户选择业务场景与位置，查询门店。
3. 保留同一条结果的storeCode / beCode，按场景设置orderType。
4. 查询菜单和商品详情，构造套餐与特调参数。
5. 携券核价时检查上游是否存在同一业务上下文的门店券查询。
6. 执行核价，比较price / 100与页面实际展示金额。
7. 调用与诊断经过统一脱敏层，再返回网页或CLI。

本项目价值是检查和定位问题，不负责全菜单最低价推荐或创建支付订单。

## 检查边界

- schema校验覆盖type、required、enum、minimum、maximum、minLength、maxLength、minItems、maxItems、禁止额外字段及嵌套properties / items，并非完整JSON Schema实现（如组合schema、引用等未覆盖）。
- 套餐和特调检查依赖同一商品、门店、时段的已记录详情；没有上游数据时不能推断全部选项。
- 预约检查覆盖格式、日历合法性和明确预约上下文的必填项，不保证当前库存或可预约性。
- “未记录门店券校验”表示证据缺失，不断言券不可用。
- 供给、价格和权益以官方实时结果为准。
- 客户端实现有限的请求／响应与相关通知处理，不是覆盖全部服务端请求类型的通用MCP SDK。
