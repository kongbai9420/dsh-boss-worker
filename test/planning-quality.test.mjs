import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TeamBoard, BoardError } from '../src/core.mjs';
import { checkPlanningQuality } from '../src/quality-gates.mjs';

const baseConfig = {
  enabled: true,
  mode: 'mixed',
  members: [
    { id: 'lead', name: 'Astra (Lead)', provider: 'p', model: 'm', role: 'Lead', instructions: 'Lead', enabled: true, readOnly: true },
    { id: 'worker1', name: 'Sol (Worker 1)', provider: 'p', model: 'm', role: 'Worker', instructions: 'Code', enabled: true, readOnly: false },
    { id: 'worker2', name: 'Luna (Worker 2)', provider: 'p', model: 'm', role: 'Worker', instructions: 'Test', enabled: true, readOnly: false },
    { id: 'worker3', name: 'Idle Worker', provider: 'p', model: 'm', role: 'Worker', instructions: 'Spare', enabled: true, readOnly: false },
  ],
  maxParallel: 2,
  maxRetries: 2,
  confirmPlan: true,
};

describe('规划质量门禁与结构化规划 (Planning Quality Gates)', () => {

  describe('1. checkPlanningQuality 纯函数门禁校验', () => {
    it('拒绝空任务列表，返回结构化错误与可修复建议 (remedy)', () => {
      const res = checkPlanningQuality({ tasks: [] });
      assert.equal(res.passed, false);
      assert.equal(res.code, 'EMPTY_PLAN_TASKS');
      assert.ok(res.remedy);
    });

    it('并行理由门禁：存在可并行任务但缺失 parallelizationJustification 时判定未通过', () => {
      const plan = {
        tasks: [
          { id: 't1', title: 'Task 1', instructions: 'Do 1', acceptance: 'Pass', writeScopes: ['src/a.js'] },
          { id: 't2', title: 'Task 2', instructions: 'Do 2', acceptance: 'Pass', writeScopes: ['src/b.js'] },
        ],
        planningRationale: '总体规划说明',
        // 故意缺少 parallelizationJustification
      };
      const res = checkPlanningQuality(plan);
      assert.equal(res.passed, false);
      assert.equal(res.code, 'MISSING_PARALLELIZATION_JUSTIFICATION');
      assert.ok(res.remedy.includes('parallelizationJustification'));
      assert.ok(res.findings.some(f => f.code === 'MISSING_PARALLELIZATION_JUSTIFICATION'));
    });

    it('并行理由门禁：提供有效 parallelizationJustification 后顺利通过', () => {
      const plan = {
        tasks: [
          { id: 't1', title: 'Task 1', instructions: 'Do 1', acceptance: 'Pass', writeScopes: ['src/a.js'] },
          { id: 't2', title: 'Task 2', instructions: 'Do 2', acceptance: 'Pass', writeScopes: ['src/b.js'] },
        ],
        planningRationale: '拆分为两项独立模块并行开发',
        parallelizationJustification: 't1 写入 src/a.js，t2 写入 src/b.js，文件范围严格无交集，可安全并行调度',
      };
      const res = checkPlanningQuality(plan);
      assert.equal(res.passed, true);
      assert.equal(res.findings.filter(f => f.level === 'error').length, 0);
    });

    it('不要机械要求任务数等于成员数：存在空闲成员时不应判定失败', () => {
      const plan = {
        tasks: [
          { id: 't1', title: 'Single Task', instructions: 'Only one task', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/a.js'] }
        ],
        planningRationale: '单点需求无需调动全员',
        idleMembersJustification: '当前仅需修改单个文件，worker2 与 worker3 保留空闲避免资源浪费',
      };
      const res = checkPlanningQuality(plan, { members: baseConfig.members });
      // 尽管任务数 (1) < 成员数 (4)，门禁依然通过
      assert.equal(res.passed, true);
      const idleFinding = res.findings.find(f => f.code === 'IDLE_MEMBERS_DETECTED');
      assert.ok(idleFinding);
      assert.equal(idleFinding.level, 'info');
    });
  });

  describe('2. TeamBoard.plan 状态机原子性与门禁集成', () => {
    it('无效计划不改状态：门禁被拒时完全不修改任务板状态与 revision', () => {
      const board = new TeamBoard(baseConfig);
      // 先规划一个合法的单任务计划
      board.plan([{ id: 'init', title: 'Init', instructions: 'init', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['init.js'] }]);
      board.approve('user');
      const snapBefore = board.snapshot();

      // 尝试提交一个包含并行但缺少 parallelizationJustification 的无效结构化规划
      assert.throws(
        () => {
          board.plan({
            tasks: [
              { id: 'p1', title: 'P1', instructions: 'p1', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/p1.js'] },
              { id: 'p2', title: 'P2', instructions: 'p2', acceptance: 'Pass', memberId: 'worker2', writeScopes: ['src/p2.js'] },
            ],
            planningRationale: '计划理由',
            // 缺失 parallelizationJustification
          });
        },
        (err) => {
          assert.equal(err.code, 'MISSING_PARALLELIZATION_JUSTIFICATION');
          assert.ok(err.remedy);
          return true;
        }
      );

      // 验证任务板状态绝对未变：revision、tasks、approved、status 均未动
      const snapAfter = board.snapshot();
      assert.deepEqual(snapAfter, snapBefore);
      assert.equal(snapAfter.revision, snapBefore.revision);
      assert.equal(snapAfter.approved, true);
    });

    it('合法结构化规划正常落库，并保存 planning 结构化元数据', () => {
      const board = new TeamBoard(baseConfig);
      const plan = {
        tasks: [
          { id: 'p1', title: 'P1', instructions: 'p1', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/p1.js'] },
          { id: 'p2', title: 'P2', instructions: 'p2', acceptance: 'Pass', memberId: 'worker2', writeScopes: ['src/p2.js'] },
        ],
        planningRationale: '解耦业务逻辑',
        parallelizationJustification: '写范围完全隔离，支持并行',
        idleMembersJustification: 'worker3 作为备用空闲',
      };
      const snap = board.plan(plan);
      assert.equal(snap.status, 'ready');
      assert.equal(snap.approved, false); // 新计划待批准
      assert.ok(snap.planning);
      assert.equal(snap.planning.planningRationale, '解耦业务逻辑');
      assert.equal(snap.planning.parallelizationJustification, '写范围完全隔离，支持并行');
    });

    it('追加任务撤销批准：用户批准后追加任务必须撤销批准 (approved -> false)', () => {
      const board = new TeamBoard(baseConfig);
      board.plan([{ id: 't1', title: 'T1', instructions: 't1', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/t1.js'] }]);
      board.approve('user');
      assert.equal(board.snapshot().approved, true);

      // 追加新任务
      board.appendTasks([{ id: 't2', title: 'T2', instructions: 't2', acceptance: 'Pass', memberId: 'worker2', writeScopes: ['src/t2.js'] }]);
      const snapAfterAppend = board.snapshot();
      assert.equal(snapAfterAppend.tasks.length, 2);
      assert.equal(snapAfterAppend.approved, false); // 批准已撤销！

      // 未获批准前无法启动新追加的任务
      assert.throws(() => board.start('t2'), (err) => err.code === 'APPROVAL_REQUIRED');

      // 重新批准后可正常启动
      board.approve('user');
      assert.equal(board.snapshot().approved, true);
      board.start('t1');
      assert.equal(board.snapshot().tasks[0].status, 'running');
    });

    it('修改已有任务范围或依赖变化撤销批准', () => {
      const board = new TeamBoard(baseConfig);
      board.plan([
        { id: 't1', title: 'T1', instructions: 't1', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/t1.js'] },
        { id: 't2', title: 'T2', instructions: 't2', acceptance: 'Pass', memberId: 'worker2', writeScopes: ['src/t2.js'] },
      ]);
      board.approve('user');
      assert.equal(board.snapshot().approved, true);

      // 重新 plan 修改 t2 的 writeScopes
      board.plan([
        { id: 't1', title: 'T1', instructions: 't1', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/t1.js'] },
        { id: 't2', title: 'T2', instructions: 't2', acceptance: 'Pass', memberId: 'worker2', writeScopes: ['src/t2-modified.js'] },
      ]);
      assert.equal(board.snapshot().approved, false); // 范围变化撤销批准
    });

    it('活跃任务保护：仍有 running / review / needs_attention 的原任务禁止覆盖，保留历史', () => {
      const board = new TeamBoard(baseConfig);
      board.plan([
        { id: 't-run', title: 'Running Task', instructions: 'Inst 1', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/run.js'] },
        { id: 't-wait', title: 'Waiting Task', instructions: 'Inst 2', acceptance: 'Pass', memberId: 'worker2', writeScopes: ['src/wait.js'] },
      ]);
      board.approve('user');
      board.start('t-run');
      assert.equal(board.snapshot().tasks[0].status, 'running');

      // 试图篡改正在 running 任务的 writeScopes 或 instructions 必须被拒绝
      assert.throws(
        () => {
          board.plan([
            { id: 't-run', title: 'Tampered Running', instructions: 'Changed!', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/run.js'] },
            { id: 't-wait', title: 'Waiting Task', instructions: 'Inst 2', acceptance: 'Pass', memberId: 'worker2', writeScopes: ['src/wait.js'] },
          ]);
        },
        (err) => err.code === 'CANNOT_OVERWRITE_ACTIVE_TASK'
      );

      // 试图丢弃正在 running 任务也必须被拒绝
      assert.throws(
        () => {
          board.plan([
            { id: 't-wait', title: 'Waiting Task', instructions: 'Inst 2', acceptance: 'Pass', memberId: 'worker2', writeScopes: ['src/wait.js'] },
          ]);
        },
        (err) => err.code === 'CANNOT_OVERWRITE_ACTIVE_TASK'
      );

      // 保持运行中的任务完好无损，仅更新 pending 任务是允许的，且运行中任务的历史被保留
      const snap = board.plan([
        { id: 't-run', title: 'Running Task', instructions: 'Inst 1', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/run.js'] },
        { id: 't-wait', title: 'Updated Waiting', instructions: 'New instructions', acceptance: 'Pass', memberId: 'worker2', writeScopes: ['src/wait.js'] },
        { id: 't-new', title: 'Appended Task', instructions: 'Do new', acceptance: 'Pass', memberId: 'worker3', writeScopes: ['src/new.js'] },
      ]);
      assert.equal(snap.tasks.find(t => t.id === 't-run').status, 'running');
      assert.equal(snap.tasks.find(t => t.id === 't-wait').title, 'Updated Waiting');
      assert.equal(snap.tasks.find(t => t.id === 't-new').status, 'pending');
      assert.equal(snap.approved, false); // 变更后撤销批准
    });

    it('追加任务支持结构化规划质量门禁与撤销批准', () => {
      const board = new TeamBoard(baseConfig);
      board.plan([{ id: 't1', title: 'T1', instructions: 't1', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/t1.js'] }]);
      board.approve('user');
      assert.equal(board.snapshot().approved, true);

      // 追加任务形成并行，但未提供 parallelizationJustification 时，必须被门禁拦截
      assert.throws(
        () => {
          board.appendTasks({
            tasks: [{ id: 't2', title: 'T2', instructions: 't2', acceptance: 'Pass', memberId: 'worker2', writeScopes: ['src/t2.js'] }],
            planningRationale: '追加需求',
            // 缺少 parallelizationJustification
          });
        },
        (err) => err.code === 'MISSING_PARALLELIZATION_JUSTIFICATION'
      );
      // 被拒后状态未改变，批准未撤销
      assert.equal(board.snapshot().approved, true);
      assert.equal(board.snapshot().tasks.length, 1);

      // 提供合法的结构化追加，成功执行并撤销批准
      board.appendTasks({
        tasks: [{ id: 't2', title: 'T2', instructions: 't2', acceptance: 'Pass', memberId: 'worker2', writeScopes: ['src/t2.js'] }],
        planningRationale: '追加需求',
        parallelizationJustification: 't1 与 t2 写范围不重叠，支持并行',
      });
      const snapAfterAppend = board.snapshot();
      assert.equal(snapAfterAppend.tasks.length, 2);
      assert.equal(snapAfterAppend.approved, false);
      assert.ok(snapAfterAppend.planning);
      assert.equal(snapAfterAppend.planning.parallelizationJustification, 't1 与 t2 写范围不重叠，支持并行');
    });

    it('appendTasks 阻止覆盖 running/review/needs_attention 活跃任务', () => {
      const board = new TeamBoard(baseConfig);
      board.plan([
        { id: 't-run', title: 'Running', instructions: 'Run', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/run.js'] },
        { id: 't-rev', title: 'Review', instructions: 'Rev', acceptance: 'Pass', memberId: 'worker2', writeScopes: ['src/rev.js'] },
      ]);
      board.approve('user');
      board.start('t-run');
      board.start('t-rev');
      board.finish('t-rev', { output: 'ready for audit' }, undefined, board.snapshot().tasks.find(t => t.id === 't-rev').executionEpoch);

      // 试图通过 appendTasks 注入同名活跃任务 ID
      assert.throws(
        () => {
          board.appendTasks([{ id: 't-run', title: 'Overwritten', instructions: 'Hacked', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/run.js'] }]);
        },
        (err) => err.code === 'DUPLICATE_TASK_ID' || err.code === 'CANNOT_OVERWRITE_ACTIVE_TASK'
      );

      assert.throws(
        () => {
          board.appendTasks([{ id: 't-rev', title: 'Overwritten', instructions: 'Hacked', acceptance: 'Pass', memberId: 'worker2', writeScopes: ['src/rev.js'] }]);
        },
        (err) => err.code === 'DUPLICATE_TASK_ID' || err.code === 'CANNOT_OVERWRITE_ACTIVE_TASK'
      );
    });

    it('兼容旧数组规划：普通数组规划保留已有 planning 元数据', () => {
      const board = new TeamBoard(baseConfig);
      board.plan({
        tasks: [{ id: 't1', title: 'T1', instructions: 't1', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/t1.js'] }],
        planningRationale: '初始结构化说明',
      });
      assert.equal(board.snapshot().planning.planningRationale, '初始结构化说明');

      // 使用旧数组形式重新 plan，已有 planning 元数据不被清空为 null
      board.plan([{ id: 't1', title: 'T1 Updated', instructions: 't1', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['src/t1.js'] }]);
      assert.equal(board.snapshot().planning.planningRationale, '初始结构化说明');
    });

    it('兼容旧快照恢复：旧快照没有 planning 字段时正常恢复为 null', () => {
      const oldSnapshot = {
        version: 1,
        revision: 3,
        status: 'ready',
        approved: true,
        tasks: [
          { id: 'legacy-t', title: 'Legacy', instructions: 'Old task', acceptance: 'Pass', memberId: 'worker1', writeScopes: ['old.js'], status: 'pending', retries: 0, dependencies: [] }
        ],
        archivedTasks: [],
        batchId: 1
      };
      const restored = new TeamBoard(baseConfig, oldSnapshot);
      const snap = restored.snapshot();
      assert.equal(snap.planning, null);
      assert.equal(snap.status, 'ready');
      assert.equal(snap.approved, true);
    });
  });

});
