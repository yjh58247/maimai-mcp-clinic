import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import http from 'node:http';
import { listenLocal } from '../lib/local-server.mjs';
import { readConfig } from '../lib/config.mjs';
import { analyzeRun } from '../skills/mcd-mcp-clinic/scripts/lib/diagnostics.mjs';
import { inspectionRun } from '../skills/mcd-mcp-clinic/scripts/lib/lab.mjs';
import { jsonFragments } from '../skills/mcd-mcp-clinic/scripts/lib/json-text.mjs';
import { redact } from '../skills/mcd-mcp-clinic/scripts/lib/redact.mjs';
import { McpClient } from '../skills/mcd-mcp-clinic/scripts/lib/mcp-client.mjs';
import { recordValidationError } from '../skills/mcd-mcp-clinic/scripts/lib/records.mjs';
import { DEMO_CASES } from '../skills/mcd-mcp-clinic/scripts/lib/demo.mjs';

test('manual checking retains only evidence before the edited call', () => {
  const healthy = analyzeRun(DEMO_CASES.find(item => item.id === 'healthy').run);
  const last = healthy.calls.at(-1);
  const quote = inspectionRun({ ...last, displayedTotal: 27.4, report: healthy, callIndex: 5 });
  assert.equal(quote.calls.length, 6);
  assert.equal(analyzeRun(quote).summary.errors, 0);
  assert.equal(analyzeRun(quote).summary.warnings, 0);
  const earlier = inspectionRun({ tool: 'query-meals', input: healthy.calls[2].input, report: healthy, callIndex: 2 });
  assert.equal(earlier.calls.length, 3); assert.equal(earlier.calls.at(-1).output, undefined);
  assert.equal(earlier.source, 'manual');
});
test('new manual steps use current evidence without modifying the original trace', () => {
  const report = { calls: [{ tool: 'now-time-info', input: {}, output: { data: {} } }] };
  const run = inspectionRun({ tool: 'now-time-info', input: {}, report });
  assert.equal(run.calls.length, 2); assert.equal(report.calls.length, 1);
  assert.equal(inspectionRun({ tool: 'now-time-info', input: {} }).calls.length, 1);
});
test('JSON fragments preserve escaped quotes, braces, arrays and Unicode', () => {
  const values = [{ note: '引号 " 和括号 } [', data: { price: 2550 } }, [{ code: '1100' }]];
  const text = '```json\n' + JSON.stringify(values[0]) + '\n```\nOther: ' + JSON.stringify(values[1]);
  assert.deepEqual(jsonFragments(text).map(item => item.value), values);
  assert.equal(jsonFragments(text, 1).length, 1);
});
test('all embedded JSON fragments are redacted, including after the fiftieth', () => {
  const text = Array.from({ length: 60 }, (_, i) => 'Record: ' + JSON.stringify({ deliveryAddress: { street: 'private-' + i } })).join('\n');
  assert.ok(!redact(text).includes('private-'));
});
test('secrets spanning the text truncation boundary are removed before truncation', () => {
  const secret = 'synthetic-very-long-credential-abcdef';
  const safe = redact('x'.repeat(119990) + secret + 'tail', [secret]);
  assert.ok(!safe.includes('synthetic-')); assert.ok(safe.includes('[已脱敏]'));
});
test('deeply encoded JSON and huge arrays stop with a single bounded truncation marker', () => {
  let value = { couponCode: 'private-coupon' };
  for (let i = 0; i < 8; i++) value = { text: JSON.stringify(value) };
  assert.ok(!JSON.stringify(redact(value)).includes('private-coupon'));
  const array = redact(Array(50000).fill(0));
  assert.ok(array.length < 50000); assert.equal(array.at(-1), '[内容过长，已截断]');
});
test('invalid duration metadata is rejected before rendering imported markup', () => {
  for (const durationMs of ['<img src=x>', -1, [], {}]) assert.match(recordValidationError({ calls: [{ tool: 'now-time-info', durationMs }] }), /durationMs/);
});
test('explicit empty environment credentials override a local configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinic-config-'));
  const file = join(directory, '.env');
  const token = process.env.MCD_MCP_TOKEN, port = process.env.PORT;
  try {
    await writeFile(file, '\uFEFFMCD_MCP_TOKEN="synthetic-local"\nPORT=4321');
    delete process.env.MCD_MCP_TOKEN; delete process.env.PORT;
    assert.deepEqual(readConfig(directory), { token: 'synthetic-local', port: 4321 });
    process.env.MCD_MCP_TOKEN = ''; process.env.PORT = '4322';
    assert.deepEqual(readConfig(directory), { token: '', port: 4322 });
    process.env.PORT = 'invalid'; assert.throws(() => readConfig(directory), /PORT/);
  } finally {
    if (token === undefined) delete process.env.MCD_MCP_TOKEN; else process.env.MCD_MCP_TOKEN = token;
    if (port === undefined) delete process.env.PORT; else process.env.PORT = port;
    await unlink(file); await rmdir(directory);
  }
});
const cli = resolve(import.meta.dirname, '../skills/mcd-mcp-clinic/scripts/clinic.mjs');
for (const args of [['unknown'], ['inspect'], ['demo', 'healthy', '--out'], ['demo', 'healthy', '--wrong']]) {
  test('CLI rejects invalid command syntax: ' + args.join(' '), () => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.ok(result.stderr.trim()); assert.equal(result.stdout, '');
  });
}
test('CLI checks local input and size before attempting any MCP connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinic-cli-'));
  const file = join(directory, 'input.json');
  try {
    await writeFile(file, 'null');
    const result = spawnSync(process.execPath, [cli, 'call', 'now-time-info', file, '--json'], { encoding: 'utf8', env: { ...process.env, MCD_MCP_TOKEN: '' } });
    assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).findings[0].code, 'ARG_OBJECT');
    await writeFile(file, ' '.repeat(1_000_001));
    const large = spawnSync(process.execPath, [cli, 'inspect', file], { encoding: 'utf8' });
    assert.equal(large.status, 1); assert.match(large.stderr, /1MB/);
  } finally { await unlink(file); await rmdir(directory); }
});
test('invalid MCP call arguments are rejected without network access', async () => {
  let requests = 0;
  const client = new McpClient({ token: 'synthetic-only', fetchImpl: async () => { requests++; } });
  for (const args of [null, [], false]) await assert.rejects(client.call('now-time-info', args), error => error.status === 400);
  assert.equal(requests, 0);
});
for (const [code, expected] of [['ECONNRESET', /中断/], ['ENOTFOUND', /DNS/], ['CERT_HAS_EXPIRED', /证书/]]) {
  test('network failure is actionable without exposing proxy internals: ' + code, async () => {
    const client = new McpClient({ token: 'synthetic-only', fetchImpl: async () => { throw new TypeError('private-proxy-data', { cause: { code } }); } });
    await assert.rejects(client.rpc('tools/list', {}), error => expected.test(error.message) && !error.message.includes('private-proxy-data'));
  });
}
test('non-object tool responses cannot be treated as successful connections', async () => {
  const client = new McpClient({ token: 'synthetic-only', fetchImpl: async (url, request) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(request.body).id, result: null }), { headers: { 'content-type': 'application/json' } }) });
  client.tools = [{ name: 'now-time-info' }];
  await assert.rejects(client.call('now-time-info', {}), /有效的 JSON 对象/);
});
test('report history loads summaries first, retrieves full reports on demand and expires old entries', async () => {
  const { server } = createApp(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  const post = body => fetch(url + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let first, last;
    for (let i = 0; i < 21; i++) {
      const response = await post({ calls: [{ tool: 'now-time-info', input: {}, output: { data: { note: 'x'.repeat(20000) } } }] });
      assert.equal(response.status, 200); last = (await response.json()).report; first ||= last.id;
    }
    const listText = await (await fetch(url + '/api/reports')).text();
    const list = JSON.parse(listText).reports;
    assert.equal(list.length, 20); assert.ok(listText.length < 20000);
    assert.ok(list.every(item => !('calls' in item) && Number.isInteger(item.findingCount)));
    assert.equal((await fetch(url + '/api/reports/' + first)).status, 404);
    const full = await (await fetch(url + '/api/reports/' + last.id)).json();
    assert.equal(full.report.calls[0].output.data.note.length, 20000);
    const malformed = await post({ calls: [{ tool: 'query-meals', input: { storeCode: '1450713', beType: 1, orderType: 1, reservationDate: ['2026-10-20 12:00'] } }] });
    assert.equal(malformed.status, 200); assert.ok((await malformed.json()).report.summary.errors > 0);
    for (const name of ['context.mjs', 'records.mjs', 'json-text.mjs', 'redact.mjs', 'lab.mjs']) assert.equal((await fetch(url + '/' + name)).status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a busy starting port selects another loopback port and serves the app', async () => {
  const blocker = http.createServer(); blocker.listen(0, '127.0.0.1'); await once(blocker, 'listening');
  const { server } = createApp();
  try {
    const first = blocker.address().port;
    const selected = await listenLocal(server, first);
    assert.ok(selected > first && selected < first + 10);
    assert.equal(server.address().address, '127.0.0.1');
    assert.equal((await fetch('http://127.0.0.1:' + selected + '/api/status')).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await new Promise(resolve => blocker.close(resolve));
  }
});
test('port retry limits stop cleanly instead of looping forever', async () => {
  const blocker = http.createServer(); blocker.listen(0, '127.0.0.1'); await once(blocker, 'listening');
  const candidate = http.createServer();
  try { await assert.rejects(listenLocal(candidate, blocker.address().port, 1), error => error.code === 'EADDRINUSE'); }
  finally { await new Promise(resolve => blocker.close(resolve)); }
});
