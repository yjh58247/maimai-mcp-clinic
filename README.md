# 麦麦 MCP 体检站

**让每一步麦当劳 MCP 调用，都有据可查。**

面向 Skill 开发者的本地诊断工具：发送前检查业务参数，沿调用链定位问题，把排查过程导出成可复现的脱敏报告。包含可安装的诊断 Skill、可视化工作台和命令行工具。

独立参赛作品，非麦当劳官方产品。

![麦麦 MCP 体检站工作台](docs/preview-desktop.jpg)

## 立即体验

需要 **Node.js 22+**。无第三方运行依赖，无需 npm install。

~~~sh
git clone https://github.com/yjh58247/maimai-mcp-clinic.git
cd maimai-mcp-clinic
npm start
~~~

打开 **http://127.0.0.1:4319**。Windows 也可双击 **启动体检站.cmd**。

无需 Token 即可体验4个案例：

- 报价放大100倍：识别分／元混淆及缺少门店券校验。
- 得来速菜单查询失败：发现遗漏的 beCode。
- 健康到店链路：6次调用，从服务器时间到整单核价。
- 401认证失败：给出本机凭证排查建议。

离线案例的门店、商品、价格和耗时均为虚构数据。首页统计来自当前报告，不代表实时接口性能。

## 目标用户与价值

面向麦当劳 MCP 开发者、参赛者与项目维护者。“HTTP成功”不等于业务正确：编码配错、卡包券未校验门店、报价单位转换错误，都可能让完整的点餐流程输出错误结果。

体检站把这些规则变成可执行检查，同时保留出错调用、原因与修正建议，帮助复现和讨论问题。

| 功能 | 行为 |
| --- | --- |
| 连接检查 | initialize → initialized → tools/list（含分页）→ now-time-info |
| 参数诊断 | 当前接口 schema 基础校验，以及渠道、业务编码、预约等检查 |
| 点餐流程调试 | 逐步查询门店、菜单、商品详情、门店券与整单报价 |
| 套餐与特调 | 有上游详情时检查轮次数量、选项、取消项 key 与数量 |
| 金额核对 | 对比页面金额与 calculate-price 的 price / 100 |
| 回放与分享 | JSON导入后重新检查，JSON／Markdown脱敏导出 |

真实模式提供11个查询／核价工具，执行白名单不含创建订单、领券、抽奖或兑换。完整清单见 [MCP_INTEGRATION.md](MCP_INTEGRATION.md)。

v0.1.1 将门店、业务渠道、业务编码与预约时段作为同一组上下文：菜单和特调只复用当前场景的成功响应，切换渠道或时段后重新取得对应数据。非法套餐与特调参数会给出具体字段路径，发送前拦截报告保留必要的上游证据。详见 [优化记录](docs/OPTIMIZATION.md)。

v0.1.2 补齐必选套餐轮次和整组特调遗漏检查，识别重复轮次及未知特调项。连接检查和真实查询明确显示业务失败；重连会清除旧会话与旧工具列表。网页、CLI及服务共用报告格式校验，异常导入给出可操作的提示。76项测试通过。

## 接入真实 MCP

1. 在 [麦当劳开放平台](https://open.mcd.cn/mcp) 登录并申请 Token。
2. 本机运行 `Copy-Item .env.example .env`；macOS / Linux 使用 `cp .env.example .env`。
3. 编辑本机 `.env`，填写 `MCD_MCP_TOKEN`，重启服务。
4. 网页切换“真实接入”，点击“检查连接”。
5. 调用诊断中选择 `query-nearby-stores`，填写城市、关键词并发送。
6. 从已查询门店选择门店，切换 `query-meals`，填入模板后查询。
7. 从当前菜单选择商品，查询 `query-meal-detail`；接着检查门店券或核价。
8. `calculate-price` 模板会带入已记录的默认套餐／特调。发送前确认参数。

网页不接收 Token；凭证只由本机服务读取。服务绑定127.0.0.1，环境变量优先于.env，改变配置后需重启。

报告隐藏券码、地址和订单标识，因此这些标识不能从脱敏报告复制回真实请求。携带它们调试时，从自己的可信本机上游记录取得。分享前检查自由文本是否含额外个人信息。

## 诊断 Skill

将 `skills/mcd-mcp-clinic` 文件夹导入客户端，或复制到该客户端的技能目录。该文件夹自带完整CLI脚本。

> 帮我检查这段麦当劳 MCP 调用，为什么查到门店后读菜单失败？
>
> 接口返回2740，我的页面显示2740元，帮我定位问题。
>
> 检查这份回放，生成脱敏诊断报告。

已有官方 MCP 连接时，Skill 可复用现有工具。独立CLI连接从环境变量读取凭证，不在对话中索要Token。

## 命令行

~~~sh
node skills/mcd-mcp-clinic/scripts/clinic.mjs demo price-unit
node skills/mcd-mcp-clinic/scripts/clinic.mjs demo healthy --json
node skills/mcd-mcp-clinic/scripts/clinic.mjs demo healthy --out report.json
node skills/mcd-mcp-clinic/scripts/clinic.mjs inspect report.json

# 真实连接需预先在本机设置环境变量；CLI不读取项目.env
node skills/mcd-mcp-clinic/scripts/clinic.mjs connect
node skills/mcd-mcp-clinic/scripts/clinic.mjs call query-nearby-stores examples/store-search.json
~~~

退出码0：记录内检查通过；2：存在需修复项；1：文件、网络或执行错误。

## 验证

~~~sh
npm test
npm run check
~~~

测试覆盖业务规则、JSON/SSE传输、会话恢复、脱敏和本机接口。真实公共数据与原生HTTP客户端的验证区别见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

v0.1.1原生HTTP已完成官方端到端联调，发现35个工具，5次公共查询与无券核价通过；v0.1.2本轮重测遇到TLS连接中断，未取得新的实时结果。配置好本机.env后，可运行 `node scripts/native-smoke.mjs` 重测；此前成功报告见 [原生HTTP验收](docs/NATIVE_HTTP_VERIFICATION.md)。

报告只在当前服务内保留最近20份，重启清空。导入记录标注“未进行实时验证”，不会当成当前官方结果。

## 结构与参赛材料

~~~text
public/                       工作台页面、样式、交互
server.mjs                    本机API、执行白名单、报告会话
lib/config.mjs                本机配置读取
skills/mcd-mcp-clinic/         可独立安装的Skill及CLI
tests/                        业务、协议与服务测试
docs/                         验收与演示脚本
examples/                     查询示例与真实公共数据快照
~~~

已提供README、官方原文声明、MCP接入说明、脱敏配置和源码。[SUBMISSION.md](SUBMISSION.md) 包含本项目报名正文。

WorkBuddy专项需真实开发或调试，并导出 `workbuddy.md`。当前仅提供 [WORKBUDDY_GUIDE.md](WORKBUDDY_GUIDE.md)，没有伪造上下文文件。

原创代码采用 [MIT](LICENSE)。官方声明、商标和接口数据不因本项目代码许可而重新授权。
