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

console.log('Testing TeamBoard...');

// 1. Initial status
{
  const board = new TeamBoard(sampleConfig);
  const snap = board.snapshot();
  assert.equal(snap.status, 'draft');
  assert.equal(snap.revision, 0);
  assert.equal(snap.approved, false);
  assert.equal(snap.tasks.length, 0);
  console.log('✓ Initial draft state');
}

// 2. Reject duplicate member IDs
{
  assert.throws(() => new TeamBoard({
    ...sampleConfig,
    members: [
      { id: 'm1', name: 'M1', provider: 'p', model: 'm', role: 'r', instructions: '', enabled: true, readOnly: false },
      { id: 'm1', name: 'M2', provider: 'p', model: 'm', role: 'r', instructions: '', enabled: true, readOnly: false },
    ]
  }), (err) => err instanceof BoardError && err.code === 'INVALID_INPUT');
  console.log('✓ Reject duplicate member IDs');
}

// 3. Plan, approve, dependencies, review, reject retry, then done
{
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

  // rerun and review pass
  board.start('t1', snap5.revision);
  const snap6 = board.finish('t1', { files: ['src/ui/app.js', 'src/ui/btn.js'] });
  const snap7 = board.review('t1', true, 'LGTM', snap6.revision);
  assert.equal(snap7.tasks.find(t => t.id === 't1').status, 'done');

  // now t2 can start
  const snap8 = board.start('t2', snap7.revision);
  assert.equal(snap8.tasks.find(t => t.id === 't2').status, 'running');
  console.log('✓ Plan, approval, dependency, rejection retry, and completion loop');
}

// 4. User locks & manual mode
{
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
  console.log('✓ User locks and manual mode assignment constraints');
}

// 5. Restore interrupted state to needs_attention
{
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
  console.log('✓ Restores interrupted running task to needs_attention');
}

// 6. Cyclic dependency detection
{
  const board = new TeamBoard(sampleConfig);
  assert.throws(() => board.plan([
    { id: 'a', title: 'A', instructions: 'A', acceptance: 'A', dependencies: ['b'] },
    { id: 'b', title: 'B', instructions: 'B', acceptance: 'B', dependencies: ['a'] },
  ]), (err) => err instanceof BoardError && err.code === 'DEPENDENCY_CYCLE');
  console.log('✓ Cyclic dependency detected');
}

console.log('\nAll 6 test suites passed cleanly!');
