import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyParentReview, clearNotifiedReviews, getReviewNoticeStates } from '../src/review-notifier.mjs';

test('async delivery failure is not falsely deduped and successful retry is awaited', async () => {
  clearNotifiedReviews();
  const board = { snapshot: () => ({ status: 'ready', tasks: [{ id: 't', title: 't', executionEpoch: 1, status: 'review', acceptance: 'inspect' }] }) };
  let calls = 0;
  const parent = { status: 'idle', async followup() { if (++calls === 1) throw new Error('async rejected'); } };
  const args = { sessionId: 'mock', taskId: 't', epoch: 1, board, parentAgentOverride: parent };
  assert.equal((await notifyParentReview(args)).reason, 'DELIVERY_EXCEPTION');
  assert.equal(getReviewNoticeStates('mock')[0].delivered, false);
  assert.equal((await notifyParentReview(args)).delivered, true);
  assert.equal((await notifyParentReview(args)).reason, 'ALREADY_NOTIFIED');
});
test('idle reminders are limited, spaced and never accept paused or completed work', async () => {
  clearNotifiedReviews();
  let status = 'ready', taskStatus = 'review', calls = 0;
  const parent = { status: 'idle', async followup() { calls++; } };
  const board = { snapshot: () => ({ status, tasks: [{ id: 't', title: 't', executionEpoch: 1, status: taskStatus, acceptance: 'inspect' }] }) };
  const args = { sessionId: 'bounded', taskId: 't', epoch: 1, board, parentAgentOverride: parent };
  await notifyParentReview({ ...args, now: 0 });
  assert.equal((await notifyParentReview({ ...args, reminder: true, now: 1 })).reason, 'COOLDOWN');
  parent.status = 'running';
  assert.equal((await notifyParentReview({ ...args, reminder: true, now: 180000 })).reason, 'PARENT_BUSY');
  parent.status = 'idle';
  await notifyParentReview({ ...args, reminder: true, now: 180000 });
  await notifyParentReview({ ...args, reminder: true, now: 360000 });
  assert.equal((await notifyParentReview({ ...args, reminder: true, now: 540000 })).reason, 'REMINDER_LIMIT');
  status = 'paused';
  assert.equal((await notifyParentReview(args)).reason, 'BOARD_TERMINAL_OR_PAUSED');
  status = 'ready'; taskStatus = 'done';
  assert.equal((await notifyParentReview(args)).reason, 'TASK_NOT_IN_REVIEW');
  assert.equal(calls, 3);
});
