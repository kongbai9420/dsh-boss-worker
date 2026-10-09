import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyParentReview, clearNotifiedReviews, getNotifiedReviews, getReviewNoticeStates } from '../src/review-notifier.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const snapshot = { status: 'ready', batchId: 1, tasks: [{ id: 't', title: 'test', status: 'review', executionEpoch: 1, acceptance: 'inspect' }] };
  const board = { snapshot: () => structuredClone(snapshot) };
  const parent = { status: 'idle', followup() {} };
  const args = { sessionId: 'session', board, taskId: 't', epoch: 1, parentAgentOverride: parent, now: 0 };
  return { snapshot, board, parent, args };
}
test('child and fallback routes share claims, cooldown and successful dedupe', async () => {
  clearNotifiedReviews();
  const { args, parent, snapshot } = fixture();
  const wait = deferred();
  let calls = 0;
  parent.followup = () => { calls++; return wait.promise; };
  const first = notifyParentReview({ ...args, childId: 'child' });
  assert.equal((await notifyParentReview(args)).reason, 'IN_FLIGHT');
  snapshot.tasks[0].evidence = { dispatch: { childId: 'child-2' } };
  assert.equal((await notifyParentReview({ ...args, reminder: true })).reason, 'IN_FLIGHT');
  wait.resolve();
  assert.equal((await first).delivered, true);
  assert.equal((await notifyParentReview(args)).reason, 'ALREADY_NOTIFIED');
  assert.equal((await notifyParentReview({ ...args, reminder: true, now: 1 })).reason, 'COOLDOWN');
  assert.equal(calls, 1);
});
test('new board identity delivers reused IDs; explicit generation dedupes wrappers', async () => {
  clearNotifiedReviews();
  const a = fixture(), b = fixture();
  assert.equal((await notifyParentReview(a.args)).delivered, true);
  assert.equal((await notifyParentReview(a.args)).reason, 'ALREADY_NOTIFIED');
  assert.equal((await notifyParentReview(b.args)).delivered, true);
  assert.equal((await notifyParentReview({ ...a.args, generation: 'g1' })).delivered, true);
  assert.equal((await notifyParentReview({ ...b.args, generation: 'g1', childId: 'other' })).reason, 'ALREADY_NOTIFIED');
  assert.equal((await notifyParentReview({ ...a.args, generation: 'g2' })).delivered, true);
});
for (const [name, mutate, reason] of [
  ['pause', s => { s.status = 'paused'; }, 'BOARD_TERMINAL_OR_PAUSED'],
  ['board done', s => { s.status = 'done'; }, 'BOARD_TERMINAL_OR_PAUSED'],
  ['task done', s => { s.tasks[0].status = 'done'; }, 'TASK_NOT_IN_REVIEW'],
  ['epoch', s => { s.tasks[0].executionEpoch = 2; }, 'EPOCH_MISMATCH'],
  ['batch', s => { s.batchId = 2; }, 'GENERATION_MISMATCH']
]) {
  test(`pending followup observes ${name} without pretending delivery can be revoked`, async () => {
    clearNotifiedReviews();
    const { args, parent, snapshot } = fixture();
    const wait = deferred();
    parent.followup = () => wait.promise;
    const pending = notifyParentReview(args);
    mutate(snapshot);
    wait.resolve();
    const result = await pending;
    assert.equal(result.delivered, true);
    assert.equal(result.stale, true);
    assert.equal(result.staleReason, reason);
    assert.equal(getNotifiedReviews().length, 1);
    snapshot.status = 'ready'; snapshot.tasks[0].status = 'review';
    if (name === 'epoch' || name === 'batch') {
      assert.equal((await notifyParentReview({ ...args, epoch: snapshot.tasks[0].executionEpoch })).delivered, true);
      assert.equal(getNotifiedReviews().length, 2);
    } else assert.equal((await notifyParentReview(args)).reason, 'ALREADY_NOTIFIED');
  });
}
test('state changing during message construction is rejected at followup boundary', async () => {
  clearNotifiedReviews();
  const { args, board, parent, snapshot } = fixture();
  let reads = 0, calls = 0;
  board.snapshot = () => { if (++reads === 2) snapshot.status = 'paused'; return structuredClone(snapshot); };
  parent.followup = () => { calls++; };
  assert.equal((await notifyParentReview(args)).reason, 'BOARD_TERMINAL_OR_PAUSED');
  assert.equal(calls, 0);
});
test('clear fences old completion and finally from a newer in-flight claim', async () => {
  clearNotifiedReviews();
  const { args, parent } = fixture();
  const old = deferred(), fresh = deferred();
  parent.followup = () => old.promise;
  const first = notifyParentReview(args);
  clearNotifiedReviews();
  parent.followup = () => fresh.promise;
  const second = notifyParentReview(args);
  old.resolve();
  assert.equal((await first).reason, 'NOTICE_STATE_CLEARED');
  assert.equal(getNotifiedReviews().length, 0);
  assert.equal((await notifyParentReview(args)).reason, 'IN_FLIGHT');
  fresh.resolve();
  assert.equal((await second).delivered, true);
  assert.equal(getReviewNoticeStates('session')[0].attempts, 1);
});
test('clear fences a late rejection from newer successful delivery', async () => {
  clearNotifiedReviews();
  const { args, parent } = fixture();
  const old = deferred();
  parent.followup = () => old.promise;
  const first = notifyParentReview(args);
  clearNotifiedReviews();
  parent.followup = () => {};
  assert.equal((await notifyParentReview(args)).delivered, true);
  old.reject(new Error('old failure'));
  assert.equal((await first).reason, 'DELIVERY_EXCEPTION');
  assert.equal(getReviewNoticeStates('session')[0].delivered, true);
  assert.equal(getReviewNoticeStates('session')[0].attempts, 1);
  assert.equal((await notifyParentReview(args)).reason, 'ALREADY_NOTIFIED');
});
test('explicit generation accepts stable scalars only and distinguishes numeric/string IDs', async () => {
  clearNotifiedReviews();
  const { args } = fixture();
  for (const generation of [{}, NaN, Infinity, true, 1n]) {
    assert.equal((await notifyParentReview({ ...args, generation })).reason, 'INVALID_GENERATION');
  }
  assert.equal((await notifyParentReview({ ...args, generation: 1 })).delivered, true);
  assert.equal((await notifyParentReview({ ...args, generation: '1' })).delivered, true);
});
test('failed reminders are immediately retryable and do not consume delivery budget', async () => {
  clearNotifiedReviews();
  const { args, parent } = fixture();
  await notifyParentReview(args);
  parent.followup = async () => { throw new Error('offline'); };
  const reminder = { ...args, reminder: true, now: 180000, maxReminders: 1 };
  for (let i = 0; i < 4; i++) assert.equal((await notifyParentReview(reminder)).reason, 'DELIVERY_EXCEPTION');
  parent.followup = () => {};
  assert.equal((await notifyParentReview(reminder)).delivered, true);
  assert.equal((await notifyParentReview({ ...reminder, now: 360000 })).reason, 'REMINDER_LIMIT');
  assert.equal(getReviewNoticeStates('session')[0].deliveries, 2);
});
test('concurrent reminders allow only one async followup', async () => {
  clearNotifiedReviews();
  const { args, parent } = fixture();
  await notifyParentReview(args);
  const wait = deferred();
  parent.followup = () => wait.promise;
  const reminder = { ...args, reminder: true, now: 180000 };
  const pending = notifyParentReview(reminder);
  assert.equal((await notifyParentReview(reminder)).reason, 'IN_FLIGHT');
  wait.reject(new Error('retry'));
  assert.equal((await pending).reason, 'DELIVERY_EXCEPTION');
  parent.followup = () => {};
  assert.equal((await notifyParentReview(reminder)).delivered, true);
});
