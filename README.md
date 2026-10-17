# 麦麦 MCP 体检站

**让每一步麦当劳 MCP 调用，都有据可查。**

面向 Skill 开发者的本地诊断工具：发送前检查业务参数，沿调用链定位问题，把排查过程导出成可复现的脱敏报告。包含可安装的诊断 Skill、可视化工作台和命令行工具。

McDonald's MCP Clinic — a local Model Context Protocol (MCP) debugging toolkit with request validation, call replay and redacted reports.

独立参赛作品，非麦当劳官方产品。支持 Windows、macOS、Linux；需要 **Node.js 22+**，无第三方运行依赖，无需 `npm install`。

[下载最新版](https://github.com/yjh58247/maimai-mcp-clinic/releases/latest) · [上手指南](docs/QUICKSTART.md) · [常见问题](docs/TROUBLESHOOTING.md) · [反馈问题／建议](https://github.com/yjh58247/maimai-mcp-clinic/issues/new/choose)

## 无需 Token，先试用

**不熟悉 Git？** 在[下载页](https://github.com/yjh58247/maimai-mcp-clinic/releases/latest)的 Assets 中下载 `maimai-mcp-clinic-v版本号.zip`，解压后进入包含 `package.json` 的文件夹。Windows 双击 **启动体检站.cmd**；macOS / Linux 在该文件夹打开终端，执行 `node server.mjs`。

已有 Git 的开发者可以直接运行：

~~~sh
git clone https://github.com/yjh58247/maimai-mcp-clinic.git
cd maimai-mcp-clinic
node server.mjs
~~~

在浏览器打开终端输出的地址，默认是 **http://127.0.0.1:4319**；端口被占用时最多顺延9个端口。运行期间保留终端窗口。

首页选择“报价怎么放大了100倍？”，点击“运行体检”，查看金额单位与门店券校验证据提示；再选择“一条完整的健康链路”，对比6次调用全部通过的报告。全部4个案例包括：

- 报价放大100倍：识别分／元混淆及缺少门店券校验。
- 得来速菜单查询失败：发现遗漏的 beCode。
- 健康到店链路：6次调用，从服务器时间到整单核价。
- 401认证失败：给出本机凭证排查建议。

离线案例的门店、商品、价格和耗时均为虚构数据。首页统计来自当前报告，不代表实时接口性能。

![麦麦 MCP 体检站工作台](docs/preview-desktop.jpg)

界面截图来自 v0.1.0。v0.1.5 加强 schema 检查和传输边界处理，详见[边界修复记录](docs/BOUNDARY_FIXES.md)；此前的全面检查见 [v0.1.3 检查记录](docs/AUDIT.md)。

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

参数检查以当前接口 schema 和可用上游证据为准；通过检查不代表覆盖了所有业务约束。[优化记录](docs/OPTIMIZATION.md)保留各版本的改动与验证边界。

## 接入真实 MCP

1. 在 [麦当劳开放平台](https://open.mcd.cn/mcp) 登录并申请 Token。
2. 本机运行 `Copy-Item .env.example .env`；macOS / Linux 使用 `cp .env.example .env`。
3. 编辑本机 `.env`，填写 `MCD_MCP_TOKEN`，重启服务。
4. 网页切换“真实接入”，点击“检查连接”。
5. 调用诊断中选择 `query-nearby-stores`，填写城市、关键词并发送。
6. 从已查询门店选择门店，切换 `query-meals`，填入模板后查询。
7. 从当前菜单选择商品，查询 `query-meal-detail`；接着检查门店券或核价。
8. `calculate-price` 模板会带入已记录的默认套餐／特调。发送前确认参数。

网页不接收 Token；凭证只由本机服务读取。服务绑定127.0.0.1，环境变量优先于.env（显式空Token可关闭真实接入），改变配置后需重启。

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
node --test tests/*.test.mjs
node scripts/check.mjs
~~~

也可使用 `npm test` 与 `npm run check`。测试覆盖业务规则、JSON/SSE传输、会话恢复、脱敏和本机接口。真实公共数据与原生HTTP客户端的验证区别见 [验收记录](docs/VERIFICATION.md)。

v0.1.5原生HTTP重新完成官方端到端联调，发现35个工具，5次公共查询与无券核价通过。配置好本机.env后，可运行 `node scripts/native-smoke.mjs` 重测；本轮成功报告见 [原生HTTP验收](docs/NATIVE_HTTP_VERIFICATION.md)。

报告只在当前服务内保留最近20份，重启清空。导入记录标注“未进行实时验证”，不会当成当前官方结果。

## 反馈与参与

遇到问题，先查看[常见问题](docs/TROUBLESHOOTING.md)，再通过[问题模板](https://github.com/yjh58247/maimai-mcp-clinic/issues/new/choose)提供版本、复现步骤和检查过的脱敏报告。项目欢迎实际使用反馈；如果它帮助你定位了问题，欢迎 Star 收藏，方便下次找到。

## 结构与参赛材料

~~~text
public/                       工作台页面、样式、交互
server.mjs                    本机API、执行白名单、报告会话
lib/                          本机配置读取、可用端口选择
skills/mcd-mcp-clinic/         可独立安装的Skill及CLI
tests/                        业务、协议与服务测试
docs/                         验收与演示脚本
examples/                     查询示例与真实公共数据快照
~~~

已提供README、官方原文声明、MCP接入说明、脱敏配置和源码。[SUBMISSION.md](SUBMISSION.md) 包含本项目报名正文。

WorkBuddy专项需真实开发或调试，并导出 `workbuddy.md`。当前仅提供 [WORKBUDDY_GUIDE.md](WORKBUDDY_GUIDE.md)，没有伪造上下文文件。

原创代码采用 [MIT](LICENSE)。官方声明、商标和接口数据不因本项目代码许可而重新授权。
