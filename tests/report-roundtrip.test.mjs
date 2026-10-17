import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRun } from '../skills/mcd-mcp-clinic/scripts/lib/diagnostics.mjs';
import { markdownReport, redactReport, stringifyReport } from '../skills/mcd-mcp-clinic/scripts/lib/redact.mjs';
import { recordValidationError } from '../skills/mcd-mcp-clinic/scripts/lib/records.mjs';
import { inspectionRun } from '../skills/mcd-mcp-clinic/scripts/lib/lab.mjs';
import { createApp } from '../server.mjs';
import { once } from 'node:events';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const call = (extra = {}) => ({ tool: 'now-time-info', input: {}, ...extra });
test('large context cannot consume report summary or call-list structure', () => {
  const report = analyzeRun({ context: { evidence: Array(45_000).fill(0) }, calls: [call()] });
  assert.equal(report.summary.total, 1);
  assert.equal(report.calls.length, 1);
  assert.equal(recordValidationError(report, { reportOnly: true }), null);
  assert.ok(markdownReport(report).includes('调用记录'));
  assert.equal(report.truncation.truncated, true);
});
test('large early payload cannot remove later calls or their diagnostics', () => {
  const report = analyzeRun({ calls: [call({ output: { data: Array(45_000).fill(0) } }),
    call({ error: { status: 503, message: 'synthetic later failure' } })] });
  assert.equal(recordValidationError(report, { reportOnly: true }), null);
  assert.equal(report.calls.length, 2);
  assert.equal(report.calls[1].tool, 'now-time-info');
  assert.ok(report.calls[1].findings.some(f => f.code === 'TOOL_ERROR'));
  assert.ok(markdownReport(report).includes('synthetic later failure'));
});
test('many findings retain an importable bounded report with explicit omissions', () => {
  const report = analyzeRun({ calls: [{ tool: 'calculate-price', input: {
    storeCode: '1450713', beType: 1, orderType: 1, items: Array.from({ length: 8_000 }, () => ({ productCode: '1100', quantity: 0 })),
  } }] });
  assert.equal(recordValidationError(report, { reportOnly: true }), null);
  assert.ok(report.findings.length <= 100);
  assert.ok(report.truncation.omittedFindings > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 1_000_000);
  assert.equal(report.calls[0].findingCount, report.summary.errors + report.summary.warnings);
});
test('manual checking at the history limit keeps the new request and marks the reduced evidence window', () => {
  const report = { calls: Array.from({ length: 100 }, (_, i) => call({ note: 'step-' + i })) };
  const run = inspectionRun({ tool: 'now-time-info', input: { latest: true }, report });
  assert.equal(run.calls.length, 100);
  assert.deepEqual(run.calls.at(-1).input, { latest: true });
  assert.equal(run.calls[0].note, 'step-1');
  assert.equal(run.truncation.truncated, true);
  assert.equal(recordValidationError(run), null);
});
test('imported timing metadata cannot overflow the report total', () => {
  assert.match(recordValidationError({ calls: [call({ durationMs: 1e308 }), call({ durationMs: 1e308 })] }), /耗时合计/);
});
test('compact JSON fallback keeps a report under the one-megabyte import limit', () => {
  const report = analyzeRun({ calls: Array.from({ length: 30 }, () => call({ output: { data: Array(10_000).fill(0) } })) });
  assert.ok(Buffer.byteLength(JSON.stringify(report, null, 2)) > 1_000_000);
  const exported = stringifyReport(report);
  assert.ok(Buffer.byteLength(exported) <= 1_000_000);
  assert.equal(recordValidationError(JSON.parse(exported), { reportOnly: true }), null);
});
test('the total byte budget remains bounded across many individually valid payloads', () => {
  const report = analyzeRun({ calls: Array.from({ length: 40 }, () => call({ output: { data: '汉'.repeat(20_000) } })) });
  assert.equal(report.calls.length, 40);
  assert.equal(report.truncation.truncated, true);
  assert.ok(Buffer.byteLength(stringifyReport(report)) <= 1_000_000);
  assert.equal(recordValidationError(report, { reportOnly: true }), null);
});
test('repeated redaction does not duplicate the incomplete-report warning or change totals', () => {
  const report = analyzeRun({ context: { large: Array(45_000).fill(0) }, calls: [call()] });
  const again = redactReport(redactReport(report));
  assert.deepEqual(again.summary, report.summary);
  assert.equal(again.findings.filter(f => f.code === 'REPORT_TRUNCATED').length, 1);
  assert.equal(again.calls[0].findingCount, 1);
  const replay = analyzeRun({ ...JSON.parse(stringifyReport(report)), source: 'import' });
  assert.equal(replay.source, 'import');
  assert.ok(replay.findings.some(f => f.code === 'REPORT_TRUNCATED'));
});
test('truncation never prevents sensitive fields or configured secrets from being removed', () => {
  const secret = 'synthetic-roundtrip-credential-abcdef';
  const report = analyzeRun({ context: { large: Array(45_000).fill(0) }, calls: [call({ output: {
    authorization: 'Bearer ' + secret, data: 'x'.repeat(90_000), userId: 'private-user-value',
  } }), call({ error: { status: 503, message: secret } })] }, { secrets: [secret] });
  const json = stringifyReport(report), markdown = markdownReport(report);
  for (const privateValue of [secret, 'private-user-value']) {
    assert.ok(!json.includes(privateValue)); assert.ok(!markdown.includes(privateValue));
  }
  assert.equal(report.calls.length, 2);
});
test('untruncated reports retain their full payloads and remain free of truncation warnings', () => {
  const output = { data: { date: '2026-10-17', small: [1, 2, 3] } };
  const report = analyzeRun({ calls: [call({ output, durationMs: 10 })] });
  assert.equal(report.truncation, undefined);
  assert.equal(report.summary.warnings, 0);
  assert.deepEqual(JSON.parse(stringifyReport(report)).calls[0].output, output);
  assert.equal(recordValidationError({ calls: [call({ durationMs: 0.5 }), call({ durationMs: 1.5 })] }), null);
});
test('editing an existing call at the history limit does not discard earlier evidence', () => {
  const report = { calls: Array.from({ length: 100 }, (_, i) => call({ note: 'step-' + i })) };
  const run = inspectionRun({ tool: 'now-time-info', input: {}, report, callIndex: 99 });
  assert.equal(run.calls.length, 100); assert.equal(run.calls[0].note, 'step-0');
  assert.equal(run.truncation, undefined);
});
test('API redaction preserves a large report through export, history retrieval and reimport', async () => {
  const token = 'synthetic-api-roundtrip-credential';
  const app = createApp({ token });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const post = body => fetch(origin + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const response = await post({ context: { data: Array(45_000).fill(0) }, calls: [call(),
      call({ error: { status: 503, message: token } })] });
    assert.equal(response.status, 200);
    const text = await response.text(); assert.ok(!text.includes(token));
    const report = JSON.parse(text).report;
    assert.equal(recordValidationError(report, { reportOnly: true }), null);
    assert.equal(report.calls.length, 2); assert.equal(report.truncation.truncated, true);
    const saved = (await (await fetch(origin + '/api/reports/' + report.id)).json()).report;
    assert.equal(saved.summary.total, 2); assert.equal(saved.calls.length, 2);
    const replay = await post(JSON.parse(stringifyReport(saved)));
    assert.equal(replay.status, 200);
    const imported = (await replay.json()).report;
    assert.equal(imported.source, 'import');
    assert.ok(imported.findings.some(f => f.code === 'REPORT_TRUNCATED'));
  } finally {
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await app.close();
  }
});
test('CLI JSON files remain below the import limit and can be inspected again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinic-report-export-'));
  const input = join(directory, 'input.json'), exported = join(directory, 'exported.json');
  const cli = resolve(import.meta.dirname, '../skills/mcd-mcp-clinic/scripts/clinic.mjs');
  try {
    await writeFile(input, JSON.stringify({ calls: Array.from({ length: 30 }, () => call({ output: { data: Array(10_000).fill(0) } })) }));
    const options = { encoding: 'utf8', maxBuffer: 2_000_000, windowsHide: true, env: { ...process.env, MCD_MCP_TOKEN: '' } };
    const first = spawnSync(process.execPath, [cli, 'inspect', input, '--json', '--out', exported], options);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(Buffer.byteLength(first.stdout) <= 1_000_000);
    const second = spawnSync(process.execPath, [cli, 'inspect', exported, '--json'], options);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).calls.length, 30);
  } finally {
    for (const path of [input, exported]) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  }
});
test('a payload truncation warning identifies the affected call and remains stable on repeat export', () => {
  const report = analyzeRun({ calls: [call({ output: { data: {} } }), call({ output: { data: Array(45_000).fill(0) } })] });
  assert.equal(report.calls[0].status, 'passed'); assert.equal(report.calls[1].status, 'warning');
  assert.equal(report.findings.find(f => f.code === 'REPORT_TRUNCATED').callIndex, 1);
  const again = redactReport(report);
  assert.deepEqual(again.summary, report.summary);
  assert.equal(again.calls[1].findingCount, 1);
});
