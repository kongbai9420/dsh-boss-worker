import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeadWorkerHostService } from '../src/host.mjs';

test('explicitly disabling both switches stops automatic pumps and survives restart without deleting tasks', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-disable-pump-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { get: name => name === 'profileContext' ? { dir } : undefined, inject() {}, logger: { warn() {}, info() {}, error() {} } };
  const host = new LeadWorkerHostService(ctx, {});
  await host.handleAction('A', 'configureSession', { bossDirect: true });
  const board = host.getOrCreateBoard('A');
  board.plan([{ id: 't', title: 't', instructions: 'mock', acceptance: 'mock', memberId: board.config.members[0].id, writeScopes: ['src/mock'] }]);
  board.approve();
  await host.handleAction('A', 'configureSession', { bossDirect: false, autopilot: false });
  assert.deepEqual(await host.scheduleReadyTasks('A', {}), []);
  assert.equal(board.snapshot().tasks[0].status, 'pending');
  assert.equal(board.snapshot().approved, true);
  const restored = new LeadWorkerHostService(ctx, {});
  assert.deepEqual(await restored.scheduleReadyTasks('A', {}), []);
  assert.equal(restored.getOrCreateBoard('A').snapshot().tasks[0].status, 'pending');
});
