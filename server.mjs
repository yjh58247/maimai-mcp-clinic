import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { McpClient } from './skills/mcd-mcp-clinic/scripts/lib/mcp-client.mjs';
import { analyzeRun, inspectCall, SAFE_TOOLS, TOOL_LABELS } from './skills/mcd-mcp-clinic/scripts/lib/diagnostics.mjs';
import { redact, redactReport } from './skills/mcd-mcp-clinic/scripts/lib/redact.mjs';
import { DEMO_CASES, SAMPLE_INPUTS } from './skills/mcd-mcp-clinic/scripts/lib/demo.mjs';
import { readConfig } from './lib/config.mjs';
import { listenLocal } from './lib/local-server.mjs';
import { hasBusinessError } from './skills/mcd-mcp-clinic/scripts/lib/context.mjs';
import { recordValidationError } from './skills/mcd-mcp-clinic/scripts/lib/records.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = resolve(root, 'public');
const sharedFiles = new Map(['context.mjs', 'records.mjs', 'json-text.mjs', 'redact.mjs', 'lab.mjs'].map(name => ['/' + name, resolve(root, 'skills/mcd-mcp-clinic/scripts/lib', name)]));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('请求应使用 application/json。'), { status: 415 });
  let bytes = 0; const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1_000_000) throw Object.assign(new Error('文件超过1MB，请缩小记录范围后重试。'), { status: 413 });
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('不是有效 JSON，请检查逗号与引号。'), { status: 400 }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('请求内容必须是 JSON 对象。'), { status: 400 });
  return value;
}

export function createApp({ token = '', clientFactory = options => new McpClient(options) } = {}) {
  const client = clientFactory({ token });
  const reports = [];
  let liveCalls = [], busy = false, connected = null;
  const remember = report => { reports.unshift(report); reports.splice(20); return report; };
  const secrets = [token];
  const json = (response, status, data) => {
    const { report, ...rest } = data;
    const safe = redact(rest, secrets);
    if (report) safe.report = redactReport(report, secrets);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(safe));
  };
  const runLive = async task => {
    if (busy) throw Object.assign(new Error('已有真实调用正在运行，请等待完成。'), { status: 409 });
    busy = true;
    try { return await task(); } finally { busy = false; }
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const port = server.address()?.port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(request.headers.host)) return json(response, 403, { error: '仅允许本机访问。' });
      const origin = request.headers.origin;
      if (origin && !hosts.some(host => origin === `http://${host}`)) return json(response, 403, { error: '已拒绝非本机页面的跨域请求。' });
      if (request.headers['sec-fetch-site'] === 'cross-site') return json(response, 403, { error: '已拒绝跨站请求。' });
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (request.method === 'GET' && url.pathname === '/api/status') return json(response, 200, { version: '0.1.7', tokenConfigured: Boolean(token), endpoint: 'https://mcp.mcd.cn', connected: Boolean(connected), tools: [...SAFE_TOOLS].map(name => ({ name, label: TOOL_LABELS[name] })), samples: SAMPLE_INPUTS });
      if (request.method === 'GET' && url.pathname === '/api/demos') return json(response, 200, { cases: DEMO_CASES.map(({ run, ...meta }) => ({ ...meta, report: analyzeRun(run) })) });
      if (request.method === 'GET' && url.pathname === '/api/reports') return json(response, 200, { reports: reports.map(({ id, title, createdAt, source, sourceLabel, summary }) => ({ id, title, createdAt, source, sourceLabel, summary, findingCount: summary.errors + summary.warnings })) });
      if (request.method === 'GET' && url.pathname.startsWith('/api/reports/')) {
        const report = reports.find(item => item.id === url.pathname.slice('/api/reports/'.length));
        return report ? json(response, 200, { report }) : json(response, 404, { error: '这份报告已过期或不存在，请重新检查或导入。' });
      }
      if (request.method === 'POST' && url.pathname === '/api/demo') {
        const body = await readJson(request);
        const example = DEMO_CASES.find(item => item.id === body.caseId);
        if (!example) return json(response, 400, { error: '未找到演示案例。' });
        return json(response, 200, { report: remember(analyzeRun(example.run)) });
      }
      if (request.method === 'POST' && url.pathname === '/api/analyze') {
        const body = await readJson(request);
        const validation = recordValidationError(body);
        if (validation) return json(response, 400, { error: validation });
        return json(response, 200, { report: remember(analyzeRun({ ...body, source: body.format === 'mcd-clinic-report' ? 'import' : 'manual' }, { tools: client.tools, secrets })) });
      }
      if (request.method === 'POST' && url.pathname === '/api/live/connect') {
        await readJson(request);
        return await runLive(async () => {
          if (!token) return json(response, 400, { error: '本机未配置 Token。请按接入指南设置 MCD_MCP_TOKEN 后重启服务。' });
          connected = null; liveCalls = [];
          const started = performance.now();
          try {
            const connection = await client.connect();
            const output = await client.call('now-time-info', {});
            liveCalls.push({ tool: 'now-time-info', input: {}, output, durationMs: Math.round(performance.now() - started) });
            const report = remember(analyzeRun({ source: 'live', title: '真实 MCP 连接检查', calls: liveCalls }, { tools: client.tools, secrets }));
            if (hasBusinessError(output)) return json(response, 502, { error: '服务器时间检查返回业务错误，连接检查未通过。请查看诊断报告。', report });
            connected = connection;
            return json(response, 200, { connection: { serverInfo: connected.serverInfo, protocolVersion: connected.protocolVersion, tools: client.tools.map(t => ({ name: t.name, inputSchema: t.inputSchema, callable: SAFE_TOOLS.has(t.name) })) }, report });
          } catch (error) {
            connected = null;
            const report = remember(analyzeRun({ source: 'live', title: '真实 MCP 连接检查', calls: [{ tool: 'now-time-info', input: {}, error: { status: error.status, message: error.message }, durationMs: Math.round(performance.now() - started) }] }, { secrets }));
            return json(response, 502, { error: error.message, report });
          }
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/live/call') {
        const body = await readJson(request);
        if (!SAFE_TOOLS.has(body.tool)) return json(response, 403, { error: '仅支持查询与核价；不支持创建订单、领券、抽奖或积分兑换。' });
        if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input)) return json(response, 400, { error: '工具参数必须是 JSON 对象。' });
        return await runLive(async () => {
          if (!connected) return json(response, 400, { error: '请先完成真实连接检查。' });
          const context = {};
          const preflight = inspectCall({ tool: body.tool, input: body.input }, context, liveCalls, client.tools);
          if (preflight.some(f => f.severity === 'error')) {
            const report = remember(analyzeRun({ source: 'manual', title: '发送前参数检查 · 已拦截', context, calls: [...liveCalls, { tool: body.tool, input: body.input, note: '未发送到 MCP。' }] }, { tools: client.tools, secrets }));
            return json(response, 422, { error: '参数检查未通过，此次请求没有发送。', report });
          }
          const started = performance.now();
          const call = { tool: body.tool, input: body.input };
          if (body.displayedTotal != null) call.meta = { displayedTotal: body.displayedTotal };
          try { call.output = await client.call(body.tool, body.input); }
          catch (error) { call.error = { status: error.status, message: error.message, ...(error.retryAfter != null ? { retryAfter: error.retryAfter } : {}) }; }
          call.durationMs = Math.round(performance.now() - started);
          liveCalls.push(call); liveCalls = liveCalls.slice(-40);
          const report = remember(analyzeRun({ source: 'live', title: '真实 MCP 调用链路', calls: liveCalls, context }, { tools: client.tools, secrets }));
          const failed = call.error || hasBusinessError(call.output);
          return json(response, failed ? 502 : 200, { report, ...(failed ? { error: '查询未成功，请查看诊断报告中的错误与建议。' } : {}) });
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/live/reset') {
        await readJson(request);
        if (busy) return json(response, 409, { error: '调用运行中，暂时无法重置。' });
        liveCalls = [];
        return json(response, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: '未找到此接口。' });
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: '不支持此请求方法。' });
      let path;
      try { path = decodeURIComponent(url.pathname); } catch { return json(response, 400, { error: '路径编码无效。' }); }
      const file = sharedFiles.get(path) || resolve(publicRoot, '.' + (path === '/' ? '/index.html' : path));
      if ((!sharedFiles.has(path) && !file.startsWith(publicRoot + sep)) || !mime[extname(file)]) return json(response, 404, { error: '文件不存在。' });
      try {
        const content = await readFile(file);
        response.writeHead(200, { 'Content-Type': mime[extname(file)] });
        response.end(request.method === 'HEAD' ? undefined : content);
      } catch { json(response, 404, { error: '文件不存在。' }); }
    } catch (error) { json(response, error.status >= 400 && error.status <= 599 ? error.status : 500, { error: error.message || '处理请求失败。' }); }
  });
  return { server, close: () => client.close() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = readConfig(root);
  const app = createApp(config);
  try {
    const port = await listenLocal(app.server, config.port);
    console.log(`麦麦 MCP 体检站  http://127.0.0.1:${port}\nToken：${config.token ? '已在本机配置' : '未配置，可使用离线演示'}\n按 Ctrl+C 停止。`);
  } catch (error) { console.error(error.code === 'EADDRINUSE' ? '尝试的本机端口均被占用。请设置 PORT 后重试。' : '本地服务启动失败。'); process.exitCode = 1; }
  const stop = async () => { await app.close(); app.server.close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
