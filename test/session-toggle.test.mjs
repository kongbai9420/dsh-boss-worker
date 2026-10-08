import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeadWorkerHostService } from '../src/host.mjs';
import { TeamBoard } from '../src/core.mjs';

test('session autopilot ignores unrelated orphan historical member without deleting history', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-session-toggle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const member = { id: 'real', name: 'worker', provider: 'mock', model: 'm', role: 'coder', instructions: '', enabled: true, readOnly: false };
  const config = new TeamBoard({ members: [member], enabled: true, mode: 'mixed', maxParallel: 2, maxRetries: 2, confirmPlan: true }).config;
  const historical = new TeamBoard({ ...config, members: [{ ...member, id: 'removed-test' }] });
  historical.plan([{ id: 'old', title: 'old', instructions: 'mock', acceptance: 'mock', memberId: 'removed-test', writeScopes: ['test'] }]);
  const file = join(dir, 'dsh-lead-worker', 'session-configs.json');
  mkdirSync(join(dir, 'dsh-lead-worker'));
  writeFileSync(file, JSON.stringify({ shared: config, boards: { 'test-session-1': historical.snapshot() } }));
  const ctx = { get: name => name === 'profileContext' ? { dir } : undefined, inject() {}, logger: { warn() {}, error() {}, info() {} } };
  const host = new LeadWorkerHostService(ctx, {});
  const result = await host.handleAction('real-session', 'configureSession', { autopilot: true, expectedConfigRevision: 0 });
  assert.equal(result.config.autopilot, true);
  assert.equal(host.getConfig('other').autopilot, false);
  let stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(stored.shared, config);
  assert.equal(stored.boards['test-session-1'].tasks[0].memberId, 'removed-test');
  // Existing clients which still submit the whole unchanged config also work.
  await host.handleAction('real-session', 'configure', { config: { ...host.getConfig('real-session'), autopilot: false } });
  stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.sessionAutopilot['real-session'], false);
  assert.deepEqual(stored.shared, config);
});
