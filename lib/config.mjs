import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readConfig(root = process.cwd()) {
  const local = {};
  try {
    for (const line of readFileSync(resolve(root, '.env'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || !['MCD_MCP_TOKEN', 'PORT'].includes(match[1])) continue;
      local[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取本机 .env 文件。'); }
  const token = (process.env.MCD_MCP_TOKEN || local.MCD_MCP_TOKEN || '').trim();
  const port = Number(process.env.PORT || local.PORT || 4319);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 应为1至65535的整数。');
  return { token, port };
}
