import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 1. 宿主测试环境隔离：指向独立临时目录，并在清理前不污染真实 APPDATA
const originalAppData = process.env.APPDATA;
const isolatedTempDir = mkdtempSync(join(tmpdir(), 'dsh-lead-worker-fusion-'));
process.env.APPDATA = isolatedTempDir;

// 动态导入，确保 host.mjs 读取的是隔离后的 APPDATA
const { TeamBoard, BoardError } = await import('../src/core.mjs');
const { evaluateQualityGate } = await import('../src/quality-gates.mjs');
const { normalizeContractTask, normalizeStructuredReport, reportToEvidence } = await import('../src/contracts.mjs');
const { createLeadWorkerTools } = await import('../src/tools.mjs');
const { LeadWorkerHostService } = await import('../src/host.mjs');

describe('Fusion Integration: Unified Orchestration, Contracts & Quality Gates', () => {
  after(() => {
    // 恢复环境变量并清理临时目录
    if (originalAppData !== undefined) {
      process.env.APPDATA = originalAppData;
    } else {
      delete process.env.APPDATA;
    }
    try {
      if (existsSync(isolatedTempDir)) {
        rmSync(isolatedTempDir, { recursive: true, force: true });
      }
    } catch {
      // 忽略临时文件释放延迟
    }
  });

  const testConfig = {
    enabled: true,
    mode: 'mixed',
    members: [
      { id: 'worker-a', name: 'Worker A', provider: 'deepseek-official', model: 'deepseek-v4-pro', role: 'Feature A', instructions: 'Coding A', enabled: true, readOnly: false },
      { id: 'worker-b', name: 'Worker B', provider: 'deepseek-official', model: 'deepseek-v4-pro', role: 'Feature B', instructions: 'Coding B', enabled: true, readOnly: false },
      { id: 'worker-qa', name: 'QA Tester', provider: 'deepseek-official', model: 'deepseek-flash', role: 'Testing', instructions: 'Testing', enabled: true, readOnly: true },
    ],
    maxParallel: 2,
    maxRetries: 2,
    confirmPlan: true,
    askApprovalPrompt: true
  };

  it('1. 完整闭环：规划(plan) -> 批准(approve) -> 并行(dispatch) -> 汇报(finish) -> 门控(gate) -> 审查(review)', async () => {
    const board = new TeamBoard(testConfig);

    // 1.1 规划阶段：可选接收契约扩展（taskType/deliverables/writeScopes）
    const tasks = [
      {
        id: 'task-a',
        title: '模块 A 实现',
        instructions: '编写 src/a.js',
        acceptance: '实现模块 A 功能并通过测试',
        memberId: 'worker-a',
        writeScopes: ['src/a.js'],
        taskType: 'code',
        deliverables: [{ path: 'src/a.js', type: 'code', required: true }]
      },
      {
        id: 'task-b',
        title: '模块 B 实现',
        instructions: '编写 src/b.js',
        acceptance: '实现模块 B 功能并通过测试',
        memberId: 'worker-b',
        writeScopes: ['src/b.js'],
        taskType: 'code',
        deliverables: [{ path: 'src/b.js', type: 'code', required: true }]
      },
      {
        id: 'task-c',
        title: '集成测试验证',
        instructions: '运行集成测试',
        acceptance: '所有集成测试通过',
        memberId: 'worker-qa',
        dependencies: ['task-a', 'task-b'],
        readOnly: true,
        taskType: 'test',
        deliverables: [{ path: 'test/c.test.js', type: 'test', required: true }]
      }
    ];

    const planSnapshot = board.plan(tasks, 'model');
    assert.equal(planSnapshot.status, 'ready');
    assert.equal(planSnapshot.approved, false);
    assert.equal(planSnapshot.tasks.length, 3);

    // 契约字段推导与存储核验
    const snapA = planSnapshot.tasks.find(t => t.id === 'task-a');
    const snapB = planSnapshot.tasks.find(t => t.id === 'task-b');
    const snapC = planSnapshot.tasks.find(t => t.id === 'task-c');
    assert.equal(snapA.taskType, 'code');
    assert.equal(snapA.phase, 'ready');
    assert.equal(snapC.taskType, 'test');
    assert.equal(snapC.readOnly, true);

    // 1.2 批准门禁：未批准不可启动
    assert.throws(() => board.start('task-a'), error => error.code === 'APPROVAL_REQUIRED');

    // 用户批准计划
    const approvedSnapshot = board.approve('user');
    assert.equal(approvedSnapshot.approved, true);

    // 1.3 并行调度：独立范围可并行启动，依赖未满足受阻
    // task-c 依赖 task-a 和 task-b，不可提前启动
    assert.throws(() => board.start('task-c'), error => error.code === 'DEPENDENCY_NOT_DONE');

    // 启动 task-a 与 task-b（互斥 writeScopes 并行）
    board.start('task-a');
    board.start('task-b');
    const runningSnapshot = board.snapshot();
    assert.equal(runningSnapshot.tasks.find(t => t.id === 'task-a').status, 'running');
    assert.equal(runningSnapshot.tasks.find(t => t.id === 'task-a').phase, 'running');
    assert.equal(runningSnapshot.tasks.find(t => t.id === 'task-b').status, 'running');
    assert.equal(runningSnapshot.tasks.find(t => t.id === 'task-b').phase, 'running');

    // 1.4 结构化汇报与执行结束：子模型完成并附带结构化回执
    const reportA = {
      summary: '模块 A 实现完毕，测试通过',
      completed: ['实现了核心逻辑'],
      unfinished: [],
      modifiedFiles: ['src/a.js'],
      testResults: [{ command: 'node test/a.test.js', passed: true, exitCode: 0, output: '1 test passed' }],
      risks: [],
      deliverables: [{ path: 'src/a.js', verified: true, note: 'ok' }]
    };
    const evidenceA = reportToEvidence(reportA);

    board.finish('task-a', {
      output: '模块 A 完成',
      files: ['src/a.js'],
      evidence: evidenceA
    });

    const finishSnapshot = board.snapshot();
    const finishedTaskA = finishSnapshot.tasks.find(t => t.id === 'task-a');
    assert.equal(finishedTaskA.status, 'review');
    assert.equal(finishedTaskA.phase, 'verifying');
    assert.deepEqual(finishedTaskA.evidence.files, ['src/a.js']);

    // 1.5 质量门控安全验证：
    // 自报测试 exitCode:0 判定为 unknown，不自动通过；canAutoAccept 恒为 false
    const gateEvalA = evaluateQualityGate(finishedTaskA, {
      ...finishedTaskA.result,
      ...finishedTaskA.evidence,
      touchedFiles: finishedTaskA.evidence.files,
      modifiedFiles: finishedTaskA.evidence.files,
      testRuns: finishedTaskA.evidence.tests,
      executionEpoch: finishedTaskA.executionEpoch,
      deliverables: finishedTaskA.deliverables
    }, {});

    assert.equal(gateEvalA.verdict, 'unknown', '自报 exitCode:0 默认必须判定为 unknown，隔离自报风险');
    assert.equal(gateEvalA.canAutoAccept, false, 'canAutoAccept 恒为 false，绝不可自动放行');
    assert.ok(gateEvalA.summary.includes('验收把关报告'));

    // 1.6 主控审查：主控依据质量门摘要人工裁决通过
    const reviewFeedback = `${gateEvalA.summary}\n\n主控核验无误，予以验收。`;
    const reviewSnapshot = board.review('task-a', true, reviewFeedback);
    const reviewedTaskA = reviewSnapshot.tasks.find(t => t.id === 'task-a');
    assert.equal(reviewedTaskA.status, 'done');
    assert.equal(reviewedTaskA.phase, 'completed');
    assert.equal(reviewedTaskA.reviewHistory.length, 1);
    assert.equal(reviewedTaskA.reviewHistory[0].passed, true);

    // task-b 仍在 running，验证单任务进度独立，不回退也不影响 task-b
    assert.equal(board.snapshot().tasks.find(t => t.id === 'task-b').status, 'running');
  });

  it('2. 质量门反例核查：越界写失败、测试非零退出失败、缺失证据为 unknown', () => {
    // 2.1 范围越界反例
    const contractScope = { id: 't-scope', writeScopes: ['src/safe.js'], instructions: 'write safe' };
    const submissionOutOfScope = { touchedFiles: ['src/safe.js', 'src/evil.js'], executionEpoch: 0 };
    const gateScope = evaluateQualityGate(contractScope, submissionOutOfScope, {});
    assert.equal(gateScope.verdict, 'failed', '修改范围超出 writeScopes 必须判定为 failed');

    // 2.2 测试确凿失败反例
    const contractTest = { id: 't-test', writeScopes: ['src/app.js'], instructions: 'run tests', deliverables: [{ path: 'src/app.js', type: 'code' }] };
    const submissionTestFail = {
      modifiedFiles: ['src/app.js'],
      testRuns: [{ command: 'npm test', exitCode: 1, output: 'failed' }],
      executionEpoch: 0
    };
    const gateTestFail = evaluateQualityGate(contractTest, submissionTestFail, {});
    assert.equal(gateTestFail.verdict, 'failed', '测试退出码非零必须判定为 failed');

    // 2.3 缺证据反例
    const contractMissing = { id: 't-missing', instructions: 'investigate issue', readOnly: true };
    const submissionEmpty = {};
    const gateMissing = evaluateQualityGate(contractMissing, submissionEmpty, {});
    assert.equal(gateMissing.verdict, 'unknown', '空提交缺证据必须判定为 unknown，不自动通过');
  });

  it('3. 旧数据恢复兼容性：旧任务缺省推导、历史保留且不损坏', () => {
    const legacyState = {
      version: 1,
      revision: 4,
      status: 'ready',
      approved: true,
      tasks: [
        {
          id: 'legacy-1',
          title: 'Legacy Task ReadOnly',
          instructions: 'Analyze something',
          acceptance: 'Report ready',
          memberId: 'worker-qa',
          locked: false,
          dependencies: [],
          writeScopes: [],
          readOnly: true,
          status: 'done',
          retries: 0,
          result: { output: 'legacy done' },
          feedback: 'ok',
          reviewHistory: [{ attempt: 1, passed: true, feedback: 'ok' }],
          waitingReason: '',
          executionEpoch: 1,
          checkpoint: null,
          executionHistory: [{ epoch: 1, status: 'done' }]
        },
        {
          id: 'legacy-2',
          title: 'Legacy Task Writable',
          instructions: 'Write code',
          acceptance: 'Code written',
          memberId: 'worker-a',
          locked: false,
          dependencies: [],
          writeScopes: ['src/legacy.js'],
          readOnly: false,
          status: 'pending',
          retries: 1,
          result: null,
          feedback: 'retry please',
          reviewHistory: [{ attempt: 1, passed: false, feedback: 'retry please' }],
          waitingReason: '',
          executionEpoch: 1,
          checkpoint: null,
          executionHistory: []
        }
      ]
    };

    // 恢复旧快照
    const board = new TeamBoard(testConfig, legacyState);
    const snap = board.snapshot();

    // 验证旧任务已恢复且字段平滑补齐
    assert.equal(snap.tasks.length, 2);
    const t1 = snap.tasks.find(t => t.id === 'legacy-1');
    assert.equal(t1.taskType, 'analysis', 'readOnly 旧任务自动推导为 analysis');
    assert.equal(t1.phase, 'completed', 'status done 对应 phase completed');
    assert.equal(t1.reviewHistory.length, 1);
    assert.equal(t1.executionEpoch, 1);

    const t2 = snap.tasks.find(t => t.id === 'legacy-2');
    assert.equal(t2.taskType, 'code', '可写旧任务自动推导为 code');
    assert.equal(t2.phase, 'ready', 'status pending 对应 phase ready');
    assert.equal(t2.retries, 1, '历史重试次数完整保留');
  });

  it('4. LeadWorkerHostService 工具接入与模型路由不变验证', async () => {
    class MockCordisContext {
      logger = { info: () => {}, warn: () => {}, error: () => {} };
      tools = { registered: [], register: (tool) => { this.tools.registered.push(tool); } };
      systemPrompt = { sections: [], section: (sec) => { this.systemPrompt.sections.push(sec); } };
      webServer = { routes: [], register: (route) => { this.webServer.routes.push(route); } };
      llm = {
        listModels: async (providerId) => this.llm.listProviders().find(p => p.id === providerId)?.models || [],
        listProviders: () => [
          { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro', name: 'V4 Pro' }, { id: 'deepseek-flash', name: 'Flash' }] }
        ]
      };
      userQuestions = { ask: async () => ({ answers: [] }) };
      reflect = { provide: () => {} };
      inject(keys, fn) { fn(this); }
      get(name) { return this[name]; }
    }

    const ctx = new MockCordisContext();
    const service = new LeadWorkerHostService(ctx, {});

    // 验证工具注册完整且包含质量门与契约能力
    const registeredToolNames = ctx.tools.registered.map(t => t.name);
    assert.ok(registeredToolNames.includes('lead_worker_status'));
    assert.ok(registeredToolNames.includes('lead_worker_plan'));
    assert.ok(registeredToolNames.includes('lead_worker_approve'));
    assert.ok(registeredToolNames.includes('lead_worker_dispatch'));
    assert.ok(registeredToolNames.includes('lead_worker_review'));
    assert.ok(registeredToolNames.includes('lead_worker_list_members'));
    assert.ok(registeredToolNames.includes('lead_worker_recovery'));

    // 验证模型路由保持不变，无任何未授权模型替换
    const models = await service.listAvailableModels();
    assert.ok(models.some(m => m.provider === 'deepseek-official' && m.model === 'deepseek-v4-pro'));
    assert.ok(models.some(m => m.provider === 'deepseek-official' && m.model === 'deepseek-flash'));
  });
});
