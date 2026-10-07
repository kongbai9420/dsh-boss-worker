import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TeamBoard, BoardError } from '../src/core.mjs';

const sampleConfig = {
  enabled: true,
  mode: 'mixed',
  members: [
    { id: 'lead', name: 'Astra (Lead)', provider: 'new', model: 'gpt-6-astra', role: 'Planner/Reviewer', instructions: 'Plan and review', enabled: true, readOnly: true },
    { id: 'worker1', name: 'Sol (Worker 1)', provider: 'new', model: 'sol', role: 'Frontend & Logic', instructions: 'Implement UI and logic', enabled: true, readOnly: false },
    { id: 'tester', name: 'Tester', provider: 'cpa', model: 'gemini-3.8-flash-high', role: 'Test & Verification', instructions: 'Run test cases', enabled: true, readOnly: true },
  ],
  maxParallel: 2,
  maxRetries: 2,
  confirmPlan: true,
};

describe('TeamBoard State Machine', () => {
  it('manual task authorization survives rework without approving unrelated work', () => {
    const board = new TeamBoard(sampleConfig);
    board.plan([
      { id: 'retry-a', title: 'A', instructions: 'Do', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['a.js'] },
      { id: 'new-b', title: 'B', instructions: 'Do', acceptance: 'Pass', memberId: 'tester', readOnly: true, writeScopes: [] }
    ]);
    board.start('retry-a', undefined, true);
    board.finish('retry-a', { output: 'partial' });
    board.review('retry-a', false, 'fix defect');
    assert.equal(board.snapshot().approved, false);
    assert.equal(board.isTaskExecutionApproved('retry-a'), true);
    assert.equal(board.isTaskExecutionApproved('new-b'), false);
    board.start('retry-a');
    assert.throws(() => board.start('new-b'), e => e.code === 'APPROVAL_REQUIRED');
    board.finish('retry-a', { output: 'partial' });
    board.review('retry-a', false, 'fix again');
    const saved = board.snapshot();
    const changed = structuredClone(saved);
    changed.tasks[0].writeScopes.push('extra.js');
    const restored = new TeamBoard(sampleConfig, changed);
    assert.equal(restored.isTaskExecutionApproved('retry-a'), false);
    assert.throws(() => restored.start('retry-a'), e => e.code === 'APPROVAL_REQUIRED');
  });
  it('explicit task click does not approve other tasks or bypass dependencies', () => {
    const board = new TeamBoard(sampleConfig);
    board.plan([
      { id: 'a', title: 'A', instructions: 'Do', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['a.js'] },
      { id: 'b', title: 'B', instructions: 'Do', acceptance: 'Pass', memberId: 'tester', readOnly: true, writeScopes: [], dependencies: ['a'] }
    ]);
    assert.throws(() => board.start('a'), e => e.code === 'APPROVAL_REQUIRED');
    assert.throws(() => board.start('b', undefined, true), e => e.code === 'DEPENDENCY_NOT_DONE');
    board.start('a', undefined, true);
    assert.equal(board.snapshot().approved, false);
    board.finish('a', { output: 'done' });
    board.review('a', true, 'checked');
    assert.throws(() => board.start('b'), e => e.code === 'APPROVAL_REQUIRED');
    board.start('b', undefined, true);
    assert.equal(board.snapshot().tasks[1].status, 'running');
  });
  it('restores completed historical retries above a lowered shared limit', () => {
    const board = new TeamBoard({ ...sampleConfig, maxRetries: 5 });
    board.plan([{ id: 'old', title: 'Old', instructions: 'Do', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['old.js'] }]);
    board.approve('user');
    for (let i = 0; i < 4; i++) {
      board.start('old'); board.finish('old', { attempt: i }); board.review('old', false, `fix ${i}`);
    }
    board.start('old'); board.finish('old', { complete: true }); board.review('old', true, 'Accepted');
    const saved = board.snapshot();
    const restored = new TeamBoard({ ...sampleConfig, maxRetries: 2 }, saved);
    assert.deepEqual(restored.snapshot(), saved);
    assert.equal(restored.config.maxRetries, 2);
    assert.equal(restored.snapshot().tasks[0].reviewHistory.length, 5);
  });
  it('preserves per-review history including final failure and success', () => {
    const board = new TeamBoard({ ...sampleConfig, maxRetries: 1 });
    board.plan([{ id: 'hist', title: 'History', instructions: 'Do', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['hist.js'] }]);
    board.approve('user');
    board.start('hist');
    board.finish('hist', { attempt: 1 });
    board.review('hist', false, 'First: missing edge cases');
    board.start('hist');
    board.finish('hist', { attempt: 2 });
    const failed = board.review('hist', false, 'Second: regression remains');
    const task = failed.tasks[0];
    assert.equal(task.status, 'needs_attention');
    assert.equal(task.waitingReason, 'RETRY_LIMIT_REACHED');
    assert.equal(task.reviewHistory.length, 2);
    assert.throws(() => board.retry('hist'), error => error.code === 'INVALID_STATE');
    const continued = board.continueAfterRetryLimit('hist', 'user');
    assert.equal(continued.tasks[0].status, 'pending');
    assert.equal(continued.tasks[0].retries, 2);
    const pendingExtra = new TeamBoard({ ...sampleConfig, maxRetries: 1 }, continued);
    assert.equal(pendingExtra.snapshot().tasks[0].extraRetryCredit, 1);
    board.start('hist');
    board.finish('hist', { attempt: 3 });
    const exhausted = board.review('hist', false, 'Third: still failing');
    assert.equal(exhausted.tasks[0].waitingReason, 'RETRY_LIMIT_REACHED');
    assert.equal(exhausted.tasks[0].retries, 2);
    assert.equal(exhausted.tasks[0].reviewHistory.length, 3);
    assert.equal(continued.tasks[0].reviewHistory.length, 2);
    assert.equal(task.reviewHistory[0].feedback, 'First: missing edge cases');
    assert.equal(task.reviewHistory[1].feedback, 'Second: regression remains');
    const restored = new TeamBoard({ ...sampleConfig, maxRetries: 1 }, failed);
    assert.equal(restored.snapshot().tasks[0].reviewHistory.length, 2);
    assert.equal(restored.snapshot().tasks[0].waitingReason, 'RETRY_LIMIT_REACHED');
  });

  it('saves settings without clearing tasks or approval', () => {
    const board = new TeamBoard(sampleConfig);
    board.plan([{ id: 'save-test', title: 'Save', instructions: 'Test', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['save-test.js'] }], 'model');
    board.approve('user');
    const before = board.snapshot();
    board.reconfigure({ ...sampleConfig, leadPrompt: 'Changed', maxParallel: 3, askApprovalPrompt: true });
    assert.deepEqual(board.snapshot(), before);
    assert.equal(board.config.leadPrompt, 'Changed');
    assert.equal(board.config.maxParallel, 3);
    assert.throws(() => board.reconfigure({ ...sampleConfig, maxParallel: 0 }));
    assert.equal(board.config.maxParallel, 3);
  });
  it('rejects writable tasks that omit precise scopes', () => {
    const board = new TeamBoard(sampleConfig);
    assert.throws(() => board.plan([{ id: 'no-scope', title: 'Unsafe', instructions: 'write', acceptance: 'done', memberId: 'worker1' }]), error => error.code === 'MISSING_WRITE_SCOPE');
  });

  it('runs disjoint write scopes concurrently and blocks overlapping scopes', () => {
    const parallelConfig = { ...sampleConfig, maxParallel: 2, members: [...sampleConfig.members, { id: 'worker2', name: 'Worker 2', provider: 'p', model: 'm', role: 'r', instructions: '', enabled: true, readOnly: false }] };
    const serialConfig = { ...parallelConfig, maxParallel: 1 };
    const board = new TeamBoard(parallelConfig);
    board.plan([
      { id: 'a', title: 'A', instructions: 'a', acceptance: 'done', memberId: 'worker1', writeScopes: ['src/a'] },
      { id: 'b', title: 'B', instructions: 'b', acceptance: 'done', memberId: 'worker2', writeScopes: ['src/b'] },
    ]);
    board.approve('user');
    board.start('a');
    board.start('b');
    assert.equal(board.snapshot().tasks.filter(t => t.status === 'running').length, 2);

    const conflict = new TeamBoard(parallelConfig);
    conflict.plan([
      { id: 'a', title: 'A', instructions: 'a', acceptance: 'done', memberId: 'worker1', writeScopes: ['src/shared'] },
      { id: 'b', title: 'B', instructions: 'b', acceptance: 'done', memberId: 'worker2', writeScopes: ['src/shared/file.js'] },
    ]);
    conflict.approve('user');
    conflict.start('a');
    assert.throws(() => conflict.start('b'), error => error.code === 'WRITE_SCOPE_CONFLICT');

    const limited = new TeamBoard(serialConfig);
    limited.plan([
      { id: 'x', title: 'X', instructions: 'x', acceptance: 'done', memberId: 'worker1', writeScopes: ['x.js'] },
      { id: 'y', title: 'Y', instructions: 'y', acceptance: 'done', memberId: 'worker2', writeScopes: ['y.js'] },
    ]);
    limited.approve('user');
    limited.start('x');
    assert.throws(() => limited.start('y'), error => error.code === 'PARALLEL_LIMIT');
  });

  it('initializes in draft status', () => {
    const board = new TeamBoard(sampleConfig);
    const snap = board.snapshot();
    assert.equal(snap.status, 'draft');
    assert.equal(snap.revision, 0);
    assert.equal(snap.approved, false);
    assert.equal(snap.tasks.length, 0);
  });

  it('rejects duplicate member IDs in config', () => {
    assert.throws(() => new TeamBoard({
      ...sampleConfig,
      members: [
        { id: 'm1', name: 'M1', provider: 'p', model: 'm', role: 'r', instructions: '', enabled: true, readOnly: false },
        { id: 'm1', name: 'M2', provider: 'p', model: 'm', role: 'r', instructions: '', enabled: true, readOnly: false },
      ]
    }), (err) => err instanceof BoardError && err.code === 'INVALID_INPUT');
  });

  it('allows model to plan tasks and requires approval', () => {
    const board = new TeamBoard(sampleConfig);
    const tasks = [
      { id: 't1', title: 'Plan UI', instructions: 'Draft design', acceptance: 'Done design', memberId: 'worker1', writeScopes: ['src/ui'] },
      { id: 't2', title: 'Run tests', instructions: 'Run suite', acceptance: 'Pass', memberId: 'tester', dependencies: ['t1'], readOnly: true },
    ];
    const snap1 = board.plan(tasks, 'model');
    assert.equal(snap1.status, 'ready');
    assert.equal(snap1.approved, false);
    assert.equal(snap1.revision, 1);

    // cannot start before approval
    assert.throws(() => board.start('t1'), (err) => err instanceof BoardError && err.code === 'APPROVAL_REQUIRED');

    // approve by user
    const snap2 = board.approve('user', snap1.revision);
    assert.equal(snap2.approved, true);
    assert.equal(snap2.revision, 2);

    // start t1
    const snap3 = board.start('t1', snap2.revision);
    assert.equal(snap3.tasks.find(t => t.id === 't1').status, 'running');

    // t2 cannot start because dependency t1 is not done
    assert.throws(() => board.start('t2', snap3.revision), (err) => err instanceof BoardError && err.code === 'DEPENDENCY_NOT_DONE');

    // finish t1 -> status becomes review
    const snap4 = board.finish('t1', { files: ['src/ui/app.js'] }, snap3.revision);
    assert.equal(snap4.tasks.find(t => t.id === 't1').status, 'review');

    // review t1 with reject -> returns to pending with retry incremented
    const snap5 = board.review('t1', false, 'Missing button', snap4.revision);
    const t1AfterReject = snap5.tasks.find(t => t.id === 't1');
    assert.equal(t1AfterReject.status, 'pending');
    assert.equal(t1AfterReject.retries, 1);
    assert.equal(t1AfterReject.reviewHistory.length, 1);
    assert.equal(t1AfterReject.reviewHistory[0].feedback, 'Missing button');

    // rerun and review pass
    board.start('t1', snap5.revision);
    const snap6 = board.finish('t1', { files: ['src/ui/app.js', 'src/ui/btn.js'] });
    const snap7 = board.review('t1', true, 'LGTM', snap6.revision);
    assert.equal(snap7.tasks.find(t => t.id === 't1').status, 'done');
    assert.equal(snap7.tasks.find(t => t.id === 't1').reviewHistory.length, 2);
    assert.equal(snap7.tasks.find(t => t.id === 't1').reviewHistory[1].passed, true);

    // now t2 can start
    const snap8 = board.start('t2', snap7.revision);
    assert.equal(snap8.tasks.find(t => t.id === 't2').status, 'running');
  });

  it('enforces user lock and manual mode rules', () => {
    const manualConfig = { ...sampleConfig, mode: 'manual' };
    const board = new TeamBoard(manualConfig);
    
    // In manual mode, model cannot provide memberId
    assert.throws(() => board.plan([
      { id: 't1', title: 'Task 1', instructions: 'Do it', acceptance: 'Done', memberId: 'worker1', writeScopes: ['task.js'] }
    ], 'model'), (err) => err instanceof BoardError && err.code === 'MANUAL_ASSIGNMENT');

    // Model can plan without memberId
    board.plan([
      { id: 't1', title: 'Task 1', instructions: 'Do it', acceptance: 'Done' }
    ], 'model');

    // User assigns memberId
    board.assign('t1', 'worker1', 'user');
    const snap = board.snapshot();
    assert.equal(snap.tasks[0].locked, true);
    assert.equal(snap.tasks[0].memberId, 'worker1');

    // Model cannot reassign locked task
    assert.throws(() => board.assign('t1', 'tester', 'model'), (err) => err instanceof BoardError && err.code === 'LOCKED');
  });

  it('restores interrupted state safely to needs_attention', () => {
    const board1 = new TeamBoard(sampleConfig);
    board1.plan([{ id: 't1', title: 'Task 1', instructions: 'Inst', acceptance: 'Done', memberId: 'worker1', writeScopes: ['a'] }]);
    board1.approve('user');
    board1.start('t1');
    const snap = board1.snapshot();
    assert.equal(snap.tasks[0].status, 'running');

    // Restore into a new board instance
    const board2 = new TeamBoard(sampleConfig, snap);
    const restored = board2.snapshot();
    assert.equal(restored.tasks[0].status, 'needs_attention');
    assert.equal(restored.revision, snap.revision + 1);

    // cannot start directly, user must retry explicitly
    assert.throws(() => board2.start('t1'), (err) => err instanceof BoardError && err.code === 'INVALID_STATE');
    board2.retry('t1', 'user');
    assert.equal(board2.snapshot().tasks[0].status, 'pending');
  });

  it('detects cyclic dependencies', () => {
    const board = new TeamBoard(sampleConfig);
    assert.throws(() => board.plan([
      { id: 'a', title: 'A', instructions: 'A', acceptance: 'A', dependencies: ['b'] },
      { id: 'b', title: 'B', instructions: 'B', acceptance: 'B', dependencies: ['a'] },
    ]), (err) => err instanceof BoardError && err.code === 'DEPENDENCY_CYCLE');
  });

  it('supports bossDirect mode and auto-assigns single/multi tasks to available workers', () => {
    const bossConfig = { ...sampleConfig, bossDirect: true };
    const board = new TeamBoard(bossConfig);
    assert.equal(board.config.bossDirect, true);

    // Single task without memberId: model plans it, BOSS直派 automatically assigns worker1
    const singleTaskPlan = [
      { id: 'single-1', title: 'Single task', instructions: 'Fix bug', acceptance: 'Done', writeScopes: ['src/ui'] }
    ];
    const snap1 = board.plan(singleTaskPlan, 'model');
    assert.equal(snap1.tasks[0].memberId, 'worker1');

    // Multi-task without memberId: also assigned
    const board2 = new TeamBoard(bossConfig);
    const multiTaskPlan = [
      { id: 'm-1', title: 'Task 1', instructions: 'Do UI', acceptance: 'Done', writeScopes: ['src/ui'] },
      { id: 'm-2', title: 'Task 2', instructions: 'Do QA', acceptance: 'Pass', readOnly: true }
    ];
    const snap2 = board2.plan(multiTaskPlan, 'model');
    assert.equal(snap2.tasks[0].memberId, 'worker1');
    assert.equal(snap2.tasks[1].memberId, 'worker1');
  });

  it('invalid plan does not mutate state or revision (CAS safety)', () => {
    const board = new TeamBoard(sampleConfig);
    board.plan([{ id: 'valid-init', title: 'Valid', instructions: 'Inst', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/valid.js'] }]);
    board.approve('user');
    const before = board.snapshot();

    // 提交缺失并行理由的无效计划
    assert.throws(() => {
      board.plan({
        tasks: [
          { id: 'p1', title: 'P1', instructions: 'p1', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/p1.js'] },
          { id: 'p2', title: 'P2', instructions: 'p2', acceptance: 'Pass', memberId: 'tester', writeScopes: ['src/p2.js'] },
        ],
        planningRationale: '规划理由',
        // 缺少 parallelizationJustification
      });
    }, (err) => err.code === 'MISSING_PARALLELIZATION_JUSTIFICATION');

    // 状态完全未受影响
    assert.deepEqual(board.snapshot(), before);
    assert.equal(board.snapshot().revision, before.revision);
  });

  it('appending tasks or changing scopes/dependencies revokes plan approval', () => {
    const board = new TeamBoard(sampleConfig);
    board.plan([{ id: 'task-a', title: 'A', instructions: 'a', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/a.js'] }]);
    board.approve('user');
    assert.equal(board.snapshot().approved, true);

    // 追加任务撤销批准
    board.appendTasks([{ id: 'task-b', title: 'B', instructions: 'b', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/b.js'] }]);
    assert.equal(board.snapshot().approved, false);
    assert.equal(board.snapshot().tasks.length, 2);

    board.approve('user');
    assert.equal(board.snapshot().approved, true);

    // 修改任务 writeScopes 撤销批准
    board.plan([
      { id: 'task-a', title: 'A', instructions: 'a', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/a-diff.js'] },
      { id: 'task-b', title: 'B', instructions: 'b', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/b.js'] },
    ]);
    assert.equal(board.snapshot().approved, false);
  });

  it('appendTasks blocks overwriting active tasks and validates dependencies', () => {
    const board = new TeamBoard(sampleConfig);
    board.plan([
      { id: 'task-1', title: 'Task 1', instructions: 't1', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/t1.js'] },
      { id: 'task-2', title: 'Task 2', instructions: 't2', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/t2.js'] },
    ]);
    board.approve('user');
    board.start('task-1');

    // 活跃任务保护：禁止通过 appendTasks 覆盖正在 running 的 task-1
    assert.throws(
      () => board.appendTasks([{ id: 'task-1', title: 'Tamper', instructions: 't', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/t1.js'] }]),
      (err) => err.code === 'DUPLICATE_TASK_ID' || err.code === 'CANNOT_OVERWRITE_ACTIVE_TASK'
    );

    // 依赖校验：追加任务依赖不存在的任务时抛出 INVALID_DEPENDENCY
    assert.throws(
      () => board.appendTasks([{ id: 'task-3', title: 'Task 3', instructions: 't3', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/t3.js'], dependencies: ['non-existent'] }]),
      (err) => err.code === 'INVALID_DEPENDENCY'
    );

    // 合法结构化追加任务核查与批准撤销
    board.appendTasks({
      tasks: [{ id: 'task-3', title: 'Task 3', instructions: 't3', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/t3.js'], dependencies: ['task-2'] }],
      planningRationale: '追加第3阶段',
      parallelizationJustification: 'task-3 串行依赖 task-2'
    });
    assert.equal(board.snapshot().approved, false);
  });

  it('drain lifecycle ensures system is only declared safe to shutdown when fully drained and host settlement injected', () => {
    const board = new TeamBoard(sampleConfig);
    board.plan([{ id: 't-d', title: 'D', instructions: 'd', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/d.js'] }]);
    board.approve('user');

    // 1. 普通 ready 空闲板：安全关机必须为 false，未请求排空不可标 safeToShutdown
    const readyDrain = board.getDrainStatus();
    assert.equal(readyDrain.status, 'ready');
    assert.equal(readyDrain.isDrained, false);
    assert.equal(readyDrain.safeToShutdown, false);
    assert.equal(readyDrain.processStopped, false);

    // 2. 普通 paused 空闲板：同样不可声明 safeToShutdown
    board.pause();
    const pauseDrain = board.getDrainStatus();
    assert.equal(pauseDrain.status, 'paused');
    assert.equal(pauseDrain.isDrained, false);
    assert.equal(pauseDrain.safeToShutdown, false);
    assert.equal(pauseDrain.processStopped, false);
    board.resume();

    // 3. 运行中有任务时，drain() 返回 draining，safeToShutdown 为 false
    board.start('t-d');
    const epoch = board.snapshot().tasks[0].executionEpoch;
    board.drain();
    assert.equal(board.getDrainStatus().status, 'draining');
    assert.equal(board.getDrainStatus().safeToShutdown, false);
    assert.equal(board.getDrainStatus().isDrained, false);
    assert.equal(board.getDrainStatus().processStopped, false);

    // 4. 任务完成结算
    board.finish('t-d', { done: true }, undefined, epoch);

    // 5. 结算完成后仅调用 drain()（未注入宿主真实 settlement），虽然 core 状态为 drained，但安全关机仍为 false
    board.drain();
    assert.equal(board.getDrainStatus().status, 'drained');
    assert.equal(board.getDrainStatus().isDrained, true);
    assert.equal(board.getDrainStatus().safeToShutdown, false);
    assert.equal(board.getDrainStatus().processStopped, false);

    // 6. 宿主真实 settlement + processStopped 显式注入后，才正式声明安全关机
    board.drain({ settled: true, processStopped: true });
    assert.equal(board.getDrainStatus().status, 'drained');
    assert.equal(board.getDrainStatus().isDrained, true);
    assert.equal(board.getDrainStatus().processStopped, true);
    assert.equal(board.getDrainStatus().safeToShutdown, true);
  });
});
