import test from 'node:test';
import assert from 'node:assert/strict';
import { TeamBoard } from '../src/core.mjs';
import { createLeadWorkerTools } from '../src/tools.mjs';

const config = {
  enabled: true, mode: 'mixed', bossDirect: true, autopilot: false,
  confirmPlan: true, maxParallel: 2, maxRetries: 2,
  members: [{ id: 'worker', name: 'Worker', provider: 'mock', model: 'mock',
    role: 'Dev', instructions: 'Code', enabled: true, readOnly: false }],
};
const task = id => ({ id, title: `Task ${id}`, instructions: `Implement ${id}`,
  acceptance: `Verify ${id}`, memberId: 'worker', writeScopes: [`src/${id}.js`] });
const exec = { agent: { session: { header: { id: 'plan-consent-test' } } } };
const answer = selected => ({ answers: [{ id: 'lead-worker-plan-consent', selected }] });

function fixture(extra = {}) {
  const board = new TeamBoard({ ...config, ...extra });
  const calls = { plan: 0, appendTasks: 0, approve: 0, schedule: 0, questions: 0 };
  for (const name of ['plan', 'appendTasks', 'approve']) {
    const original = board[name].bind(board);
    board[name] = (...args) => { calls[name]++; return original(...args); };
  }
  let respond = () => answer(['批准执行计划']);
  const tools = createLeadWorkerTools({
    getBoard: () => board,
    getMemberCatalog: () => board.config.members,
    dispatchTask: async () => { throw new Error('Unexpected direct dispatch'); },
    scheduleReadyTasks: async (sessionId, receivedExec) => {
      assert.equal(sessionId, 'plan-consent-test');
      assert.equal(receivedExec, exec);
      assert.equal(board.snapshot().approved, true, 'scheduling must follow approval');
      calls.schedule++;
      return [];
    },
    askUserQuestion: async (questions, receivedExec) => {
      calls.questions++;
      assert.equal(receivedExec, exec);
      assert.equal(questions.length, 1);
      assert.equal(questions[0].id, 'lead-worker-plan-consent');
      assert.deepEqual(questions[0].options.map(option => option.label), ['批准执行计划', '不执行']);
      return respond(questions);
    },
  });
  return { board, calls, setResponse(fn) { respond = fn; },
    render: value => tools.find(tool => tool.name === 'lead_worker_plan').output.render({}, value),
    plan: args => tools.find(tool => tool.name === 'lead_worker_plan').execute(args, exec) };
}

for (const append of [false, true]) {
  test(`declining ${append ? 'append' : 'replacement'} leaves the complete live board deeply unchanged`, async () => {
    const f = fixture();
    f.board.plan([task('archived')], 'model');
    f.board.cancel();
    f.board.plan([task('existing')], 'model');
    f.board.approve('user');
    if (!append) f.board.cancel();
    const before = structuredClone(f.board.snapshot());
    const callsBefore = { ...f.calls };
    f.setResponse(questions => {
      assert.match(questions[0].question, /Task proposed：Verify proposed/);
      assert.deepEqual(f.board.snapshot(), before, 'preview cannot mutate the board before consent');
      assert.equal(f.calls.plan, callsBefore.plan);
      assert.equal(f.calls.appendTasks, callsBefore.appendTasks);
      assert.equal(f.calls.approve, callsBefore.approve);
      return answer(['不执行']);
    });
    const result = await f.plan({ append, tasks: [task('proposed')] });
    assert.equal(result.cancelled, true);
    assert.deepEqual(result.tasks, []);
    assert.equal(result.status, before.status);
    assert.match(result.hint, /未加入任务板/);
    assert.match(f.render(result)[0].text, /用户选择不执行/);
    assert.doesNotMatch(f.render(result)[0].text, /计划已提交/);
    assert.deepEqual(f.board.snapshot(), before, 'retain tasks, archives, approval, revision and history');
    assert.deepEqual(f.calls, { ...callsBefore, questions: 1 });
  });

  test(`accepting ${append ? 'append' : 'new plan'} prompts once, writes once and approves once`, async () => {
    const f = fixture({ askApprovalPrompt: true });
    if (append) {
      f.board.plan([task('existing')], 'model');
      f.board.approve('user');
    }
    const before = structuredClone(f.board.snapshot());
    const callsBefore = { ...f.calls };
    f.setResponse(() => {
      assert.deepEqual(f.board.snapshot(), before, 'nothing is written while awaiting approval');
      return answer(['批准执行计划']);
    });
    const result = await f.plan({ append, tasks: [task('accepted')] });
    assert.equal(result.approved, true);
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.tasks.map(t => t.id), append ? ['existing', 'accepted'] : ['accepted']);
    assert.deepEqual(result, f.board.snapshot());
    assert.deepEqual(f.calls, {
      ...callsBefore, questions: 1, schedule: 1,
      [append ? 'appendTasks' : 'plan']: callsBefore[append ? 'appendTasks' : 'plan'] + 1,
      approve: callsBefore.approve + 1,
    });
  });
}

test('missing or unrelated consent does not authorize or change a board', async () => {
  for (const response of [undefined, {}, answer([]), answer(['其他']),
    { answers: [{ id: 'other-question', selected: ['批准执行计划'] }] }]) {
    const f = fixture();
    const before = structuredClone(f.board.snapshot());
    f.setResponse(() => response);
    assert.equal((await f.plan({ tasks: [task('not-approved')] })).cancelled, true);
    assert.deepEqual(f.board.snapshot(), before);
    assert.deepEqual(f.calls, { plan: 0, appendTasks: 0, approve: 0, schedule: 0, questions: 1 });
  }
});

test('invalid plans are validated before asking consent and never mutate the live board', async () => {
  const f = fixture();
  f.board.plan([task('existing')], 'model');
  f.board.approve('user');
  f.board.cancel();
  const before = structuredClone(f.board.snapshot());
  const callsBefore = { ...f.calls };
  for (const tasks of [[], [task('duplicate'), task('duplicate')],
    [{ ...task('missing-dependency'), dependencies: ['unknown'] }],
    [{ ...task('no-scope'), writeScopes: [] }]]) {
    const result = await f.plan({ tasks });
    assert.ok(result.error);
    assert.deepEqual(f.board.snapshot(), before);
    assert.deepEqual(f.calls, callsBefore, 'invalid plan cannot prompt, write, approve or schedule');
  }
});

test('a board revision change while consent is open rejects the stale plan without further writes', async () => {
  const f = fixture();
  f.board.plan([task('existing')], 'model');
  const callsBefore = { ...f.calls };
  let changed;
  f.setResponse(() => {
    f.board.pause();
    changed = structuredClone(f.board.snapshot());
    return answer(['批准执行计划']);
  });
  const result = await f.plan({ tasks: [task('stale')] });
  assert.equal(result.code, 'PLAN_FAILED');
  assert.match(result.error, /确认期间任务板或模式已变更/);
  assert.deepEqual(f.board.snapshot(), changed, 'preserve the concurrent change without adding the stale plan');
  assert.deepEqual(f.calls, { ...callsBefore, questions: 1 });
});

test('a config-only change during consent rejects the stale plan even without a revision change', async () => {
  const f = fixture();
  const before = f.board.snapshot();
  let changedConfig;
  f.setResponse(() => {
    f.board.reconfigure({ ...f.board.config, maxParallel: 1 });
    changedConfig = f.board.config;
    assert.equal(f.board.snapshot().revision, before.revision);
    return answer(['批准执行计划']);
  });
  const result = await f.plan({ tasks: [task('stale-config')] });
  assert.equal(result.code, 'PLAN_FAILED');
  assert.match(result.error, /确认期间任务板或模式已变更/);
  assert.deepEqual(f.board.snapshot(), before);
  assert.deepEqual(f.board.config, changedConfig);
  assert.deepEqual(f.calls, { plan: 0, appendTasks: 0, approve: 0, schedule: 0, questions: 1 });
});

test('unassigned manual plan fails detached approval before prompting or changing the live board', async () => {
  const f = fixture({ mode: 'manual', bossDirect: false });
  const before = structuredClone(f.board.snapshot());
  const { memberId: _unused, ...unassigned } = task('unassigned');
  const result = await f.plan({ tasks: [unassigned] });
  assert.equal(result.code, 'UNASSIGNED');
  assert.deepEqual(f.board.snapshot(), before);
  assert.deepEqual(f.calls, { plan: 0, appendTasks: 0, approve: 0, schedule: 0, questions: 0 });
});

test('question failure leaves the complete board unchanged', async () => {
  const f = fixture();
  const before = structuredClone(f.board.snapshot());
  f.setResponse(() => { throw new Error('Question unavailable'); });
  const result = await f.plan({ tasks: [task('not-written')] });
  assert.equal(result.code, 'PLAN_FAILED');
  assert.match(result.error, /Question unavailable/);
  assert.deepEqual(f.board.snapshot(), before);
  assert.deepEqual(f.calls, { plan: 0, appendTasks: 0, approve: 0, schedule: 0, questions: 1 });
});

for (const extra of [{ autopilot: true }, { confirmPlan: false }, { askApprovalPrompt: false }]) {
  test(`inline consent bypass respects ${Object.keys(extra)[0]} without asking`, async () => {
    const f = fixture({ askApprovalPrompt: true, ...extra });
    f.setResponse(() => { throw new Error('Consent must not be requested'); });
    const result = await f.plan({ tasks: [task('bypassed')] });
    assert.equal(result.tasks[0].id, 'bypassed');
    assert.equal(result.approved, extra.autopilot === true || extra.confirmPlan === false);
    assert.equal(f.calls.questions, 0);
    assert.equal(f.calls.plan, 1);
    assert.equal(f.calls.approve, 0, 'only explicit consent should call the approval method');
    assert.equal(f.calls.schedule, extra.autopilot === true ? 1 : 0);
    if (extra.askApprovalPrompt === false) {
      assert.throws(() => f.board.start('bypassed'), err => err.code === 'APPROVAL_REQUIRED');
    }
  });
}
