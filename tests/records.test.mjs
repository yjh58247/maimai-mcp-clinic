import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { recordValidationError } from '../skills/mcd-mcp-clinic/scripts/lib/records.mjs';

const calls = [{ tool: 'now-time-info', input: {} }];
const report = { format: 'mcd-clinic-report', schemaVersion: 1, calls };
test('null, scalar and array imports produce user-facing validation errors', () => {
  for (const value of [null, 0, false, 'text', []]) assert.match(recordValidationError(value, { reportOnly: true }), /JSON 对象/);
});
test('browser imports require a supported version while CLI accepts raw call traces', () => {
  assert.equal(recordValidationError(report, { reportOnly: true }), null);
  assert.equal(recordValidationError({ calls }), null);
  assert.match(recordValidationError({ calls }, { reportOnly: true }), /v1/);
  assert.match(recordValidationError({ ...report, schemaVersion: 2 }), /版本/);
});
test('empty, oversized and malformed call lists are rejected with a record location', () => {
  for (const calls of [[], Array(101).fill({ tool: 'now-time-info' })]) assert.match(recordValidationError({ calls }), /1至100/);
  for (const call of [null, [], {}, { tool: 1 }, { tool: '  ' }]) assert.match(recordValidationError({ calls: [{ tool: 'now-time-info' }, call] }), /calls\[1\]/);
  assert.equal(recordValidationError({ calls: [{ tool: 'now-time-info', input: null }] }), null); // Diagnosed by ARG_OBJECT.
});
test('CLI handles malformed JSON records cleanly with exit code 1', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinic-records-'));
  const path = join(directory, 'record.json');
  const cli = resolve(import.meta.dirname, '../skills/mcd-mcp-clinic/scripts/clinic.mjs');
  try {
    for (const raw of [null, { calls: [null] }, { ...report, schemaVersion: 2 }]) {
      await writeFile(path, JSON.stringify(raw));
      const result = spawnSync(process.execPath, [cli, 'inspect', path], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.ok(result.stderr.trim());
      assert.ok(!result.stderr.includes('TypeError'));
      assert.equal(result.stdout, '');
    }
  } finally { await unlink(path); await rmdir(directory); }
});
