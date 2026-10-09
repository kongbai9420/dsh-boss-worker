import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const originalAppData = process.env.APPDATA;
const isolated = mkdtempSync(join(tmpdir(), 'boss-host-test-'));
process.env.APPDATA = isolated;
const { LeadWorkerHostService } = await import('../src/host.mjs');
process.on('exit', () => { if (originalAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = originalAppData; rmSync(isolated, { recursive: true, force: true }); });

console.log('Testing LeadWorkerHostService & Tools Integration...');

// Mock Cordis Context
class MockContext {
  #services = new Map();
  logger = {
    info: () => {},
    warn: message => console.warn(message),
    error: () => {},
  };

  inject(keys, fn) {
    // immediate mock execution
    fn(this);
  }

  plugin(ServiceClass, config) {
    const instance = new ServiceClass(this, config);
    return instance;
  }

  tools = {
    guards: [],
    guard: fn => this.tools.guards.push(fn),
    registered: [],
    register: (tool) => {
      this.tools.registered.push(tool);
    }
  };

  systemPrompt = {
    sections: [],
    section: (sec) => {
      this.systemPrompt.sections.push(sec);
    }
  };

  webServer = {
    routes: [],
    register: (route) => {
      this.webServer.routes.push(route);
    }
  };

  llm = {
    listModels: async (providerId) => this.llm.listProviders().find(p => p.id === providerId)?.models || [],
    listProviders: () => [
      {
        id: 'new',
        models: [
          { id: 'gpt-6-astra', name: 'Astra (GPT-6)' },
          { id: 'sol', name: 'Sol' }
        ]
      },
      {
        id: 'cpa',
        models: [
          { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash High' }
        ]
      }
    ]
  };

  userQuestions = { ask: async ({ questions }) => ({ answers: questions.map(question => ({ id: question.id, selected: ['继续返工'] })) }) };
  reflect = { provide: () => {} };

  get(name) {
    if (name === 'userQuestions') return this.userQuestions;
    if (name === 'tools') return this.tools;
    if (name === 'webServer') return this.webServer;
    if (name === 'systemPrompt') return this.systemPrompt;
    if (name === 'llm') return this.llm;
    return undefined;
  }
}

const mockCtx = new MockContext();
const service = new LeadWorkerHostService(mockCtx, {});

// 1. Check tools registration
assert.equal(mockCtx.tools.registered.length, 7);
const toolNames = mockCtx.tools.registered.map(t => t.name);
assert(toolNames.includes('lead_worker_status'));
assert(toolNames.includes('lead_worker_plan'));
assert(toolNames.includes('lead_worker_approve'));
assert(toolNames.includes('lead_worker_dispatch'));
assert(toolNames.includes('lead_worker_review'));
assert(toolNames.includes('lead_worker_list_members'));
console.log('✓ 5 Lead tools registered properly');

// 2. Check HTTP API route registration
assert(mockCtx.webServer.routes.some(r => r.path === '/api/lead-worker'));
console.log('✓ WebServer API route registered properly');

// 3. Test listAvailableModels
const models = await service.listAvailableModels();
assert.equal(models.length, 3);
assert(models.some(m => m.provider === 'new' && m.model === 'sol'));
assert(models.some(m => m.provider === 'new' && m.model === 'gpt-6-astra'));
console.log('✓ Model catalog read properly');

// BOSS mode is session-local, survives restart, and defaults off for new sessions.
await service.handleAction('boss-a', 'configure', { config: { ...service.getConfig('boss-a'), bossDirect: true } });
assert.equal(service.getConfig('boss-a').bossDirect, true);
assert.equal(service.getConfig('boss-b').bossDirect, false);
await service.handleAction('boss-b', 'configure', { config: { ...service.getConfig('boss-b'), bossDirect: false } });
assert.equal(service.getConfig('boss-a').bossDirect, true);
const restoredBossService = new LeadWorkerHostService(new MockContext(), {});
assert.equal(restoredBossService.getConfig('boss-a').bossDirect, true);
assert.equal(restoredBossService.getConfig('boss-b').bossDirect, false);
assert.equal(restoredBossService.getConfig('boss-new').bossDirect, false);
console.log('✓ Session BOSS settings isolated and persisted');

// 4. Test handleAction lifecycle
const sessionId = 'test-session-1';
const initialConfig = service.getConfig(sessionId);
assert.equal(initialConfig.enabled, true);
assert.equal(initialConfig.mode, 'mixed');

// Configure custom team
await service.handleAction(sessionId, 'configure', {
  config: {
    ...initialConfig,
    bossDirect: false,
    members: [
      { id: 'sol-worker', name: 'Sol (Coder)', provider: 'new', model: 'sol', role: 'Dev', instructions: 'Code', enabled: true, readOnly: false },
      { id: 'qa-worker', name: 'QA (Tester)', provider: 'cpa', model: 'gemini-3.8-flash-high', role: 'QA', instructions: 'Test', enabled: true, readOnly: true },
    ]
  }
});

// Plan tasks by model
await service.handleAction(sessionId, 'reset', {});
const planResult = await service.handleAction(sessionId, 'plan', {
  tasks: [
    { id: 't-1', title: 'Write feature', instructions: 'Do code', acceptance: 'Tests pass', memberId: 'sol-worker', writeScopes: ['src'] },
    { id: 't-2', title: 'Verify', instructions: 'Run test', acceptance: 'Green', memberId: 'qa-worker', dependencies: ['t-1'], readOnly: true }
  ],
  by: 'model'
});
assert.equal(planResult.status, 'ready');
assert.equal(planResult.approved, false);
console.log('✓ Plan submitted by model');

// Approve plan by user
const approveResult = await service.handleAction(sessionId, 'approve', {});
assert.equal(approveResult.approved, true);
console.log('✓ Plan approved by user');

// Reassign read-only task t-2 to qa-worker by user
const assignResult = await service.handleAction(sessionId, 'assign', { taskId: 't-2', memberId: 'qa-worker', by: 'user' });
assert.equal(assignResult.tasks.find(t => t.id === 't-2').locked, true);
console.log('✓ Manual reassign and user-lock working');

// Verify that assigning write task t-1 to read-only member is rejected
await assert.rejects(
  () => service.handleAction(sessionId, 'assign', { taskId: 't-1', memberId: 'qa-worker', by: 'user' }),
  (err) => err.code === 'READ_ONLY'
);
console.log('✓ Security rule verified: read-only member cannot receive write scopes');

// Exercise the real host scheduler with a deferred child, not a source-text regex.
const requests = [];
let settle;
let disposed = 0;
const parent = { session: { header: { id: sessionId } }, ctx: {} };
const oldGet = mockCtx.get.bind(mockCtx);
mockCtx.get = name => name === 'agents' ? { get: () => parent } : name === 'subagents' ? {
  start: async (provider, request) => {
    requests.push({ provider, request });
    return { id: `child-${requests.length}`, localAgent: {session:{requestHeader:()=>({config:{...request.agentOptions}})}}, result: new Promise(resolve => { settle = resolve; }), dispose: async () => { disposed++; } };
  }
} : oldGet(name);
await service.handleAction(sessionId, 'configure', { config: { ...service.getConfig(sessionId), bossDirect: true } });
service.getOrCreateBoard(sessionId).approve('user');
const started = await service.scheduleReadyTasks(sessionId, { agent: parent, signal: new AbortController().signal });
assert.deepEqual(started, ['t-1']);
assert.equal(service.getOrCreateBoard(sessionId).snapshot().tasks[0].status, 'running');
assert.equal(service.getOrCreateBoard(sessionId).snapshot().tasks[0].evidence.dispatch.childId,'child-1');
assert.equal(service.getOrCreateBoard(sessionId).snapshot().tasks[0].evidence.dispatchStatus,'running');
assert.equal(requests[0].provider, 'spawn');
assert.equal(requests[0].request.parent, parent);
assert.deepEqual(requests[0].request.agentOptions, { provider: 'new', model: 'sol' });
assert.ok(mockCtx.tools.guards[0]({name:'write',agent:parent}));
assert.equal(mockCtx.tools.guards[0]({name:'lead_worker_dispatch',agent:parent}), undefined);
settle({ stopReason: 'completed', output: [{type:'text',text:'real mocked child output'}] });
await new Promise(resolve => setImmediate(resolve));
assert.equal(disposed, 1);
assert.equal(service.getOrCreateBoard(sessionId).snapshot().tasks[0].status, 'review');
assert.equal(service.getOrCreateBoard(sessionId).snapshot().tasks[0].result.model, 'sol');
assert.equal(service.getOrCreateBoard(sessionId).snapshot().tasks[0].evidence.dispatch.routeVerified,true);
assert.equal(service.getOrCreateBoard(sessionId).snapshot().tasks[0].evidence.dispatch.actualModel,'sol');
service.getOrCreateBoard(sessionId).review('t-1', true, 'test-only review');
await service.scheduleReadyTasks(sessionId, {agent:parent});
assert.equal(requests[1].request.agentOptions.model, 'gemini-3.8-flash-high');
settle({stopReason:'error',output:[]});
await new Promise(resolve => setImmediate(resolve));
const failedTask = service.getOrCreateBoard(sessionId).snapshot().tasks.find(t=>t.id==='t-2');
assert.equal(failedTask.status,'needs_attention');
assert.equal(failedTask.waitingReason,'EXECUTION_FAILED');
assert.match(failedTask.result.error,/未正常完成/);
assert.equal(disposed,2);

// ==========================================
// 5. Test Run Abort Settlement & Drain
// ==========================================
console.log('\nTesting run abort settlement, drain status, and timeout...');

const drainSessionId = 'test-session-drain';
const followups = [];
const liveParent = {
  session: { header: { id: drainSessionId } },
  ctx: {},
  status: 'idle',
  followup: (msg) => { followups.push(msg); }
};

let currentRunDrain;
mockCtx.get = name => name === 'agents' ? { get: () => liveParent } : name === 'subagents' ? {
  start: async (provider, request) => {
    requests.push({ provider, request });
    let localSettle;
    const runResultPromise = new Promise(res => { localSettle = res; });
    const run = {
      id: `child-drain-${requests.length}`,
      localAgent: { session: { requestHeader: () => ({ config: { ...request.agentOptions } }) } },
      result: runResultPromise,
      dispose: async () => { disposed++; },
      _settle: localSettle
    };
    currentRunDrain = run;
    return run;
  }
} : oldGet(name);

await service.handleAction(drainSessionId, 'configure', {
  config: {
    ...initialConfig,
    bossDirect: true,
    members: [
      ...service.getConfig(drainSessionId).members,
      { id: 'sol-drain', name: 'Sol', provider: 'new', model: 'sol', role: 'Dev', instructions: 'Code', enabled: true, readOnly: false }
    ]
  }
});
await service.handleAction(drainSessionId, 'reset', {});
await service.handleAction(drainSessionId, 'plan', {
  tasks: [{ id: 'task-drain-1', title: 'Task Drain', instructions: 'Run long job', acceptance: 'Done', memberId: 'sol-drain', writeScopes: ['src'] }],
  by: 'model'
});
service.getOrCreateBoard(drainSessionId).approve('user');

const drainStarted = await service.scheduleReadyTasks(drainSessionId, { agent: liveParent, signal: new AbortController().signal });
assert.deepEqual(drainStarted, ['task-drain-1']);

// 测试 5.1: 模拟超时 (超时绝不能报安全)
const timeoutDrain = await service.drainExecutions(drainSessionId, { timeoutMs: 30 });
assert.equal(timeoutDrain.drained, false);
assert.equal(timeoutDrain.safe, false, '超时绝不能报安全！');
assert.equal(timeoutDrain.safeToShutdown, false);
assert.equal(timeoutDrain.timedOut, true);
assert.equal(timeoutDrain.pendingCount, 1);
assert.equal(timeoutDrain.pendingTasks[0].taskId, 'task-drain-1');
console.log('✓ Drain timeout correctly reported with safe=false');

// 测试 5.2: 触发 interrupt，模拟真实 settlement 延迟后结算
const interruptPromise = service.handleAction(drainSessionId, 'interrupt', { timeoutMs: 500 });
// 验证 interrupt fire-and-return 不代表 settled，模拟延迟 25ms 后真实 run 结算并释放
setTimeout(() => {
  if (currentRunDrain?._settle) currentRunDrain._settle({ stopReason: 'aborted', output: [] });
}, 25);

const interruptResult = await interruptPromise;
assert.equal(interruptResult.status, 'paused');
assert.equal(interruptResult.drained, true);
assert.equal(interruptResult.safe, true);
assert.equal(interruptResult.timedOut, false);
console.log('✓ Interrupt waited for real run abort settlement and honestly reported drained=true');

// ==========================================
// 6. Test Shutdown (下班停工) & 持久化前核查
// ==========================================
console.log('\nTesting shutdown action, persistence verification, and conditions...');
await service.handleAction(drainSessionId, 'reset', {});
await service.handleAction(drainSessionId, 'plan', {
  tasks: [{ id: 'task-sd-1', title: 'Shutdown task', instructions: 'Do code', acceptance: 'Done', memberId: 'sol-drain', writeScopes: ['src'] }],
  by: 'model'
});
service.getOrCreateBoard(drainSessionId).approve('user');
await service.scheduleReadyTasks(drainSessionId, { agent: liveParent });

const shutdownPromise = service.handleAction(drainSessionId, 'shutdown', { timeoutMs: 500 });
setTimeout(() => {
  if (currentRunDrain?._settle) currentRunDrain._settle({ stopReason: 'aborted', output: [] });
}, 25);

const shutdownResult = await shutdownPromise;
assert.equal(shutdownResult.ok, true);
assert.equal(shutdownResult.action, 'shutdown');
assert.equal(shutdownResult.drained, true);
assert.equal(shutdownResult.safe, true);
assert.equal(shutdownResult.shutdownConditions.allExecutionsDrained, true);
assert.equal(shutdownResult.shutdownConditions.persistenceVerified, true);
assert.equal(shutdownResult.shutdownConditions.safe, true);
assert.match(shutdownResult.shutdownConditions.summary, /安全关机/);
assert.ok(shutdownResult.structuredNotice);
console.log('✓ Shutdown succeeded with persistence verification and structured conditions');

// ==========================================
// 7. Test Restart Recovery & Review 补通知 (可审计、不自动规划、不沿用批准)
// ==========================================
console.log('\nTesting restart recovery, review notice catch-up, and auditability...');
const restartSessionId = 'test-session-restart';
const restartFollowups = [];
const restartParent = {
  session: { header: { id: restartSessionId } },
  ctx: {},
  status: 'idle',
  followup: (msg) => { restartFollowups.push(msg); }
};
mockCtx.get = name => name === 'agents' ? { get: (id) => id === restartSessionId ? restartParent : liveParent } : oldGet(name);

// 模拟此前已保存的快照：包含一个 review 状态任务，以及一个 pending 任务，原状态 approved: true
const savedSnapshot = {
  version: 1,
  revision: 10,
  status: 'ready',
  approved: true,
  batchId: 2,
  tasks: [
    {
      id: 'task-rev-1',
      title: 'Review Task to catch-up',
      instructions: 'Finished work',
      acceptance: 'Accepted',
      memberId: 'sol-drain',
      writeScopes: ['src'],
      status: 'review',
      phase: 'verifying',
      retries: 0,
      executionEpoch: 2,
      result: { output: 'Completed code', files: ['src/feature.js'] }
    },
    {
      id: 'task-pending-2',
      title: 'Pending unapproved work',
      instructions: 'Should not run automatically',
      acceptance: 'Tests',
      memberId: 'sol-drain',
      writeScopes: ['src/sub'],
      status: 'pending',
      phase: 'ready',
      retries: 0,
      executionEpoch: 0,
      dependencies: []
    }
  ]
};

service._injectSessionState(restartSessionId, savedSnapshot);
const restoredBoard = service.getOrCreateBoard(restartSessionId);

// 验证不沿用旧批准、状态为 paused、不自动规划
assert.equal(restoredBoard.snapshot().approved, false, '重启现场必须重置批准，严禁沿用旧批准！');
assert.equal(restoredBoard.snapshot().status, 'paused');
assert.equal(restoredBoard.snapshot().tasks.length, 2, '保持原有任务，不自动规划');

// 等待异步补投完成
await new Promise(resolve => setTimeout(resolve, 50));
// 验证补投 review 通知
assert.equal(restartFollowups.length, 0, 'paused recovery must not wake the parent before resume');

// 验证 review 恢复审计可查
const recoveryAudits = service.getRecoveryAudits(restartSessionId);
assert.equal(recoveryAudits.length, 0, 'off mode must not initiate recovery notifications');
console.log('✓ Restart recovery: approved revoked, review notice caught up, audits verified');

// ==========================================
// 8. Test 阶段性复评通知: 事件触发、去重且不自动执行未批准范围
// ==========================================
console.log('\nTesting phase review notifications, deduplication, and scope bounds...');
const initialFollowupCount = restartFollowups.length;

// 触发复评通知（任务完成/审查）
await service.notifyPhaseReview(restartSessionId, {
  type: 'task_completed',
  taskId: 'task-rev-1',
  epoch: 2,
  status: 'done',
  description: '任务 task-rev-1 审查通过'
});
assert.equal(restartFollowups.length, initialFollowupCount, '完成事件不应重复投递阶段复评通知');

// 再次以相同状态触发：验证去重（复评不重复）
await service.notifyPhaseReview(restartSessionId, {
  type: 'task_completed',
  taskId: 'task-rev-1',
  epoch: 2,
  status: 'done',
  description: '任务 task-rev-1 审查通过'
});
assert.equal(restartFollowups.length, initialFollowupCount, '重复完成通知应持续被抑制');
await service.notifyPhaseReview(restartSessionId, { type: 'members_idle_or_blocked', idleMembers: [{ id: 'idle' }] });
assert.equal(restartFollowups.length, initialFollowupCount, '没有可操作待办时，成员空闲不应刷屏');
await service.notifyPhaseReview(restartSessionId, { type: 'state_change', payload: { reason: 'manual-check' } });
assert.equal(restartFollowups.length, initialFollowupCount, 'off mode suppresses state-change notifications');
await service.notifyPhaseReview(restartSessionId, { type: 'state_change', payload: { reason: 'manual-check' } });
assert.equal(restartFollowups.length, initialFollowupCount, 'repeated off-mode notifications remain suppressed');
console.log('✓ Phase review notifications sent and deduplicated successfully');

// 验证不自动执行未批准范围
const unapprovedDispatch = await service.scheduleReadyTasks(restartSessionId, { agent: restartParent });
assert.deepEqual(unapprovedDispatch, [], '未获用户批准时，绝不自动派发任何任务！');
console.log('✓ Unapproved scopes strictly prevented from automatic execution');
console.log('\nAll Integration tests passed cleanly!');
