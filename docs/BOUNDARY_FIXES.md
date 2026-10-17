# v0.1.5：诊断与传输边界修复

日期：2026-10-17（北京时间）。本轮先用6项回归复现旧版失败，再修复并补充覆盖有效输入、长数组末项及本机发送前拦截的测试。

| 场景 | 旧版行为 | 修复后行为 |
| --- | --- | --- |
| 含表情字符的字符串长度 | `🍔` 被计为2，可能误报过长或漏报过短 | 按 Unicode 码点计数；不等同于用户感知的字形数 |
| 带 schema 的额外对象字段 | 忽略 `additionalProperties` 中的类型与必填规则 | 递归检查；结合 `properties`、`patternProperties` 判断字段归属 |
| 15万项错误数组（JSON小于1MB） | 收集并展开全部错误时栈溢出 | 最多收集原本就展示的8条 schema 错误；返回诊断而不是500 |
| JSON-RPC 错误码404 | 误触发会话重建和再次调用 | 与 HTTP 状态区分；只有携带会话的 HTTP 404 触发一次重连 |
| SSE 使用单独CR换行 | 流结束后报未收到响应 | 兼容 CR、LF、CRLF，包括 CRLF 跨数据块的情况 |
| 关闭会话的 DELETE 响应 | 没有释放未读取的响应体 | 取消未读取的响应体，并清除本机会话状态 |

长数组检查会遍历尚未发现错误的成员：第15万项才出错仍能定位，不是只检查前8项。发现8条 schema 错误后停止收集，可修复后重测。原有最多100条调用、1MB请求体与3MB上游响应体限制保留。

本机接口回归确认：上述错误数组在发送前返回422，查询工具没有被执行。新增的字段匹配测试同时覆盖允许的额外字段、合法模式字段、重叠规则及无效正则定义。

依据：[JSON Schema 字符串长度规则](https://json-schema.org/draft/2020-12/json-schema-validation#section-6.3)、[对象字段规则](https://json-schema.org/draft/2020-12/json-schema-core#section-10.3.2)、[SSE 换行规则](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)、[MCP HTTP 会话管理](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management)。

仍为基础 schema 检查器，未实现完整 JSON Schema 方言或所有组合、引用规则。完整回归与真实联调结果见[验收记录](VERIFICATION.md)；浏览器视觉复查仍受既有URL安全策略限制。
