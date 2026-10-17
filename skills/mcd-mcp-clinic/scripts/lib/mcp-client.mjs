import { SAFE_TOOLS } from './diagnostics.mjs';
import { isRecord } from './context.mjs';

export class McpError extends Error {
  constructor(message, status = 0, { retryAfter } = {}) {
    super(message); this.name = 'McpError'; this.status = status;
    if (Number.isFinite(retryAfter) && retryAfter >= 0) this.retryAfter = retryAfter;
  }
}

export class McpClient {
  constructor({ token, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.endpoint = 'https://mcp.mcd.cn';
    this.session = null;
    this.version = '2025-06-18';
    this.seq = 0;
    this.tools = [];
  }
  async rpc(method, params, notification = false) {
    if (!this.token) throw new McpError('本机未配置 MCD_MCP_TOKEN。', 401);
    const id = ++this.seq;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${this.token}` };
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    if (method !== 'initialize') headers['MCP-Protocol-Version'] = this.version;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let reader, response;
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST', headers, redirect: 'error', signal: controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) })
      });
      if (!response.ok) {
        const header = response.headers.get('retry-after');
        const seconds = header && /^\d+$/.test(header) ? Number(header) : header ? Math.ceil((Date.parse(header) - Date.now()) / 1000) : undefined;
        const retryAfter = Number.isFinite(seconds) ? Math.max(0, seconds) : undefined;
        throw new McpError(`MCP HTTP ${response.status}${response.status === 429 ? '：请求频率过高' : ''}${retryAfter != null ? `；建议等待${retryAfter}秒后手动重试` : ''}`, response.status, { retryAfter });
      }
      if (method === 'initialize') this.session = response.headers.get('mcp-session-id');
      if (notification) { await response.body?.cancel(); return null; }
      const isStream = response.headers.get('content-type')?.includes('text/event-stream');
      reader = response.body?.getReader();
      if (!reader) throw new McpError('服务端未返回响应体。');
      const decoder = new TextDecoder();
      let buffer = '', bytes = 0;
      const unpack = message => {
        if (message?.jsonrpc !== '2.0' || message.id !== id) return undefined;
        if (message.error) throw new McpError(`JSON-RPC ${message.error.code}: ${message.error.message}`, message.error.code);
        if (!Object.hasOwn(message, 'result')) throw new McpError('响应缺少 result。');
        return { value: message.result };
      };
      while (true) {
        const { value, done } = await reader.read();
        if (value) { bytes += value.byteLength; buffer += decoder.decode(value, { stream: true }); }
        if (bytes > 3_000_000) throw new McpError('响应超过3MB，已停止读取。');
        if (isStream) {
          buffer = buffer.replace(/\r\n/g, '\n');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data || data === '[DONE]') continue;
            let message; try { message = JSON.parse(data); } catch { throw new McpError('SSE 数据不是有效 JSON。'); }
            const result = unpack(message);
            if (result) return result.value;
          }
        }
        if (done) {
          buffer += decoder.decode();
          if (isStream) throw new McpError('SSE 流结束，但未收到当前请求的响应。');
          let message; try { message = JSON.parse(buffer); } catch { throw new McpError('服务端返回了无效 JSON。'); }
          const result = unpack(message);
          if (!result) throw new McpError('响应 ID 与当前请求不一致。');
          return result.value;
        }
      }
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (controller.signal.aborted) throw new McpError('MCP 请求超时，已停止等待。', 408);
      const code = error.cause?.code || error.code;
      if (['ECONNRESET', 'UND_ERR_SOCKET'].includes(code)) throw new McpError('连接在握手或传输中断，请检查网络或本机代理后手动重试。');
      if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) throw new McpError('无法解析 MCP 服务器地址，请检查本机 DNS 与网络。');
      if (['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(code)) throw new McpError('TLS 证书校验失败，请检查系统时间及本机可信证书配置。');
      throw new McpError('无法连接麦当劳 MCP，请检查网络或本机代理。');
    } finally {
      clearTimeout(timer);
      try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch {}
    }
  }
  async connect() {
    await this.close();
    this.version = '2025-06-18';
    try {
      const info = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'maimai-mcp-clinic', version: '0.1.3' } });
      if (!isRecord(info) || !['2025-06-18', '2025-03-26'].includes(info.protocolVersion)) throw new McpError('服务端返回了本版本体检站尚未支持的协议版本。');
      this.version = info.protocolVersion;
      await this.rpc('notifications/initialized', null, true);
      const list = [], cursors = new Set(); let cursor;
      for (let page = 0; page < 10; page++) {
        const result = await this.rpc('tools/list', cursor ? { cursor } : {});
        if (!isRecord(result) || !Array.isArray(result.tools) || result.tools.some(tool => !isRecord(tool) || typeof tool.name !== 'string' || !tool.name.trim())) throw new McpError('tools/list 未返回有效的工具数组。');
        list.push(...result.tools); cursor = result.nextCursor;
        if (!cursor) { this.tools = list; return { serverInfo: info.serverInfo, protocolVersion: this.version, tools: list }; }
        if (typeof cursor !== 'string' || cursors.has(cursor)) throw new McpError('工具分页游标无效或重复，已停止读取。');
        cursors.add(cursor);
      }
      throw new McpError('工具分页超过10页，已停止读取。');
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async call(name, args) {
    if (!SAFE_TOOLS.has(name)) throw new McpError('体检站只执行列出的查询与核价工具。', 403);
    if (!isRecord(args)) throw new McpError('工具参数必须是 JSON 对象。', 400);
    if (!this.tools.length) await this.connect();
    if (!this.tools.some(t => t.name === name)) throw new McpError('当前 tools/list 未发现该工具。', 400);
    const invoke = async () => {
      if (!this.tools.some(t => t.name === name)) throw new McpError('当前 tools/list 未发现该工具。', 400);
      const result = await this.rpc('tools/call', { name, arguments: args });
      if (!isRecord(result)) throw new McpError('工具响应不是有效的 JSON 对象。');
      return result;
    };
    try { return await invoke(); }
    catch (error) {
      // Only whitelisted read operations are retried, and only once after session expiry.
      if (error.status !== 404 || !this.session) throw error;
      await this.connect();
      return await invoke();
    }
  }
  async close() {
    const session = this.session;
    this.session = null;
    this.tools = [];
    if (!session || !this.token) return;
    try { await this.fetch(this.endpoint, { method: 'DELETE', redirect: 'error', headers: { Authorization: `Bearer ${this.token}`, 'Mcp-Session-Id': session, 'MCP-Protocol-Version': this.version }, signal: AbortSignal.timeout(3000) }); } catch {}
  }
}
