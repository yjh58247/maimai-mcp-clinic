import { SAFE_TOOLS } from './diagnostics.mjs';

export class McpError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'McpError'; this.status = status; }
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
    let reader;
    try {
      const response = await this.fetch(this.endpoint, {
        method: 'POST', headers, redirect: 'error', signal: controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) })
      });
      if (!response.ok) throw new McpError(`MCP HTTP ${response.status}${response.status === 429 ? '：请求频率过高' : ''}`, response.status);
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
      throw new McpError('无法连接麦当劳 MCP，请检查网络或本机代理。');
    } finally {
      clearTimeout(timer);
      try { await reader?.cancel(); } catch {}
    }
  }
  async connect() {
    this.session = null;
    const info = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'maimai-mcp-clinic', version: '0.1.0' } });
    if (!['2025-06-18', '2025-03-26'].includes(info.protocolVersion)) throw new McpError('服务端返回了本版本体检站尚未支持的协议版本。');
    this.version = info.protocolVersion;
    await this.rpc('notifications/initialized', null, true);
    const list = []; let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await this.rpc('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result.tools)) throw new McpError('tools/list 未返回工具数组。');
      list.push(...result.tools); cursor = result.nextCursor;
      if (!cursor) { this.tools = list; return { serverInfo: info.serverInfo, protocolVersion: this.version, tools: list }; }
    }
    throw new McpError('工具分页超过10页，已停止读取。');
  }
  async call(name, args) {
    if (!SAFE_TOOLS.has(name)) throw new McpError('体检站只执行列出的查询与核价工具。', 403);
    if (!this.tools.length) await this.connect();
    if (!this.tools.some(t => t.name === name)) throw new McpError('当前 tools/list 未发现该工具。', 400);
    try { return await this.rpc('tools/call', { name, arguments: args }); }
    catch (error) {
      // Only whitelisted read operations are retried, and only once after session expiry.
      if (error.status !== 404 || !this.session) throw error;
      await this.connect();
      return await this.rpc('tools/call', { name, arguments: args });
    }
  }
  async close() {
    if (!this.session || !this.token) return;
    try { await this.fetch(this.endpoint, { method: 'DELETE', redirect: 'error', headers: { Authorization: `Bearer ${this.token}`, 'Mcp-Session-Id': this.session, 'MCP-Protocol-Version': this.version }, signal: AbortSignal.timeout(3000) }); } catch {}
    this.session = null;
  }
}
