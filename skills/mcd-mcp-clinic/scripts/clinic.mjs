#!/usr/bin/env node
import { open, writeFile } from 'node:fs/promises';
import { McpClient } from './lib/mcp-client.mjs';
import { analyzeRun, inspectCall, SAFE_TOOLS } from './lib/diagnostics.mjs';
import { DEMO_CASES } from './lib/demo.mjs';
import { markdownReport, redact } from './lib/redact.mjs';
import { recordValidationError } from './lib/records.mjs';

const args = process.argv.slice(2);
const client = new McpClient({ token: process.env.MCD_MCP_TOKEN });
const help = '麦麦 MCP 体检站\n\nnode clinic.mjs demo [price-unit|missing-code|healthy|auth]\nnode clinic.mjs inspect <report.json>\nnode clinic.mjs connect\nnode clinic.mjs call <tool-name> <arguments.json>\n\n选项：--json  输出JSON；--out <report.md|report.json> 保存报告；--help 查看帮助\n真实接入从环境变量 MCD_MCP_TOKEN 读取凭证。';
function parseArgs() {
  const positional = [], options = { json: false, out: null, help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') options.json = true;
    else if (['--help', '-h'].includes(arg)) options.help = true;
    else if (arg === '--out') {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--out 后需要报告文件路径。');
      options.out = args[++index];
    } else if (arg.startsWith('--')) throw new Error('未知选项：' + arg);
    else positional.push(arg);
  }
  const [command, ...parameters] = positional;
  if (!command || options.help) return { ...options, help: true };
  const counts = { demo: [0, 1], inspect: [1], connect: [0], call: [2] };
  if (!Object.hasOwn(counts, command)) throw new Error('未知命令；运行 --help 查看用法。');
  if (!counts[command].includes(parameters.length)) throw new Error('命令参数数量不正确；运行 --help 查看用法。');
  return { ...options, command, parameters };
}
async function readJsonFile(path) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1_000_000) throw new Error('需要不超过1MB的JSON文件。');
    const buffer = Buffer.alloc(1_000_001); let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > 1_000_000) throw new Error('JSON文件超过1MB。');
    try { return JSON.parse(buffer.toString('utf8', 0, length).replace(/^\uFEFF/, '')); }
    catch { throw new Error('不是有效JSON，请检查引号与逗号。'); }
  } finally { await file.close(); }
}
let report;
try {
  const options = parseArgs();
  const { command, parameters = [] } = options;
  if (options.help) console.log(help);
  if (command === 'demo') {
    const example = DEMO_CASES.find(c => c.id === (parameters[0] || 'price-unit'));
    if (!example) throw new Error('案例名称：price-unit、missing-code、healthy、auth。');
    report = analyzeRun(example.run);
  } else if (command === 'inspect') {
    const raw = await readJsonFile(parameters[0]);
    const validation = recordValidationError(raw);
    if (validation) throw new Error(validation);
    report = analyzeRun({ ...raw, source: 'import' }, { secrets: [process.env.MCD_MCP_TOKEN] });
  } else if (command === 'connect' || command === 'call') {
    if (command === 'call' && !SAFE_TOOLS.has(parameters[0])) throw new Error('此工具不在查询与核价白名单中。');
    const tool = command === 'connect' ? 'now-time-info' : parameters[0];
    const input = command === 'connect' ? {} : await readJsonFile(parameters[1]);
    let findings = inspectCall({ tool, input });
    if (!findings.some(f => f.severity === 'error')) { await client.connect(); findings = inspectCall({ tool, input }, {}, [], client.tools); }
    if (findings.some(f => f.severity === 'error')) report = analyzeRun({ source: 'manual', title: '参数检查拦截 · 未发送', calls: [{ tool, input }] }, { tools: client.tools, secrets: [process.env.MCD_MCP_TOKEN] });
    else {
      const started = performance.now();
      let output, error;
      try { output = await client.call(tool, input); } catch (err) { error = { status: err.status, message: err.message, ...(err.retryAfter != null ? { retryAfter: err.retryAfter } : {}) }; }
      report = analyzeRun({ source: 'live', calls: [{ tool, input, output, error, durationMs: Math.round(performance.now() - started) }] }, { tools: client.tools, secrets: [process.env.MCD_MCP_TOKEN] });
    }
  }
  if (report) {
    console.log(options.json ? JSON.stringify(report, null, 2) : markdownReport(report));
    const output = options.out;
    if (output) await writeFile(output, output.endsWith('.json') ? JSON.stringify(report, null, 2) : markdownReport(report), 'utf8');
    if (report.summary.errors) process.exitCode = 2;
  }
} catch (error) {
  console.error(redact(error.message, [process.env.MCD_MCP_TOKEN])); process.exitCode = 1;
} finally { await client.close(); }
