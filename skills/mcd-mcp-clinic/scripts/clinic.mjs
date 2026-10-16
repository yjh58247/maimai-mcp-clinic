#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { McpClient } from './lib/mcp-client.mjs';
import { analyzeRun, inspectCall, SAFE_TOOLS } from './lib/diagnostics.mjs';
import { DEMO_CASES } from './lib/demo.mjs';
import { markdownReport, redact } from './lib/redact.mjs';

const args = process.argv.slice(2);
const command = args[0];
const option = name => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
const client = new McpClient({ token: process.env.MCD_MCP_TOKEN });
let report;
try {
  if (command === 'demo') {
    const example = DEMO_CASES.find(c => c.id === (args[1] || 'price-unit'));
    if (!example) throw new Error('案例名称：price-unit、missing-code、healthy、auth。');
    report = analyzeRun(example.run);
  } else if (command === 'inspect') {
    const text = await readFile(args[1], 'utf8');
    if (Buffer.byteLength(text) > 1_000_000) throw new Error('导入文件超过1MB。');
    const raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!Array.isArray(raw.calls) || raw.calls.length > 100) throw new Error('需要包含 calls 数组的记录（最多100条）。');
    report = analyzeRun({ ...raw, source: 'import' }, { secrets: [process.env.MCD_MCP_TOKEN] });
  } else if (command === 'connect' || command === 'call') {
    if (command === 'call' && !SAFE_TOOLS.has(args[1])) throw new Error('此工具不在查询与核价白名单中。');
    await client.connect();
    const tool = command === 'connect' ? 'now-time-info' : args[1];
    const input = command === 'connect' ? {} : JSON.parse(await readFile(args[2], 'utf8'));
    const findings = inspectCall({ tool, input }, {}, [], client.tools);
    if (findings.some(f => f.severity === 'error')) report = analyzeRun({ source: 'manual', title: '参数检查拦截 · 未发送', calls: [{ tool, input }] }, { tools: client.tools, secrets: [process.env.MCD_MCP_TOKEN] });
    else {
      const started = performance.now();
      let output, error;
      try { output = await client.call(tool, input); } catch (err) { error = { status: err.status, message: err.message }; }
      report = analyzeRun({ source: 'live', calls: [{ tool, input, output, error, durationMs: Math.round(performance.now() - started) }] }, { tools: client.tools, secrets: [process.env.MCD_MCP_TOKEN] });
    }
  } else {
    console.log('麦麦 MCP 体检站\n\nnode clinic.mjs demo [price-unit|missing-code|healthy|auth]\nnode clinic.mjs inspect <report.json>\nnode clinic.mjs connect\nnode clinic.mjs call <tool-name> <arguments.json>\n\n选项：--json  输出JSON；--out <report.md|report.json> 保存报告\n真实接入从环境变量 MCD_MCP_TOKEN 读取凭证。');
  }
  if (report) {
    const asJson = args.includes('--json');
    console.log(asJson ? JSON.stringify(report, null, 2) : markdownReport(report));
    const output = option('--out');
    if (output) await writeFile(output, output.endsWith('.json') ? JSON.stringify(report, null, 2) : markdownReport(report), 'utf8');
    if (report.summary.errors) process.exitCode = 2;
  }
} catch (error) {
  console.error(redact(error.message, [process.env.MCD_MCP_TOKEN])); process.exitCode = 1;
} finally { await client.close(); }
