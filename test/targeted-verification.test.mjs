import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const { TeamBoard } = await import('../src/core.mjs');

const clientPath = new URL('../client.js', import.meta.url);
const clientSource = readFileSync(clientPath, 'utf8');

const sampleConfig = {
  enabled: true,
  mode: 'mixed',
  maxParallel: 2,
  maxRetries: 2,
  confirmPlan: true,
  members: [
    { id: 'dev-1', name: 'Dev 1', provider: 'p1', model: 'm1', role: 'Dev', instructions: 'Inst 1', enabled: true, readOnly: false },
    { id: 'qa-1', name: 'QA 1', provider: 'p1', model: 'm1', role: 'QA', instructions: 'Inst 2', enabled: true, readOnly: true },
  ]
};

describe('针对性验证套件 (Targeted Verification Suite)', () => {

  describe('1. 跨模块状态契约 (Cross-module State Contract)', () => {
    it('任务板保存并恢复结构化契约字段 (taskType, deliverables, phase, evidence)', () => {
      const board = new TeamBoard(sampleConfig);
      board.plan([
        {
          id: 'task-contract-1',
          title: '实现契约功能',
          instructions: '严格按照契约实现',
          acceptance: '验收标准',
          memberId: 'dev-1',
          writeScopes: ['src/core.mjs'],
          readOnly: false,
          taskType: 'code',
          deliverables: [{ path: 'src/core.mjs', type: 'file' }]
        }
      ], 'model');
      
      const snap = board.snapshot();
      const task = snap.tasks[0];
      assert.equal(task.taskType, 'code');
      assert.deepEqual(task.deliverables, [{ path: 'src/core.mjs', type: 'file' }]);
      assert.equal(task.phase, 'ready');

      // 模拟子模型提交 evidence
      board.approve('user');
      board.start('task-contract-1');
      board.finish('task-contract-1', {
        summary: '完成契约实现',
        output: 'ok',
        files: ['src/core.mjs'],
        evidence: {
          summary: '完成契约实现',
          touchedFiles: ['src/core.mjs'],
          testRuns: [{ command: 'npm test', exitCode: 0 }]
        }
      });

      const finishedSnap = board.snapshot();
      const finishedTask = finishedSnap.tasks[0];
      assert.equal(finishedTask.status, 'review');
      assert.equal(finishedTask.phase, 'verifying');
      assert.ok(finishedTask.evidence);
      assert.equal(finishedTask.evidence.summary, '完成契约实现');
      assert.deepEqual(finishedTask.evidence.touchedFiles, ['src/core.mjs']);
    });

    it('只读成员坚决不能接收写入任务，可写任务必须显式声明 writeScopes', () => {
      const board = new TeamBoard(sampleConfig);
      assert.throws(() => {
        board.plan([
          {
            id: 'task-bad-scope',
            title: '只读成员分配写范围',
            instructions: '违规',
            acceptance: '验收标准',
            memberId: 'qa-1', // qa-1 是 readOnly
            writeScopes: ['test/a.js']
          }
        ], 'model');
      }, /a read-only member cannot receive write scopes/);

      assert.throws(() => {
        board.plan([
          {
            id: 'task-no-scope',
            title: '可写任务未声明范围',
            instructions: '违规',
            acceptance: '验收标准',
            memberId: 'dev-1',
            writeScopes: [] // 空范围
          }
        ], 'model');
      }, /必须声明精确的 writeScopes/);
    });
  });

  describe('2. 旧快照兼容性 (Legacy Snapshot Backward Compatibility)', () => {
    it('完全兼容缺少 planning, archivedTasks, batchId, deliverables 等字段的旧快照', () => {
      const legacySnapshot = {
        version: 1,
        revision: 4,
        status: 'ready',
        approved: true,
        tasks: [
          {
            id: 'legacy-task-1',
            title: '旧任务 1',
            instructions: '旧任务说明',
            acceptance: '已完成',
            memberId: 'dev-1',
            locked: false,
            dependencies: [],
            writeScopes: ['src/old.js'],
            readOnly: false,
            status: 'done',
            retries: 0
            // 缺少 taskType, deliverables, phase, evidence
          }
        ]
        // 缺少 planning, archivedTasks, batchId, recovery
      };

      const board = new TeamBoard(sampleConfig, legacySnapshot);
      const snap = board.snapshot();

      assert.equal(snap.batchId, 1);
      assert.deepEqual(snap.archivedTasks, []);
      assert.equal(snap.planning, null);

      const task = snap.tasks[0];
      assert.equal(task.id, 'legacy-task-1');
      assert.equal(task.taskType, 'code'); // 自动推导
      assert.deepEqual(task.deliverables, []);
      assert.equal(task.phase, 'completed'); // 根据 done 推导
      assert.equal(task.evidence, null);
    });

    it('旧快照恢复时 running 任务安全降级为 needs_attention，approved 置为 false 并设为 paused', () => {
      const activeSnapshot = {
        version: 1,
        revision: 3,
        status: 'ready',
        approved: true,
        tasks: [
          {
            id: 'active-task',
            title: '中断前运行的任务',
            instructions: '执行中',
            acceptance: '验收标准',
            memberId: 'dev-1',
            dependencies: [],
            writeScopes: ['src/core.mjs'],
            status: 'running',
            retries: 0
          }
        ]
      };

      const board = new TeamBoard(sampleConfig, activeSnapshot);
      const snap = board.snapshot();

      assert.equal(snap.status, 'paused');
      assert.equal(snap.tasks[0].status, 'needs_attention');
      assert.equal(snap.tasks[0].waitingReason, 'INTERRUPTED_RESTART');
      assert.equal(snap.tasks[0].phase, 'blocked');
      assert.ok(snap.recovery);
      assert.equal(snap.recovery.drained, false);
      assert.equal(snap.recovery.safeToShutdown, false);
    });
  });

  describe('3. drain 诚实性与停工安全判定 (Drain Honesty & Safety Checks)', () => {
    it('普通空闲板 (ready/paused) 绝不可宣称 safeToShutdown 或 isDrained', () => {
      const board = new TeamBoard(sampleConfig);
      board.plan([
        {
          id: 'task-idle',
          title: '普通空闲任务',
          instructions: '待执行',
          acceptance: '标准',
          memberId: 'dev-1',
          writeScopes: ['src/a.js']
        }
      ], 'model');

      const drainStatus = board.getDrainStatus();
      assert.equal(drainStatus.isDrained, false, '普通板即使无运行中任务，未排空也不得报告 isDrained: true');
      assert.equal(drainStatus.safeToShutdown, false, '普通板绝不能宣称可安全关机');
    });

    it('存在运行任务时调用 drain 进入 draining，绝不虚假标记 drained', () => {
      const board = new TeamBoard(sampleConfig);
      board.plan([
        {
          id: 'task-run',
          title: '正在运行',
          instructions: '运行中',
          acceptance: '标准',
          memberId: 'dev-1',
          writeScopes: ['src/a.js']
        }
      ], 'model');
      board.approve('user');
      board.start('task-run');

      const snapAfterDrain = board.drain();
      assert.equal(snapAfterDrain.status, 'draining');
      const drainStatus = board.getDrainStatus();
      assert.equal(drainStatus.isDrained, false);
      assert.equal(drainStatus.safeToShutdown, false);
      assert.equal(drainStatus.activeExecutions, 1);
    });

    it('两阶段排空结算：无运行任务且必须收到宿主真实 settlement 回执后才可 safeToShutdown', () => {
      const board = new TeamBoard(sampleConfig);
      // 空任务板调用 drain，但宿主尚未确认进程退出
      board.drain({ settled: true, processStopped: false });
      let status = board.getDrainStatus();
      assert.equal(status.isDrained, true);
      assert.equal(status.safeToShutdown, false, '进程未停止时严禁 safeToShutdown');

      // 宿主完成进程退出并给出真实回执
      board.drain({ settled: true, processStopped: true });
      status = board.getDrainStatus();
      assert.equal(status.isDrained, true);
      assert.equal(status.safeToShutdown, true);
    });
  });

  describe('4. 复评不自动扩大范围与批准保护 (Phase Review & No Scope Expansion)', () => {
    it('新规划提交或已有任务变更后，原批准立即作废，杜绝越权自动执行', () => {
      const board = new TeamBoard(sampleConfig);
      board.plan([
        {
          id: 't-1',
          title: '任务 1',
          instructions: '内容',
          acceptance: '标准',
          memberId: 'dev-1',
          writeScopes: ['src/1.js']
        }
      ], 'model');
      board.approve('user');
      assert.equal(board.snapshot().approved, true);

      // 追加任务必须自动吊销批准
      board.appendTasks([
        {
          id: 't-2',
          title: '任务 2',
          instructions: '内容 2',
          acceptance: '标准 2',
          memberId: 'dev-1',
          writeScopes: ['src/2.js']
        }
      ], 'model');

      assert.equal(board.snapshot().approved, false, '追加任务后必须撤销批准，等待用户再次确认');
      assert.throws(() => {
        board.start('t-2');
      }, /plan requires user approval/, '未批准时禁止启动执行');
    });
  });

  describe('5. 悬浮窗三区布局与数据呈现 (Floating Monitor Three-box UI)', () => {
    function simulateRender(boardTasks, status = 'ready') {
      const calls = [];
      const window = {
        __ModuleLoader__: {
          load({ id, factory }) {
            calls.push({ id, exports: factory(name => {
              if (name === 'react') {
                return {
                  Fragment: Symbol('Fragment'),
                  createElement: (type, props, ...children) => ({
                    type,
                    props: props || {},
                    children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false)
                  }),
                  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
                  useEffect: () => {},
                  useCallback: fn => fn,
                  useRef: () => ({ current: null })
                };
              }
              if (name === '@deepseek-ai/dsh-client-ui-slots') return {};
              throw new Error(`unexpected module: ${name}`);
            }) });
          }
        }
      };
      const document = {
        getElementById: () => null,
        createElement: () => ({ dataset: {}, textContent: '' }),
        head: { appendChild() {} }
      };

      vm.runInNewContext(clientSource, {
        window,
        document,
        fetch: async () => ({
          ok: true,
          json: async () => ({
            ok: true,
            board: { status, approved: true, tasks: boardTasks },
            config: sampleConfig
          })
        }),
        localStorage: { getItem: () => null, setItem() {} },
        setInterval: () => 0,
        clearInterval() {},
        setTimeout: () => 0,
        encodeURIComponent,
        URL
      });

      return { calls };
    }

    it('源码中明确声明三区 (running, review, pending) 容器及 history 独立容器', () => {
      assert.ok(clientSource.includes("'data-task-box': boxKey"), '必须声明三区容器 data-task-box');
      assert.ok(clientSource.includes("'data-task-box': 'history'"), '必须将已完成/取消/失败剥离至独立 history 容器');
      assert.ok(clientSource.includes("renderTaskBox('running', '⚡ 运行中'"), '必须具有运行中专属箱');
      assert.ok(clientSource.includes("renderTaskBox('review', '🔍 审计中'"), '必须具有审计中专属箱');
      assert.ok(clientSource.includes("renderTaskBox('pending', '⏳ 待执行'"), '必须具有待执行专属箱');
      assert.ok(clientSource.includes("data-box-count"), '必须显示各箱数量统计');
      assert.ok(clientSource.includes("data-box-empty"), '必须具备独立空态提示');
    });

    it('悬浮窗仿真加载并正确注册组件', () => {
      const { calls } = simulateRender([]);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].id, 'dsh-lead-worker');
      const registrations = [];
      calls[0].exports.apply({
        slots: {
          inject: (_name, reg) => reg(),
          register: (spec, comp) => registrations.push({ spec, comp })
        }
      });
      assert.equal(registrations.length, 4);
      assert.ok(registrations.some(r => r.spec.id === 'lead-worker-autopilot-input'));
    });
  });

});
