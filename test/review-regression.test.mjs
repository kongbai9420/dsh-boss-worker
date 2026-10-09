import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamBoard } from '../src/core.mjs';

// The host captures APPDATA at import time; never touch the real session store.
const previousAppData = process.env.APPDATA;
const isolated = mkdtempSync(join(tmpdir(), 'boss-review-regression-'));
process.env.APPDATA = isolated;
const { LeadWorkerHostService } = await import('../src/host.mjs');
after(() => {
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  rmSync(isolated, { recursive: true, force: true });
});

const config = {
  enabled: true, mode: 'mixed', bossDirect: false, autopilot: false,
  confirmPlan: true, askApprovalPrompt: false, maxParallel: 1, maxRetries: 1,
  members: [{ id: 'worker', name: 'Worker', provider: 'mock', model: 'mock',
    role: 'Dev', instructions: 'Code', enabled: true, readOnly: false }],
};
const task = (extra = {}) => ({ id: 'a', title: 'A', instructions: 'Implement A',
  acceptance: 'Verify A', memberId: 'worker', writeScopes: ['src/a.js'], ...extra });

function completedBoard(extra = {}) {
  const board = new TeamBoard({ ...config, ...extra });
  board.plan([task()]);
  board.approve('user');
  board.start('a');
  board.finish('a', { output: 'First attempt' });
  return board;
}

test('same-scope review replan retains task authorization without approving the entire board', () => {
  const board = completedBoard();
  const before = board.snapshot().tasks[0];
  board.plan([task()]);
  assert.equal(board.snapshot().approved, false);
  assert.equal(board.isTaskExecutionApproved('a'), true);
  assert.equal(board.snapshot().tasks[0].executionApproval, before.executionApproval);
  board.review('a', false, 'Fix the implementation');
  board.start('a');
  assert.equal(board.snapshot().tasks[0].executionEpoch, 2);
});

test('replanning pending rework preserves retry budget, history and monotonically increasing epochs', () => {
  const board = completedBoard({ autopilot: true });
  board.review('a', false, 'First rejection');
  const before = board.snapshot().tasks[0];
  board.plan([task()]);
  const replanned = board.snapshot().tasks[0];
  assert.equal(replanned.retries, 1);
  assert.equal(replanned.executionEpoch, 1);
  assert.deepEqual(replanned.reviewHistory, before.reviewHistory);
  assert.deepEqual(replanned.executionHistory, before.executionHistory);
  board.start('a');
  assert.equal(board.snapshot().tasks[0].executionEpoch, 2);
  board.finish('a', { output: 'Second attempt' });
  board.review('a', false, 'Second rejection');
  board.plan([task()]);
  const exhausted = board.snapshot().tasks[0];
  assert.equal(exhausted.status, 'needs_attention');
  assert.equal(exhausted.waitingReason, 'RETRY_LIMIT_REACHED');
  assert.equal(exhausted.retries, 1);
  assert.equal(exhausted.reviewHistory.length, 2);
  assert.throws(() => board.start('a'), { code: 'INVALID_STATE' });
});

test('scope-changing pending replan invalidates task authorization but retains historical attempts', () => {
  const board = completedBoard();
  board.review('a', false, 'Fix A');
  const before = board.snapshot().tasks[0];
  board.plan([task({ writeScopes: ['src/expanded'] })]);
  const changed = board.snapshot().tasks[0];
  assert.equal(board.snapshot().approved, false);
  assert.equal(board.isTaskExecutionApproved('a'), false);
  assert.equal(changed.retries, before.retries);
  assert.equal(changed.executionEpoch, before.executionEpoch);
  assert.deepEqual(changed.reviewHistory, before.reviewHistory);
  assert.deepEqual(changed.executionHistory, before.executionHistory);
  assert.throws(() => board.start('a'), { code: 'APPROVAL_REQUIRED' });
  board.approve('user');
  board.start('a');
  assert.equal(board.isTaskExecutionApproved('a'), true);
  assert.equal(board.snapshot().tasks[0].executionEpoch, 2);
});

test('HTTP manual dispatch pumps authorized rework after review arrives before active-key cleanup', async () => {
  const sessionId = 'review-regression-manual-race';
  const requests = [];
  let service;
  let reviewPromise;
  let observedPendingDuringNotification = false;
  const parent = {
    session: { header: { id: sessionId } }, ctx: {}, status: 'idle',
    followup(message) {
      if (message.source?.kind !== 'subagent-settled' || reviewPromise) return;
      reviewPromise = service.handleAction(sessionId, 'review', {
        taskId: 'a', passed: false, feedback: 'Fix A after the first attempt',
      });
      // This happens synchronously inside completion notification, while the
      // previous dispatch still owns its active key. The first scheduler skips.
      observedPendingDuringNotification = service.getOrCreateBoard(sessionId).snapshot().tasks[0].status === 'pending';
    },
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register() {}, guard() {} }, userQuestions: { ask() {} },
    systemPrompt: { section() {} }, webServer: { register() {} }, reflect: { provide() {} },
    inject(_keys, fn) { fn(this); },
    get(name) { return name === 'agents' ? { get: id => id === sessionId ? parent : undefined } : this[name]; },
    subagents: {
      async start(_kind, request) {
        let settle;
        const run = {
          id: `review-regression-child-${requests.length + 1}`,
          localAgent: { session: { requestHeader: () => ({ config: request.agentOptions }) } },
          result: new Promise(resolve => { settle = resolve; }),
          async dispose() {},
          complete() { settle({ stopReason: 'completed', output: [{ text: 'Implemented A' }] }); },
        };
        requests.push(run);
        return run;
      },
    },
  };
  service = new LeadWorkerHostService(ctx, {});
  await service.handleAction(sessionId, 'configure', { config: { ...config, bossDirect: true } });
  await service.handleAction(sessionId, 'plan', { tasks: [task()] });
  await service.handleAction(sessionId, 'dispatchTask', { taskId: 'a', userTaskApproval: true });
  assert.equal(requests.length, 1);
  requests[0].complete();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(reviewPromise, 'completion notification must trigger the racing HTTP review');
  await reviewPromise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observedPendingDuringNotification, true);
  assert.equal(requests.length, 2, 'cleanup must pump the skipped authorized retry');
  const board = service.getOrCreateBoard(sessionId);
  assert.equal(board.snapshot().tasks[0].status, 'running');
  assert.equal(board.snapshot().tasks[0].executionEpoch, 2);
  requests[1].complete();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(board.snapshot().tasks[0].status, 'review');
});
