# 从下载到第一份报告

先体验离线案例，再按需连接真实麦当劳 MCP。离线体验无需账号或 Token。

## 1. 准备运行环境

安装 [Node.js](https://nodejs.org/en/download)，版本需为 22 或更高。在终端运行 `node --version` 检查版本。项目无需安装第三方依赖。

## 2. 下载并启动

在 [GitHub Releases](https://github.com/yjh58247/maimai-mcp-clinic/releases/latest) 的 Assets 区域下载 `maimai-mcp-clinic-v版本号.zip`，完整解压。发布包带有 `SHA256SUMS.txt`，可用于核对下载文件。

进入解压后的 `maimai-mcp-clinic` 文件夹，确认能看到 `package.json` 和 `server.mjs`。

- Windows：双击 `启动体检站.cmd`，保留打开的终端窗口。
- macOS / Linux：在该文件夹打开终端，运行 `node server.mjs`。

在浏览器地址栏输入终端输出的本机地址，例如 `http://127.0.0.1:4319`。端口占用时会自动顺延，以终端输出为准。

开发者也可使用 [README 中的 Git 克隆步骤](../README.md#无需-token先试用)。

## 3. 对比两份离线报告

在“体检总览”选择“报价怎么放大了100倍？”，点击“运行体检”。查看 `calculate-price` 的金额单位提示：2740 分应显示为 27.40 元。报告还会指出缺少门店券校验证据。

再选择“一条完整的健康链路”，运行后应有 6 次调用全部通过、0 项问题。点击调用记录查看参数与响应，理解时间、门店、菜单、详情、券校验和核价的先后关系。

这些数据均为虚构演示。真实接口查询需要另行配置凭证。

## 4. 导出与回放

进入“报告回放”，选择报告并导出 JSON 或 Markdown。JSON 可通过“导入回放”再次检查；导入报告标记为“未进行实时验证”。服务只保留最近 20 份报告，重启会清空，需保留的报告请先导出。

也可直接在终端体验：

~~~sh
node skills/mcd-mcp-clinic/scripts/clinic.mjs demo healthy --json
node skills/mcd-mcp-clinic/scripts/clinic.mjs demo price-unit
~~~

第二条命令会输出诊断并以退出码 2 结束，表示案例包含需修复项，属于预期行为。

## 5. 按需接入真实 MCP

按照 [README 的接入步骤](../README.md#接入真实-mcp)申请 Token，在本机配置 `.env` 并重启服务，再切换“真实接入”。网页不会要求填写 Token。

独立 CLI 从环境变量读取凭证，不读取项目 `.env`；客户端 MCP 配置示例见 [mcp-config.example.json](../mcp-config.example.json)。具体调用流程见 [MCP_INTEGRATION.md](../MCP_INTEGRATION.md)。

遇到问题时查看[故障排查](TROUBLESHOOTING.md)，或使用[问题模板](https://github.com/yjh58247/maimai-mcp-clinic/issues/new/choose)反馈。
