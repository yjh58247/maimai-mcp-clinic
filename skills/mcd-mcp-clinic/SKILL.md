---
name: mcd-mcp-clinic
description: 诊断麦当劳中国 MCP 接入和调用记录，检查业务编码、渠道、预约、套餐特调、优惠券证据与金额单位，生成脱敏报告。适用于开发和调试麦当劳 Skill、复现调用错误；不作为日常点餐或自动领券助手。
---

# 麦麦 MCP 体检站

根据调用记录或已连接的官方MCP工具找出问题，给出可复现的修正建议。区分静态检查、导入回放和实际调用。

## 选择检查方式

- 用户贴参数或响应：构造包含 `tool`、`input`、可选 `output` 的记录，保留上游调用顺序。
- 用户提供体检站JSON：运行 `node scripts/clinic.mjs inspect <文件路径>`。
- 用户想体验：运行 `node scripts/clinic.mjs demo price-unit`；其他案例为missing-code、healthy、auth。说明案例为虚构数据。
- 用户要求真实接入检查：优先复用客户端已连接的官方MCP；独立连接可运行 `node scripts/clinic.mjs connect`，凭证来自环境变量。

脚本需要Node.js 22+，路径相对此Skill目录。以运行时真实工具名和inputSchema为准，不同客户端可能添加前缀。

## 依据与边界

读取 [references/diagnostics.md](references/diagnostics.md) 确认业务规则。确定性检查使用随附脚本。记录格式含calls数组；每项有tool、input、output，可选error、durationMs、meta.displayedTotal（用户页面展示的元金额）。

仅在记录支持时判断编码配错、套餐选项无效或特调漏传。缺少上游记录时说明证据缺口，不把缺少证据等同于业务不支持。

执行范围为查询与核价，不通过诊断触发领券、下单、兑换或抽奖。账号数据仅在用户需要检查对应流程时读取；连接烟雾检查只读工具列表与服务器时间。

## 结果

先说明是否实际调用官方工具，再指出出错调用与字段、原因和修正建议。动态门店、商品、券编码从真实上游取得，不编造。

用 `scripts/lib/redact.mjs` 脱敏后输出报告，不索要在对话中粘贴Token。price用代码除以100，注意enjoyed / enjoyable.realDiscount为元的例外。

未发现规则问题时说明检查范围，不宣称整个业务或全部接口通过验证。
