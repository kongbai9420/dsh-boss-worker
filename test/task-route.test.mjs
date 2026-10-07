import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeadWorkerHostService } from '../src/host.mjs';
import { TeamBoard } from '../src/core.mjs';

const worker = { id: 'w', name: 'Worker', provider: 'mock', model: 'old', role: 'coder', instructions: 'Code', enabled: true, readOnly: false };
const config = { enabled: true, mode: 'mixed', bossDirect: false, autopilot: false, confirmPlan: true, askApprovalPrompt: false, maxParallel: 2, maxRetries: 2, members: [worker] };
const task = (id = 't') => ({ id, title: id, instructions: 'Perform isolated mock work', acceptance: 'Verified', memberId: 'w', writeScopes: [`src/${id}.js`] });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'boss-task-route-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = {
    profileContext: { dir }, logger: { warn() {}, info() {}, error() {} },
    inject() {}, get(name) { return this[name]; },
  };
  const create = () => {
    const host = new LeadWorkerHostService(ctx, { defaultConfig: config });
    host.listAvailableModels = async () => ['old', 'new', 'other'].map(model => ({ provider: 'mock', model }));
    return host;
  };
  return { host: create(), create, file: join(dir, 'dsh-lead-worker', 'session-configs.json') };
}
const select = (host, session, id = 't', model = 'new') => host.handleAction(session, 'selectTaskModel', { taskId: id, provider: 'mock', model });

test('autopilot model selection is session-private, user locked and never schedules old model', async t => {
  const { host, file } = fixture(t);
  await host.handleAction('A', 'configure', { config: { ...config, autopilot: true } });
  const board = host.getOrCreateBoard('A');
  board.plan([task()]);
  board.approve('user');
  host.getOrCreateBoard('B');
  let schedules = 0;
  host.scheduleReadyTasks = async () => { schedules++; throw new Error('selection must not dispatch'); };
  await select(host, 'A');
  assert.equal(schedules, 0);
  assert.equal(board.snapshot().tasks[0].status, 'pending');
  assert.equal(board.snapshot().tasks[0].locked, true);
  assert.equal(board.snapshot().tasks[0].memberId, 'task-route-A-t');
  assert.equal(board.config.members.find(m => m.id === 'task-route-A-t').model, 'new');
  assert.equal(host.getConfig('B').members.some(m => m.id.startsWith('task-route-')), false);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.shared.members.some(m => m.id.startsWith('task-route-')), false);
  assert.equal(stored.sessionRoutes.A[0].model, 'new');
  assert.equal(stored.configRevision, 1);
});

test('shared configure excludes submitted routes and preserves both sessions routes and restart history', async t => {
  const { host, create, file } = fixture(t);
  for (const id of ['A', 'B']) {
    host.getOrCreateBoard(id).plan([task()]);
    await select(host, id, 't', id === 'A' ? 'new' : 'other');
  }
  await host.handleAction('B', 'configure', { config: { ...host.getConfig('B'), maxParallel: 3 } });
  assert.deepEqual(host.getConfig('A').members.filter(m => m.id.startsWith('task-route-')).map(m => m.id), ['task-route-A-t']);
  assert.deepEqual(host.getConfig('B').members.filter(m => m.id.startsWith('task-route-')).map(m => m.id), ['task-route-B-t']);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(stored.shared.members.map(m => m.id), ['w']);
  const restarted = create();
  for (const id of ['A', 'B']) {
    assert.equal(restarted.getOrCreateBoard(id).snapshot().tasks[0].memberId, `task-route-${id}-t`);
    assert.equal(restarted.getConfig(id).members.some(m => m.id === `task-route-${id}-t`), true);
  }
  // A route remains after assignment changes; do not erase historical identities.
  restarted.getOrCreateBoard('A').assign('t', 'w', 'user');
  await restarted.handleAction('B', 'configure', { config });
  assert.equal(create().getConfig('A').members.some(m => m.id === 'task-route-A-t'), true);
});

test('shared configure preserves original running member while applying updated shared models elsewhere', async t => {
  const { host } = fixture(t);
  const a = host.getOrCreateBoard('A');
  a.plan([task()]); a.approve('user'); a.start('t');
  await host.handleAction('B', 'configure', { config: { ...config, members: [{ ...worker, model: 'new' }] } });
  assert.equal(a.snapshot().tasks[0].status, 'running');
  assert.equal(a.config.members[0].model, 'old');
  assert.equal(host.getConfig('A').members[0].model, 'old');
  assert.equal(host.getConfig('B').members[0].model, 'new');
});

test('removing a shared member referenced in another session rejects atomically', async t => {
  const { host, create, file } = fixture(t);
  const a = host.getOrCreateBoard('A'); a.plan([task()]);
  const before = a.snapshot();
  const stored = readFileSync(file, 'utf8');
  await assert.rejects(host.handleAction('B', 'configure', { config: { ...config, members: [{ ...worker, id: 'replacement' }] } }), /会话 A.*不能删除共享成员/);
  assert.deepEqual(a.snapshot(), before);
  assert.deepEqual(host.getConfig('A').members.map(m => m.id), ['w']);
  assert.equal(readFileSync(file, 'utf8'), stored);
  assert.equal(create().getOrCreateBoard('A').snapshot().tasks[0].memberId, 'w');
});

test('completed historical shared member removal is rejected without breaking restart', async t => {
  const { host, create } = fixture(t);
  const board = host.getOrCreateBoard('A');
  board.plan([task()]); board.approve('user'); board.start('t');
  board.finish('t', { summary: 'Mock completed' }); board.review('t', true, 'Verified');
  await assert.rejects(host.handleAction('B', 'configure', { config: { ...config, members: [{ ...worker, id: 'replacement' }] } }), /不能删除共享成员/);
  assert.equal(create().getConfig('B').members[0].id, 'w');
});

test('disabled referenced member rejects before partial config writes', async t => {
  const { host, file } = fixture(t);
  host.getOrCreateBoard('A').plan([task()]);
  const stored = readFileSync(file, 'utf8');
  await assert.rejects(host.handleAction('B', 'configure', { config: { ...config, members: [{ ...worker, enabled: false }] } }));
  assert.equal(readFileSync(file, 'utf8'), stored);
  assert.equal(host.getConfig('A').members[0].enabled, true);
});

test('legacy shared routes migrate to owning session and survive restart', async t => {
  const { host, create, file } = fixture(t);
  host.getOrCreateBoard('A').plan([task()]);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  stored.shared.members.push({ ...worker, id: 'task-route-A-history', model: 'new' });
  stored.shared.members.push({ ...worker, id: 'task-route-unknown-history', model: 'other' });
  delete stored.sessionRoutes;
  writeFileSync(file, JSON.stringify(stored));
  const restarted = create();
  assert.equal(restarted.getConfig('A').members.some(m => m.id === 'task-route-A-history'), true);
  assert.equal(restarted.getConfig('B').members.some(m => m.id.startsWith('task-route-')), false);
  const migrated = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(migrated.shared.members.some(m => m.id.startsWith('task-route-')), false);
  assert.equal(migrated.sessionRoutes['legacy-unowned:task-route-unknown-history'][0].model, 'other');
});

test('balance never borrows a dedicated task route as an equivalent spare', () => {
  const board = new TeamBoard({ ...config, members: [worker, { ...worker, id: 'task-route-A-history' }] });
  board.plan([task('t1'), task('t2')]); board.approve('user'); board.balanceReadyAssignments();
  assert.deepEqual(board.snapshot().tasks.map(t => t.memberId), ['w', 'w']);
  board.reconfigure({ ...board.config, members: [...board.config.members, { ...worker, id: 'clone' }] });
  board.balanceReadyAssignments();
  assert.deepEqual(board.snapshot().tasks.map(t => t.memberId), ['w', 'clone']);
});
