import test from 'node:test';
import assert from 'node:assert/strict';
import { TeamBoard } from '../src/core.mjs';

test('a scope-blocked pending task cannot reserve a spare needed by independent work', () => {
  const member = { id: 'w', name: 'worker', provider: 'p', model: 'm', role: 'code', instructions: '', enabled: true, readOnly: false };
  const board = new TeamBoard({ enabled: true, mode: 'mixed', maxParallel: 2, maxRetries: 1, confirmPlan: true, members: [member, { ...member, id: 'clone' }] });
  board.plan(['running', 'blocked', 'independent'].map(id => ({ id, title: id, instructions: 'implement', acceptance: 'test', memberId: 'w', writeScopes: [id === 'independent' ? 'other' : 'shared'] })));
  board.approve();
  board.start('running');
  board.balanceReadyAssignments();
  const tasks = board.snapshot().tasks;
  assert.equal(tasks.find(t => t.id === 'blocked').memberId, 'w');
  assert.equal(tasks.find(t => t.id === 'independent').memberId, 'clone');
  board.start('independent');
  assert.equal(board.snapshot().tasks.filter(t => t.status === 'running').length, 2);
});
