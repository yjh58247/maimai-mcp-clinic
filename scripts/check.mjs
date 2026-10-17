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
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
for (const file of ['server.mjs', 'skills/mcd-mcp-clinic/scripts/lib/mcp-client.mjs', 'public/index.html']) {
  if (!(await readFile(resolve(root, file), 'utf8')).includes(pkg.version)) throw new Error('Version mismatch: ' + file);
}
const html = await readFile(resolve(root, 'public/index.html'), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
if (new Set(ids).size !== ids.length) throw new Error('Duplicate HTML element IDs');
const app = await readFile(resolve(root, 'public/app.js'), 'utf8');
for (const [, id] of app.matchAll(/\$\('#([\w-]+)'\)/g)) if (!ids.includes(id)) throw new Error('Missing UI element: ' + id);
console.log(count + ' JavaScript files passed syntax checks; JSON, versions, UI references and required project files checked.');
