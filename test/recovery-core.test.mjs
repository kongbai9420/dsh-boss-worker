import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TeamBoard } from '../src/core.mjs';

const c = {
  enabled: true,
  mode: 'mixed',
  members: [
    { id: 'w1', name: 'W1', provider: 'p', model: 'm', role: 'coder', instructions: 'Do', enabled: true, readOnly: false },
    { id: 'w2', name: 'W2', provider: 'p', model: 'm', role: 'reviewer', instructions: 'Review', enabled: true, readOnly: false },
  ],
  maxParallel: 2,
  maxRetries: 2,
  confirmPlan: true,
};

function ready() {
  const b = new TeamBoard(c);
  b.plan([{ id: 't', title: 'T', instructions: 'Do', acceptance: 'Pass', memberId: 'w1', writeScopes: ['t.js'] }]);
  b.approve('user');
  return b;
}

test('pause permits running work to finish but rejects new dispatch', () => {
  const b = ready();
  b.start('t');
  const e = b.snapshot().tasks[0].executionEpoch;
  b.pause();
  b.finish('t', { output: 'done' }, undefined, e);
  assert.equal(b.snapshot().status, 'paused');
  assert.equal(b.snapshot().tasks[0].status, 'review');
});

test('restart persists recovery marker, note and requires explicit resume', () => {
  const b = ready();
  b.start('t');
  b.checkpointTask('t', 'modified t.js; tests not yet run');
  const r = new TeamBoard(c, b.snapshot());
  assert.equal(r.snapshot().status, 'paused');
  assert.equal(r.snapshot().tasks[0].waitingReason, 'INTERRUPTED_RESTART');
  const again = new TeamBoard(c, r.snapshot());
  assert.deepEqual(again.snapshot(), r.snapshot());
  assert.throws(() => r.recoverTask('t', ''));
  r.recoverTask('t', 'checked diff; continue test');
  assert.equal(r.snapshot().tasks[0].retries, 0);
  assert.throws(() => r.start('t'));
  r.resume();
  r.start('t');
});

test('old results cannot overwrite new execution after interrupt and recovery', () => {
  const b = ready();
  b.start('t');
  const old = b.snapshot().tasks[0].executionEpoch;
  b.interrupt();
  b.recoverTask('t', 'verified partial file; continue');
  r_resume_helper(b);
  b.start('t');
  const before = b.snapshot();
  assert.throws(() => b.finish('t', { old: true }, undefined, old), (e) => e.code === 'STALE_EXECUTION');
  assert.deepEqual(b.snapshot(), before);
  b.finish('t', { new: true }, undefined, before.tasks[0].executionEpoch);
  assert.equal(b.snapshot().tasks[0].result.new, true);
});

function r_resume_helper(b) {
  if (b.snapshot().status === 'paused') b.resume();
}

test('recovery cannot bypass retry limit and completed work remains unchanged', () => {
  const b = ready();
  b.start('t');
  b.finish('t', {});
  b.review('t', true, 'pass');
  const t = b.snapshot().tasks[0];
  b.interrupt();
  assert.deepEqual(b.snapshot().tasks[0], t);
  assert.throws(() => b.recoverTask('t', 'Do again'));
  const limited = new TeamBoard({ ...c, maxRetries: 0 });
  limited.plan([{ id: 't', title: 'T', instructions: 'Do', acceptance: 'Pass', memberId: 'w1', writeScopes: ['t.js'] }]);
  limited.approve('user');
  limited.start('t');
  limited.finish('t', {});
  limited.review('t', false, 'bad');
  assert.throws(() => limited.recoverTask('t', 'confirmed'));
});

test('安全停工状态机：区分 pause、interrupt 与 drain，只有 drained 且宿主确认结算才可声明安全关机', () => {
  const b = ready();

  // 0. 普通 ready 空闲板：安全关机必须为 false，未排空不可声明安全
  const initDrain = b.getDrainStatus();
  assert.equal(initDrain.status, 'ready');
  assert.equal(initDrain.isDrained, false);
  assert.equal(initDrain.safeToShutdown, false);
  assert.equal(initDrain.processStopped, false);

  b.start('t');
  const epoch = b.snapshot().tasks[0].executionEpoch;

  // 1. 运行中有活跃任务时，pause 暂停派发，但不可声明安全关机 (safeToShutdown: false)
  b.pause();
  const pauseDrain = b.getDrainStatus();
  assert.equal(pauseDrain.status, 'paused');
  assert.equal(pauseDrain.isDrained, false);
  assert.equal(pauseDrain.safeToShutdown, false);
  assert.equal(pauseDrain.activeExecutions, 1);

  // 2. 活跃任务尚未结算时调用 drain，进入 draining 状态，明确不可安全关机
  b.drain();
  const drainingDrain = b.getDrainStatus();
  assert.equal(drainingDrain.status, 'draining');
  assert.equal(drainingDrain.isDrained, false);
  assert.equal(drainingDrain.safeToShutdown, false);
  assert.equal(drainingDrain.activeExecutions, 1);

  // 3. 运行中任务收尾并真实结算 (finish 进入 review)
  b.finish('t', { summary: 'finished work' }, undefined, epoch);
  assert.equal(b.snapshot().tasks[0].status, 'review');

  // 4. 所有活跃活动结算后调用 drain()，宿主事实未注入时 safeToShutdown 仍为 false
  b.drain();
  const drainedUnsettled = b.getDrainStatus();
  assert.equal(drainedUnsettled.status, 'drained');
  assert.equal(drainedUnsettled.isDrained, true);
  assert.equal(drainedUnsettled.safeToShutdown, false);
  assert.equal(drainedUnsettled.processStopped, false);

  // 5. 宿主显式确认 settled 与 processStopped 注入后，正式到达 safeToShutdown: true
  b.drain({ settled: true, processStopped: true });
  const drainedDrain = b.getDrainStatus();
  assert.equal(drainedDrain.status, 'drained');
  assert.equal(drainedDrain.isDrained, true);
  assert.equal(drainedDrain.safeToShutdown, true);
  assert.equal(drainedDrain.activeExecutions, 0);
  assert.equal(drainedDrain.processStopped, true);
  assert.ok(drainedDrain.drainedAt);

  // 停工现场结构化字段真实可信，不伪造任何 git commit 或 testRuns 证据
  const snap = b.snapshot();
  assert.ok(snap.recovery);
  assert.equal(snap.recovery.drained, true);
  assert.equal(snap.recovery.settled, true);
  assert.equal(snap.recovery.safeToShutdown, true);
  assert.equal(snap.recovery.activeExecutions, 0);
  assert.equal(snap.recovery.gitCommit, undefined);
  assert.equal(snap.recovery.testRuns, undefined);
});

test('重启恢复：running 任务收敛到 needs_attention，review 任务严格保留待审计且不伪造 drained', () => {
  const b = new TeamBoard(c);
  b.plan([
    { id: 't-run', title: 'Running Task', instructions: 'Run', acceptance: 'Pass', memberId: 'w1', writeScopes: ['run.js'] },
    { id: 't-rev', title: 'Review Task', instructions: 'Rev', acceptance: 'Pass', memberId: 'w2', writeScopes: ['rev.js'] },
  ]);
  b.approve('user');

  // t-run 启动执行进入 running
  b.start('t-run');
  // t-rev 启动并完成进入 review
  b.start('t-rev');
  const revEpoch = b.snapshot().tasks.find((t) => t.id === 't-rev').executionEpoch;
  b.finish('t-rev', { output: 'awaiting audit', evidence: { summary: 'done' } }, undefined, revEpoch);

  const beforeCrash = b.snapshot();
  assert.equal(beforeCrash.tasks.find((t) => t.id === 't-run').status, 'running');
  assert.equal(beforeCrash.tasks.find((t) => t.id === 't-rev').status, 'review');

  // 模拟宿主/进程重启恢复
  const restarted = new TeamBoard(c, beforeCrash);
  const snap = restarted.snapshot();

  // 1. 原 running 任务收敛为 needs_attention，waitingReason 为 INTERRUPTED_RESTART，代次递增
  const runTask = snap.tasks.find((t) => t.id === 't-run');
  assert.equal(runTask.status, 'needs_attention');
  assert.equal(runTask.waitingReason, 'INTERRUPTED_RESTART');
  assert.ok(runTask.executionEpoch > beforeCrash.tasks.find((t) => t.id === 't-run').executionEpoch);

  // 2. 原 review 任务严格保留为 review 状态！绝不自动通过或转为 pending，留待主控审计
  const revTask = snap.tasks.find((t) => t.id === 't-rev');
  assert.equal(revTask.status, 'review');
  assert.deepEqual(revTask.result, beforeCrash.tasks.find((t) => t.id === 't-rev').result);
  assert.equal(revTask.waitingReason, '');

  // 3. 重启收敛现场状态真实记录：绝对不伪造 drained/safeToShutdown，必须标记待核查 needsCheck
  assert.equal(snap.status, 'paused');
  assert.ok(snap.recovery);
  assert.equal(snap.recovery.reason, 'RESTART');
  assert.equal(snap.recovery.drained, false);
  assert.equal(snap.recovery.settled, false);
  assert.equal(snap.recovery.processStopped, false);
  assert.equal(snap.recovery.safeToShutdown, false);
  assert.equal(snap.recovery.needsCheck, true);
  assert.equal(snap.recovery.activeExecutions, 0);
  assert.deepEqual(snap.recovery.interruptedTaskIds, ['t-run']);
});

test('恢复不覆盖历史：recoverTask 用户确认后仅将任务转为 pending，绝不自动通过，且保留历史', () => {
  const b = ready();
  b.start('t');
  b.checkpointTask('t', 'working on step 1');
  b.interrupt('TEST_INTERRUPT');

  const beforeRecover = b.snapshot();
  const taskBefore = beforeRecover.tasks[0];
  assert.equal(taskBefore.status, 'needs_attention');
  assert.equal(taskBefore.waitingReason, 'TEST_INTERRUPT');
  assert.ok(taskBefore.checkpoint);
  assert.equal(taskBefore.checkpoint.note, 'working on step 1');

  // 必须用户确认 (by='user') 且提供非空说明
  assert.throws(() => b.recoverTask('t', 'note', 'model'), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => b.recoverTask('t', '', 'user'));

  // 成功恢复
  b.recoverTask('t', 'user verified disk diff and allows continuation', 'user');
  const snapAfter = b.snapshot();
  const recoveredTask = snapAfter.tasks[0];

  // 1. 恢复后只转为 pending，绝不自动通过成 done
  assert.equal(recoveredTask.status, 'pending');
  assert.notEqual(recoveredTask.status, 'done');

  // 2. 完整保留历史 checkpoint、executionHistory，不被清除或覆盖
  assert.ok(recoveredTask.checkpoint);
  assert.equal(recoveredTask.checkpoint.note, 'user verified disk diff and allows continuation');
  assert.ok(recoveredTask.executionHistory.length >= 2);
  assert.ok(recoveredTask.executionHistory.some((h) => h.status === 'interrupted'));
  assert.ok(recoveredTask.executionHistory.some((h) => h.status === 'recovery-confirmed'));
});
