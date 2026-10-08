import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// host.mjs captures CONFIG_DIR at import time: isolate before importing it.
const originalAppData = process.env.APPDATA;
const isolated = mkdtempSync(join(tmpdir(), 'boss-autopilot-test-'));
process.env.APPDATA = isolated;
const { LeadWorkerHostService } = await import('../src/host.mjs');
const { TeamBoard } = await import('../src/core.mjs');
const storePath = join(isolated, 'dsh-desktop', 'harness', 'profiles', 'web', 'dsh-lead-worker', 'session-configs.json');
function cleanup() {
  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;
  rmSync(isolated, { recursive: true, force: true });
}
after(cleanup);
process.once('exit', cleanup);

const members = [
  { id: 'coder-a', name: 'Coder A', provider: 'mock', model: 'mock-a', role: 'Dev', instructions: 'Code', enabled: true, readOnly: false },
  { id: 'coder-b', name: 'Coder B', provider: 'mock', model: 'mock-b', role: 'Dev', instructions: 'Code', enabled: true, readOnly: false },
  { id: 'qa', name: 'QA', provider: 'mock', model: 'mock-qa', role: 'QA', instructions: 'Check', enabled: true, readOnly: true },
];
// Legacy tests exercise the separate approval gate, not the inline consent card.
const config = { enabled: true, mode: 'mixed', bossDirect: false, autopilot: false, confirmPlan: true, askApprovalPrompt: false, maxParallel: 2, maxRetries: 0, members };
function task(id, extra = {}) {
  return { id, title: id, instructions: `Mock work ${id}`, acceptance: 'Independently reviewed', memberId: 'coder-a', writeScopes: [`src/${id}.js`], ...extra };
}

class MockContext {
  logger = { info() {}, warn() {}, error() {} };
  tools = { registered: [], guards: [], register: tool => this.tools.registered.push(tool), guard: fn => this.tools.guards.push(fn) };
  systemPrompt = { section() {} };
  webServer = { register() {} };
  reflect = { provide() {} };
  parents = new Map();
  requests = [];
  llm = {
    listProviders: () => [],
    listModels: async () => [],
    // No network/model API is ever supplied to this fixture.
  };
  userQuestions = { ask: async () => { throw new Error('Unexpected user question in autopilot test'); } };
  subagents = {
    start: async (provider, request) => {
      assert.equal(provider, 'spawn');
      assert.equal(request.agentOptions.provider, 'mock');
      let settle;
      const run = {
        id: `mock-child-${this.requests.length + 1}`,
        localAgent: { session: { requestHeader: () => ({ config: { ...request.agentOptions } }) } },
        result: new Promise(resolve => { settle = resolve; }),
        disposed: false,
        dispose: async () => { run.disposed = true; },
        settle: (result = {}) => settle({ stopReason: 'completed', output: [{ type: 'text', text: 'Mock output: not approval' }], ...result }),
      };
      this.requests.push({ provider, request, run });
      return run;
    },
  };
  inject(_keys, fn) { fn(this); }
  get(name) {
    if (name === 'agents') return { get: id => this.parents.get(id) };
    return this[name];
  }
  parent(id) {
    const parent = { session: { header: { id } }, ctx: {}, status: 'idle', notices: [], followup(message) { this.notices.push(message); } };
    this.parents.set(id, parent);
    return parent;
  }
}

async function fixture(id, extra = {}) {
  const ctx = new MockContext();
  const parent = ctx.parent(id);
  const service = new LeadWorkerHostService(ctx, {});
  await service.handleAction(id, 'configure', { config: { ...config, ...extra } });
  const board = service.getOrCreateBoard(id);
  const tool = name => ctx.tools.registered.find(t => t.name === name);
  const exec = { agent: parent, signal: new AbortController().signal };
  return { id, ctx, parent, service, board, tool, exec };
}
async function complete(f, index, result = {}) {
  f.ctx.requests[index].run.settle(result);
  const drain = await f.service.drainExecutions(f.id, { timeoutMs: 1000 });
  assert.equal(drain.drained, true);
  // drain tracks child disposal; finish/notification/scheduler follow in microtasks.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.ctx.requests[index].run.disposed, true);
}
function batchNotices(parent) {
  return parent.notices.filter(msg => msg.source?.kind === 'coordination-phase-review' && msg.source?.summary?.includes('本批全部通过'));
}

test('autopilot defaults off, validates booleans, isolates session switches and persists explicit on/off', async () => {
  const ctx = new MockContext();
  const service = new LeadWorkerHostService(ctx, {});
  assert.equal(new TeamBoard(config).config.autopilot, false);
  const { autopilot: _unused, ...legacy } = config;
  assert.equal(new TeamBoard(legacy).config.autopilot, false);
  assert.throws(() => new TeamBoard({ ...config, autopilot: 'true' }), err => err.code === 'INVALID_INPUT');
  assert.equal(service.getConfig('autopilot-store-a').autopilot, false);
  assert.equal(service.getConfig('autopilot-store-b').autopilot, false);
  await service.handleAction('autopilot-store-a', 'configure', { config: { ...config, autopilot: true } });
  assert.equal(service.getConfig('autopilot-store-b').autopilot, false);
  await service.handleAction('autopilot-store-b', 'configure', { config });
  assert.equal(service.getConfig('autopilot-store-a').autopilot, true);
  const stored = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.equal(stored.sessionAutopilot['autopilot-store-a'], true);
  assert.equal(stored.sessionAutopilot['autopilot-store-b'], false);
  assert.equal(stored.shared.autopilot, false);
  const restored = new LeadWorkerHostService(new MockContext(), {});
  assert.equal(restored.getConfig('autopilot-store-a').autopilot, true);
  assert.equal(restored.getConfig('autopilot-store-b').autopilot, false);
  assert.equal(restored.getConfig('autopilot-store-new').autopilot, false);
  await restored.handleAction('autopilot-store-a', 'configure', { config });
  assert.equal(new LeadWorkerHostService(new MockContext(), {}).getConfig('autopilot-store-a').autopilot, false);
});

test('default-off model plan retains confirmPlan gate and never invokes mocked subagents', async () => {
  const f = await fixture('autopilot-default');
  const result = await f.tool('lead_worker_plan').execute({ tasks: [task('default')] }, f.exec);
  assert.equal(result.approved, false);
  assert.equal(result.tasks[0].status, 'pending');
  assert.equal(f.ctx.requests.length, 0);
  assert.throws(() => f.board.start('default'), err => err.code === 'APPROVAL_REQUIRED');
  assert.deepEqual(await f.service.scheduleReadyTasks(f.id, f.exec), []);
  f.board.pause();
  // No questions provider: ordinary resume must not request a second approval.
  await f.tool('lead_worker_recovery').execute({ action: 'resume' }, f.exec);
  assert.equal(f.board.snapshot().status, 'ready');
  assert.equal(f.board.snapshot().approved, false);
  assert.equal(f.ctx.requests.length, 0, 'resume cannot approve an unapproved plan');
});

test('autopilot model tool plan automatically first-dispatches mock child, but review blocks dependencies', async () => {
  const f = await fixture('autopilot-tool', { autopilot: true });
  const result = await f.tool('lead_worker_plan').execute({ tasks: [
    task('build'), task('verify', { memberId: 'qa', writeScopes: [], readOnly: true, dependencies: ['build'] }),
  ] }, f.exec);
  assert.equal(result.approved, true);
  assert.deepEqual(result.tasks.map(t => t.status), ['running', 'pending']);
  assert.equal(f.ctx.requests.length, 1);
  assert.equal(f.ctx.requests[0].request.parent, f.parent);
  const guard = f.ctx.tools.guards[0];
  for (const name of ['write', 'edit', 'pwsh', 'subagent', 'subagent_fork']) {
    const reason = guard({ name, agent: f.parent });
    assert.match(reason, /常规计划无需用户审批/);
    assert.doesNotMatch(reason, /用户确认后/);
  }
  for (const name of ['read', 'lead_worker_plan', 'lead_worker_review']) {
    assert.equal(guard({ name, agent: f.parent }), undefined);
  }
  const child = { session: { header: { id: 'mock-policy-child', parentSession: f.id, origin: 'subagent' } } };
  assert.equal(guard({ name: 'write', agent: child }), undefined, 'root-only policy must not block delegated implementation');
  assert.deepEqual(f.ctx.requests[0].request.agentOptions, { provider: 'mock', model: 'mock-a' });
  await complete(f, 0, { files: ['src/build.js'] });
  assert.deepEqual(f.board.snapshot().tasks.map(t => t.status), ['review', 'pending']);
  assert.equal(f.ctx.requests.length, 1, 'child completion is not independent review approval');
  assert.equal(batchNotices(f.parent).length, 0);
  assert.ok(f.parent.notices.some(msg => msg.content.some(block => block.text?.includes('严禁自动通过'))));
  await f.tool('lead_worker_review').execute({ taskId: 'build', passed: true, feedback: 'Mock independent review' }, f.exec);
  assert.equal(f.ctx.requests.length, 2);
  assert.equal(f.board.snapshot().tasks[1].status, 'running');
  await complete(f, 1);
  assert.equal(f.board.snapshot().tasks[1].status, 'review');
  await f.tool('lead_worker_review').execute({ taskId: 'verify', passed: true, feedback: 'Mock checked' }, f.exec);
  assert.equal(batchNotices(f.parent).length, 1);
});

test('host model plan auto-dispatches and all-done wakes batch_settled once per batch, not before review', async () => {
  const f = await fixture('autopilot-batch', { autopilot: true });
  for (let batch = 0; batch < 2; batch++) {
    const result = await f.service.handleAction(f.id, 'plan', { by: 'model', tasks: [task('reused')] });
    assert.equal(result.tasks[0].status, 'running');
    assert.equal(f.ctx.requests.length, batch + 1);
    await complete(f, batch);
    assert.equal(f.board.snapshot().tasks[0].status, 'review');
    assert.equal(batchNotices(f.parent).length, batch);
    await f.service.handleAction(f.id, 'review', { taskId: 'reused', passed: true, feedback: 'Mock independent review' });
    assert.equal(f.board.snapshot().tasks[0].status, 'done');
    assert.equal(batchNotices(f.parent).length, batch + 1);
    await f.service.scheduleReadyTasks(f.id, f.exec);
    await f.service.scheduleReadyTasks(f.id, f.exec);
    const duplicate = await f.service.notifyPhaseReview(f.id, { type: 'batch_settled', payload: { tasks: f.board.snapshot().tasks.map(t => [t.id, t.executionEpoch]) } });
    assert.equal(duplicate.reason, 'ALREADY_NOTIFIED');
    assert.equal(batchNotices(f.parent).length, batch + 1, 'repeated scheduling must not wake the same batch twice');
  }
});

test('turning autopilot off revokes prior authorization and restores confirmPlan until explicit approval', async () => {
  const f = await fixture('autopilot-disable', { autopilot: true });
  await f.tool('lead_worker_plan').execute({ tasks: [task('first'), task('second', { dependencies: ['first'] })] }, f.exec);
  await f.service.handleAction(f.id, 'configure', { config: { ...f.service.getConfig(f.id), autopilot: false } });
  assert.equal(f.board.snapshot().approved, false);
  assert.equal(f.board.snapshot().tasks[0].status, 'running', 'disable does not corrupt already running work');
  await complete(f, 0);
  await f.service.handleAction(f.id, 'review', { taskId: 'first', passed: true, feedback: 'Mock independent review' });
  assert.deepEqual(await f.service.scheduleReadyTasks(f.id, f.exec), []);
  assert.equal(f.ctx.requests.length, 1);
  assert.throws(() => f.board.start('second'), err => err.code === 'APPROVAL_REQUIRED');
  await f.service.handleAction(f.id, 'approve', {});
  assert.deepEqual(await f.service.scheduleReadyTasks(f.id, f.exec), [], 'approval alone does not reenable automatic dispatch after both switches are off');
   assert.deepEqual(await f.service.scheduleReadyTasks(f.id, f.exec, 'second'), []);
   const blocked = await f.tool('lead_worker_plan').execute({ tasks: [task('blocked')] }, f.exec);
   assert.equal(blocked.code, 'DELEGATION_DISABLED');
   assert.equal((await f.tool('lead_worker_dispatch').execute({ taskId: 'second' }, f.exec)).code, 'DELEGATION_DISABLED');
   await f.service.handleAction(f.id, 'configureSession', { bossDirect: true });
   assert.deepEqual(await f.service.scheduleReadyTasks(f.id, f.exec, 'second'), ['second']);
  await complete(f, 1);
  await f.service.handleAction(f.id, 'review', { taskId: 'second', passed: true, feedback: 'Mock checked' });
  assert.equal(batchNotices(f.parent).length, 0, 'disabled autopilot must not issue an all-done autopilot wakeup');
  const next = await f.tool('lead_worker_plan').execute({ tasks: [task('new-plan')] }, f.exec);
  assert.equal(next.approved, false);
  assert.equal(next.tasks[0].status, 'pending');
  assert.equal(f.ctx.requests.length, 2);
});

test('enabling autopilot reauthorizes ready work but never implicitly resumes a paused board', async () => {
  const ready = await fixture('autopilot-enable-ready');
  await ready.tool('lead_worker_plan').execute({ tasks: [task('ready')] }, ready.exec);
  await ready.service.handleAction(ready.id, 'configure', { config: { ...ready.service.getConfig(ready.id), autopilot: true } });
  assert.equal(ready.board.snapshot().approved, true);
  assert.equal(ready.ctx.requests.length, 1);
  await complete(ready, 0);
  const paused = await fixture('autopilot-enable-paused');
  paused.board.plan([task('paused')], 'model');
  paused.board.pause();
  await paused.service.handleAction(paused.id, 'configure', { config: { ...paused.service.getConfig(paused.id), autopilot: true } });
  assert.equal(paused.board.snapshot().status, 'paused');
  assert.equal(paused.ctx.requests.length, 0);
  assert.deepEqual(await paused.service.scheduleReadyTasks(paused.id, paused.exec), []);
  const planned = await paused.tool('lead_worker_plan').execute({ tasks: [task('must-not-resume')] }, paused.exec);
  assert.equal(planned.code, 'PAUSED');
  assert.equal(paused.board.snapshot().status, 'paused');
  assert.equal(paused.ctx.requests.length, 0);
  // No userQuestions service exists in this mock: resume must bypass its
  // confirmation call only under explicit autopilot authorization.
  await paused.tool('lead_worker_recovery').execute({ action: 'resume' }, paused.exec);
  assert.equal(paused.board.snapshot().status, 'ready');
  assert.equal(paused.board.snapshot().approved, true);
  assert.equal(paused.ctx.requests.length, 1, 'only explicit resume restarts paused work');
  await complete(paused, 0);
});

test('autopilot same-batch model append schedules new work and resets all-done deduplication safely', async () => {
  const f = await fixture('autopilot-append', { autopilot: true });
  await f.tool('lead_worker_plan').execute({ tasks: [task('base')] }, f.exec);
  await complete(f, 0);
  await f.tool('lead_worker_review').execute({ taskId: 'base', passed: true, feedback: 'Mock checked' }, f.exec);
  const batchId = f.board.snapshot().batchId;
  assert.equal(batchNotices(f.parent).length, 1);
  const appended = await f.tool('lead_worker_plan').execute({ append: true, tasks: [task('added', { dependencies: ['base'] })] }, f.exec);
  assert.equal(appended.batchId, batchId);
  assert.equal(appended.tasks.find(t => t.id === 'base').status, 'done');
  assert.equal(appended.tasks.find(t => t.id === 'added').status, 'running');
  assert.equal(f.ctx.requests.length, 2);
  await complete(f, 1);
  assert.equal(batchNotices(f.parent).length, 1, 'appended child still requires independent review');
  await f.tool('lead_worker_review').execute({ taskId: 'added', passed: true, feedback: 'Mock checked append' }, f.exec);
  assert.equal(batchNotices(f.parent).length, 2, 'different settled task set in the same batch must wake the lead again');
  await f.service.scheduleReadyTasks(f.id, f.exec);
  assert.equal(batchNotices(f.parent).length, 2);
});

test('autopilot keeps dependency, overlapping write-scope, member-capacity and retry-limit safety gates', async () => {
  const f = await fixture('autopilot-safety', { autopilot: true, maxParallel: 1 });
  const result = await f.tool('lead_worker_plan').execute({ tasks: [
    task('scope-a', { writeScopes: ['src/shared'] }),
    task('scope-b', { memberId: 'coder-b', writeScopes: ['src/shared/child.js'] }),
    task('dependent', { memberId: 'qa', readOnly: true, writeScopes: [], dependencies: ['scope-a'] }),
  ] }, f.exec);
  assert.equal(result.tasks.filter(t => t.status === 'running').length, 1);
  assert.equal(f.ctx.requests.length, 1);
  assert.throws(() => f.board.start('scope-b'), err => err.code === 'PARALLEL_LIMIT');
  await f.service.handleAction(f.id, 'configure', { config: { ...f.service.getConfig(f.id), maxParallel: 2 } });
  assert.equal(f.ctx.requests.length, 1, 'overlapping scope remains blocked even with an available slot');
  assert.throws(() => f.board.start('scope-b'), err => err.code === 'WRITE_SCOPE_CONFLICT');
  assert.throws(() => f.board.start('dependent'), err => err.code === 'DEPENDENCY_NOT_DONE');
  await complete(f, 0);
  assert.equal(f.board.snapshot().tasks.find(t => t.id === 'dependent').status, 'pending');
  assert.equal(f.ctx.requests.length, 2, 'finished work releases its write scope for independent work, not dependencies');
  await complete(f, 1);
  const rejected = await f.service.handleAction(f.id, 'review', { taskId: 'scope-a', passed: false, feedback: 'Mock failure, retry cap is zero' });
  const failed = rejected.tasks.find(t => t.id === 'scope-a');
  assert.equal(failed.status, 'needs_attention');
  assert.equal(failed.waitingReason, 'RETRY_LIMIT_REACHED');
  assert.equal(f.ctx.requests.length, 2, 'retry limit must not auto-retry or advance dependencies');
  assert.deepEqual(await f.service.scheduleReadyTasks(f.id, f.exec), []);
  assert.throws(() => f.board.retry('scope-a', 'model'), err => err.code === 'RETRY_LIMIT_REACHED' || err.code === 'FORBIDDEN');
});
