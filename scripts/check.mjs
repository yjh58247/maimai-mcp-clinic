import { readdir, readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
let count = 0;
async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'reports'].includes(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (['.js', '.mjs'].includes(extname(path))) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      count++;
    } else if (extname(path) === '.json') JSON.parse(await readFile(path, 'utf8'));
  }
}
await check(root);
for (const file of ['README.md', 'CONTEST_DECLARATION.md', 'MCP_INTEGRATION.md', 'mcp-config.example.json', 'skills/mcd-mcp-clinic/SKILL.md']) await readFile(resolve(root, file));
console.log(count + ' JavaScript files passed syntax checks; JSON and required project files checked.');
