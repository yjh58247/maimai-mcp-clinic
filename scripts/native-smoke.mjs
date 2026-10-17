import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readConfig } from '../lib/config.mjs';
import { McpClient } from '../skills/mcd-mcp-clinic/scripts/lib/mcp-client.mjs';
import { analyzeRun, extractPayload, inspectCall } from '../skills/mcd-mcp-clinic/scripts/lib/diagnostics.mjs';
import { redact, markdownReport, stringifyReport } from '../skills/mcd-mcp-clinic/scripts/lib/redact.mjs';
import { requestTemplate } from '../skills/mcd-mcp-clinic/scripts/lib/context.mjs';
import { SAMPLE_INPUTS } from '../skills/mcd-mcp-clinic/scripts/lib/demo.mjs';

const root = resolve(import.meta.dirname, '..');
const { token } = readConfig(root);
if (!token) {
  console.error('请先在本机项目 .env 中填写 MCD_MCP_TOKEN。不要在聊天中发送凭证。');
  process.exit(3);
}
const client = new McpClient({ token });
const calls = [];
let phase = 'initialize / tools/list';
let connection;
async function invoke(tool, input) {
  phase = tool;
  const preflight = inspectCall({ tool, input }, {}, calls, client.tools);
  if (preflight.some(finding => finding.severity === 'error')) throw new Error('原生联调参数检查未通过：' + preflight.map(f => f.code).join(', '));
  const started = performance.now();
  const output = await client.call(tool, input);
  calls.push({ tool, input, output, durationMs: Math.round(performance.now() - started) });
  const checked = analyzeRun({ calls: [calls.at(-1)] }, { secrets: [token] });
  if (checked.summary.errors) throw new Error('官方工具返回异常：' + checked.findings.map(f => f.title).join('；'));
  console.log(tool + '：成功');
  return extractPayload(output)?.data;
}
try {
  console.log('开始原生 Streamable HTTP 联调，仅查询公共门店数据和无券报价。');
  connection = await client.connect();
  console.log('握手和工具发现：成功；工具数 ' + client.tools.length);
  const time = await invoke('now-time-info', {});
  const stores = await invoke('query-nearby-stores', { beType: 1, searchType: 2, city: '上海市', keyword: '人民广场' });
  const store = stores?.find(item => item.businessStatus !== false && item.storeCode);
  if (!store) throw new Error('位置查询未取得可用门店。');
  const context = { storeCode: store.storeCode, beType: 1, orderType: 1 };
  const menu = await invoke('query-meals', context);
  const codes = Object.keys(menu?.meals || {});
  const productCode = codes.includes('1100') ? '1100' : codes[0];
  if (!productCode) throw new Error('当前门店未返回餐品。');
  await invoke('query-meal-detail', { ...context, code: productCode });
  const quoteInput = requestTemplate(SAMPLE_INPUTS['calculate-price'], { context, productCode, calls });
  const quote = await invoke('calculate-price', quoteInput);
  if (!Number.isFinite(quote?.price)) throw new Error('核价结果缺少数值 price。');
  calls.at(-1).meta = { displayedTotal: quote.price / 100 };
  const evidence = { transport: '本项目原生 Streamable HTTP 客户端', endpoint: client.endpoint, protocolVersion: connection.protocolVersion, serverInfo: connection.serverInfo, toolCount: client.tools.length, serverDate: time?.date };
  const report = analyzeRun({ source: 'live', title: '原生 HTTP 官方端到端联调', context: { evidence }, calls }, { tools: client.tools, secrets: [token] });
  if (report.summary.errors) throw new Error('链路报告存在需修复项。');
  await writeFile(resolve(root, 'examples/native-http-smoke.json'), stringifyReport(report), 'utf8');
  await writeFile(resolve(root, 'docs/NATIVE_HTTP_VERIFICATION.md'), markdownReport(report), 'utf8');
  console.log(JSON.stringify(redact({ status: 'passed', protocolVersion: connection.protocolVersion, toolCount: client.tools.length, calls: calls.length, storeCode: store.storeCode, productCode, priceYuan: quote.price / 100, warnings: report.summary.warnings, reportTruncated: Boolean(report.truncation?.truncated) }, [token])));
} catch (error) {
  console.error(JSON.stringify(redact({ status: 'failed', phase, error: error.message, completedCalls: calls.length }, [token])));
  process.exitCode = 1;
} finally {
  await client.close();
}
