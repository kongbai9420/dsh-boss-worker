import { teamAvailability } from './availability.mjs';
import { evaluateQualityGate } from './quality-gates.mjs';
import { normalizeContractTask } from './contracts.mjs';
import { loadHostModule, isolatedTestRuntime } from './host-runtime.mjs';
let defineTool;
try { defineTool = (await loadHostModule('@deepseek-ai/dsh-tools')).defineTool; }
catch (err) { if (!isolatedTestRuntime) throw err; defineTool = spec => spec; }

function resolveSessionId(exec) {
  const candidates = [
    exec?.agent?.session?.header?.id,
    exec?.session?.header?.id,
    exec?.sessionId,
    exec?.agent?.sessionId,
    exec?.agent?.id,
  ];
  return candidates.find(value => typeof value === 'string' && value.trim()) || null;
}

export function createLeadWorkerTools({ getBoard, getMemberCatalog, dispatchTask, scheduleReadyTasks, resetBoard, askUserQuestion, batchAction }) {
  const sessionOf = (exec) => {
    const sessionId = resolveSessionId(exec);
    if (!sessionId) throw new Error('无法解析当前对话 sessionId，已拒绝创建错误任务板');
    exec.logger?.info?.(`lead-worker session resolved: ${sessionId}`);
    return sessionId;
  };
  const statusTool = defineTool({
    name: 'lead_worker_status',
    description: '获取当前会话的主从团队状态机快照，包括任务状态、分配成员、依赖关系、是否已获用户批准等。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: `团队状态: ${value.status} | 计划批准: ${value.approved} | 任务总数: ${value.tasks?.length ?? 0}`
      }]
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const sessionId = sessionOf(exec);
      const board = getBoard(sessionId);
      if (!board) {
        return { error: '当前会话未启用 BOSS直派 (Lead-Worker)' };
      }
      return { ...board.snapshot(), availability: teamAvailability(board.config, board.snapshot()) };
    }
  });

  const planTool = defineTool({
    name: 'lead_worker_plan',
    description: '主控模型（如 Astra）先分析用户目标与相关代码，主动拆分为独立子任务，标明依赖、精确且尽量不重叠的 writeScopes、成员与可验证的验收标准；让不冲突任务尽量并行，冲突任务串行。',
    parameters: {
      append: { type: 'boolean', description: '追加下一阶段任务，保留现有任务和跨阶段依赖；默认新规划。' },
      tasks: {
        type: 'array',
        required: true,
        description: '任务列表。每项任务需包含清晰的说明与验收标准。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: '任务唯一标识符，如 task-1, task-2' },
            title: { type: 'string', required: true, description: '任务简要标题' },
            instructions: { type: 'string', required: true, description: '交付给子模型的具体执行要求与上下文' },
            acceptance: { type: 'string', required: true, description: '验收标准，明确如何证明任务完成' },
            memberId: { type: 'string', description: '建议分配的团队成员 ID。手动模式下可为空。' },
            dependencies: { type: 'array', items: { type: 'string' }, description: '前置依赖的任务 ID 列表' },
            writeScopes: { type: 'array', items: { type: 'string' }, description: '准确的相对文件或目录路径。并行任务的范围必须不相交；可写任务不可省略，未知范围请按全工作区处理。' },
            readOnly: { type: 'boolean', description: '是否为纯只读/分析任务' },
            taskType: { type: 'string', description: '任务类型（code 代码 / test 测试 / analysis 分析 / review 审查 / doc 文档 / general 通用）' },
            deliverables: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '预期成果清单（要交付的文件或产出）' },
            evidence: { type: 'object', additionalProperties: true, description: '任务实测结果信息（成员自报的测试与文件改动）' }
          }
        }
      }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: value.cancelled ? '用户选择不执行：计划未加入待执行列表，现有任务保持不变。' : value.error
          ? `规划失败: ${value.error}${value.hint ? `\n纠正建议: ${value.hint}` : ''}`
          : `计划已提交！共 ${value.tasks?.length || 0} 项任务。当前状态: ${value.status}，已获批准: ${value.approved}。${value.archivedTasks?.length ? `（已安全归档旧批次 ${value.archivedTasks.length} 项历史任务）` : ''}`
      }]
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      let board = getBoard(sessionId);
      if (!board) throw new Error('当前会话未启用 BOSS直派协作团队');
      if (!Array.isArray(args?.tasks) || args.tasks.length === 0) {
        return {
          error: 'tasks 必须为非空任务列表',
          code: 'INVALID_INPUT',
          hint: '请提供包含 id、title、instructions、acceptance 等完整字段的任务数组。'
        };
      }
      let tasksToPlan;
      try {
        tasksToPlan = args.tasks.map(t => {
          if (!t || typeof t !== 'object') throw new Error('任务项必须是合法对象');
          if (t.taskType || t.deliverables || t.evidence) {
            const norm = normalizeContractTask(t);
            const out = {
              id: norm.id,
              title: norm.title,
              instructions: norm.instructions,
              acceptance: norm.acceptance,
              memberId: norm.memberId,
              dependencies: norm.dependencies,
              writeScopes: norm.writeScopes,
              readOnly: norm.readOnly,
              taskType: norm.taskType,
              deliverables: norm.deliverables,
            };
            if (norm.evidence) out.evidence = norm.evidence;
            return out;
          }
          return t;
        });
      } catch (normErr) {
        return {
          error: `任务格式规范化失败: ${normErr.message}`,
          code: 'NORMALIZATION_FAILED',
          hint: '请检查 tasks 数组中各项字段是否合规，必须包含 id、title、instructions、acceptance，可写任务须声明精确 writeScopes。'
        };
      }

      try {
        let accepted = false;
        const beforeRevision = board.snapshot().revision;
        const beforeConfig = JSON.stringify(board.config);
        if (!board.config.autopilot && board.config.confirmPlan && board.config.askApprovalPrompt !== false) {
          // Validate on a detached board before prompting; a rejection must
          // leave the live board and its history completely untouched.
          const { TeamBoard } = await import('./core.mjs');
          const preview = new TeamBoard(board.config, board.snapshot());
          if (args.append) preview.appendTasks(tasksToPlan, 'model');
          else preview.plan(tasksToPlan, 'model');
          preview.approve('user');
          const questionId = 'lead-worker-plan-consent';
          const answer = await askUserQuestion([{ id: questionId, header: '确认任务计划',
            question: `是否执行以下${args.append ? '追加' : ''}计划？\n${tasksToPlan.map(t => `- ${t.title}：${t.acceptance}`).join('\n')}`,
            options: [{ label: '批准执行计划' }, { label: '不执行', description: '不加入待执行列表，保留现有任务。' }]
          }], exec);
          accepted = answer?.answers?.find(a => a.id === questionId)?.selected?.includes('批准执行计划') === true;
          if (!accepted) return { cancelled: true, tasks: [], status: board.snapshot().status, hint: '计划未获批准，未加入任务板；请停止派发，不要重复建立同一计划。' };
          if (JSON.stringify(board.config) !== beforeConfig || board.snapshot().revision !== beforeRevision) throw new Error('确认期间任务板或模式已变更，本次计划未入队，请重新核对');
        }
        const planned = args.append ? board.appendTasks(tasksToPlan, 'model') : board.plan(tasksToPlan, 'model');
        if (accepted) {
          board.approve('user');
          if (board.config.bossDirect) await scheduleReadyTasks(sessionId, exec);
          return board.snapshot();
        }
        if (board.config.autopilot) {
          await scheduleReadyTasks(sessionId, exec);
          return board.snapshot();
        }
        return planned;
      } catch (err) {
        const snap = board.snapshot();
        let hint = '请核实任务依赖、ID及成员分配后重试。';
        if (err.code === 'ACTIVE_TASKS_RUNNING') {
          hint = '当前仍有子模型在执行或待把关审查。请先调用 lead_worker_status 核实进度，调用 lead_worker_review 审查已完成任务，或调用 lead_worker_recovery pause/interrupt 停止当前批次后再规划新任务。';
        } else if (err.code === 'PAUSED') {
          hint = '当前任务板处于暂停状态。请先调用 lead_worker_recovery resume 恢复调度，然后再提交新规划。';
        } else if (err.code === 'CANCELLED') {
          hint = '任务板批次已取消。系统已支持在 cancelled 状态下规划新计划并安全归档旧历史，请检查是否有活跃任务或冲突。';
        }
        return {
          error: err.message,
          code: err.code || 'PLAN_FAILED',
          hint,
          currentBoardStatus: snap.status,
          tasksCount: snap.tasks?.length || 0
        };
      }
    }
  });

  const approveTool = defineTool({
    name: 'lead_worker_approve',
    description: '当主控在对话中通过 ask_user_question 获得用户对规划的“批准执行”授权后，调用此工具将状态机的任务板正式标记为已批准状态。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: value.error ? `批准失败: ${value.error}${value.hint ? `\n纠正建议: ${value.hint}` : ''}` : `任务规划已正式获批，状态已就绪，可以开始派发任务！`
      }]
    },
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      const sessionId = sessionOf(exec);
      const board = getBoard(sessionId);
      if (!board) throw new Error('当前会话未启用 BOSS直派协作团队');
      const snap = board.snapshot();
      if (snap.status === 'cancelled') {
        return {
          error: '当前任务板处于已取消 (cancelled) 状态，旧批次已终结，无法批准旧工作。',
          code: 'CANCELLED',
          hint: '请先调用 lead_worker_plan 提交新一轮任务计划，通过 ask_user_question 征得用户明确同意后再调用 lead_worker_approve。'
        };
      }
      try {
        const approved = board.approve('user');
        // BOSS直派开启时，批准计划即自动启动安全调度；不依赖主模型再次记得调用 dispatch，避免任务被内置 subagent 工具截走。
        if (board.config.bossDirect === true) {
          await scheduleReadyTasks(sessionId, exec);
        }
        return approved;
      } catch (err) {
        return {
          error: err.message,
          code: err.code || 'APPROVE_FAILED',
          hint: err.code === 'UNASSIGNED' ? '所有任务必须分配团队成员后才能批准执行。请调用 lead_worker_list_members 查看可用角色。' : '请核实任务状态后重试。'
        };
      }
    }
  });

  const dispatchTool = defineTool({
    name: 'lead_worker_dispatch',
    description: '主控触发安全并行调度：指定就绪任务时，系统在依赖、成员、文件范围与 maxParallel 约束下并行派发可运行任务；资源暂满则排队等待。主控也可同时调用多个不同就绪任务。',
    parameters: {
      taskId: {
        type: 'string',
        required: true,
        description: '要启动执行的任务 ID'
      }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: value.error ? `派发失败: ${value.error}` : `任务 ${value.taskId} 当前状态: ${value.status}。${value.summary || value.reason || ''}；只有 review 表示已返回结果，running 表示执行中，queued 表示未启动。`
      }]
    },
    // Concurrent calls are safe: TeamBoard.start synchronously reserves a task and checks limits/scopes before the first await.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      const board = getBoard(sessionId);
      if (!board) throw new Error('当前会话未启用 BOSS直派协作团队');
      const target = board.snapshot().tasks.find(t => t.id === args.taskId);
      const overlapsRunningScope = target && board.snapshot().tasks.some(other => other.status === 'running' &&
        !target.readOnly && !board.config.members.find(m => m.id === target.memberId)?.readOnly &&
        !other.readOnly && !board.config.members.find(m => m.id === other.memberId)?.readOnly &&
        target.writeScopes.some(a => other.writeScopes.some(b => {
          const norm = s => s.replace(/\\/g, '/').replace(/\/$/, '');
          const x = norm(a), y = norm(b);
          return x === '**' || y === '**' || x === '.' || y === '.' || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
        })));
      if (target?.status === 'pending' && !overlapsRunningScope) {
        const started = await scheduleReadyTasks(sessionId, exec, args.taskId);
        if (started.includes(args.taskId)) {
          return { taskId: args.taskId, status: 'running', summary: '已加入安全并行调度队列' };
        }
        return { taskId: args.taskId, status: 'queued', reason: 'waiting for a free member, parallel slot, or finished dependencies' };
      }
      if (target?.status !== 'running') board.start(args.taskId);
      const results = await dispatchTask(sessionId, args.taskId, exec);
      // A finished dispatch frees both its member and scopes; use that capacity immediately.
      await scheduleReadyTasks(sessionId, exec);
      return results;
    }
  });

  const reviewTool = defineTool({
    name: 'lead_worker_review',
    description: '主控用中文审查子模型结果。达标则通过；不达标且未超返工上限时退回修改。达到上限后暂停任务并询问用户是否允许继续返工，只有用户明确同意后才继续。',
    parameters: {
      taskId: {
        type: 'string',
        required: true,
        description: '被审查的任务 ID'
      },
      passed: {
        type: 'boolean',
        required: true,
        description: '是否通过验收'
      },
      feedback: {
        type: 'string',
        description: '审查意见。如果未通过验收，必须详细说明未满足之处和具体返工要求。'
      }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: (() => { const task = value.tasks?.find(t => t.id === _args.taskId); return task?.waitingReason === 'RETRY_LIMIT_REACHED' ? `任务 ${task.title} 已达到返工上限，正在请求用户决定是否继续。` : `审查完成。任务状态: ${task?.status}`; })()
      }]
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      const board = getBoard(sessionId);
      if (!board) throw new Error('当前会话未启用 BOSS直派协作团队');
      if (typeof askUserQuestion !== 'function') throw new Error('DSH 官方用户提问服务未接入');

      // 接入验收把关核验并生成主控摘要
      const currentTask = board.snapshot().tasks.find(item => item.id === args.taskId);
      let reviewFeedback = args.feedback ?? '';
      if (currentTask) {
        try {
          const submission = {
            ...(currentTask.result && typeof currentTask.result === 'object' ? currentTask.result : {}),
            ...(currentTask.evidence && typeof currentTask.evidence === 'object' ? currentTask.evidence : {}),
            touchedFiles: currentTask.evidence?.files || currentTask.result?.files || [],
            modifiedFiles: currentTask.evidence?.files || currentTask.result?.files || [],
            testRuns: currentTask.evidence?.tests || (currentTask.result && Array.isArray(currentTask.result.testRuns) ? currentTask.result.testRuns : []),
            executionEpoch: currentTask.executionEpoch,
            deliverables: currentTask.deliverables || []
          };
          const gate = evaluateQualityGate({ ...currentTask, maxRetries: board.config.maxRetries }, submission, { maxRetries: board.config.maxRetries, reviewPassed: args.passed });
          if (gate && gate.summary) {
            reviewFeedback = reviewFeedback.trim()
              ? `${gate.summary}\n\n【主控审查意见】\n${reviewFeedback.trim()}`
              : gate.summary;
          }
        } catch (gateErr) {
          exec.logger?.warn?.(`验收把关评估异常: ${gateErr.message}`);
        }
      }

      const result = board.review(args.taskId, args.passed, reviewFeedback);
      const task = result.tasks.find(item => item.id === args.taskId);
      if (task?.waitingReason === 'RETRY_LIMIT_REACHED') {
        try {
          const answer = await askUserQuestion([{
            id: `retry-limit-${task.id}`,
            header: '返工次数已达上限',
            question: `任务“${task.title}”仍有未解决的问题。是否允许再进行一轮返工？`,
            options: [
              { label: '继续返工', description: '授权额外一轮返工，并保留此前全部审查记录。' },
              { label: '停止返工', description: '保持暂停，不再自动派发该任务。' },
            ],
          }], exec);
          const selected = answer?.answers?.find(item => item.id === `retry-limit-${task.id}`)?.selected || [];
          if (selected.includes('继续返工')) {
            const authorized = board.continueAfterRetryLimit(task.id, 'user');
            await scheduleReadyTasks(sessionId, exec);
            return authorized;
          }
        } catch (error) {
          // The task remains paused at needs_attention unless the user explicitly approved.
          exec.logger?.warn?.(`等待超限返工审批失败: ${error.message}`);
        }
        return result;
      }
      await scheduleReadyTasks(sessionId, exec);
      return result;
    }
  });

  const membersTool = defineTool({
    name: 'lead_worker_list_members',
    description: '每次规划、追加工作和派发前动态读取角色数量、职责、权限、忙闲、并发容量及待执行任务的依赖/范围冲突原因；合理分配不同角色，充分利用空闲成员，不能为凑并发绕过依赖。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: `可用团队成员:\n${value.members?.map(m => `- [${m.id}] ${m.name} (${m.provider}/${m.model}): ${m.role}`).join('\n') || '(无)'}`
      }]
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const sessionId = sessionOf(exec);
      const board = getBoard(sessionId);
      if (!board) {
        return { members: getMemberCatalog(sessionId) };
      }
      return teamAvailability(board.config, board.snapshot());
    }
  });

  const recoveryTool = defineTool({
    name: 'lead_worker_recovery',
    description: '暂停批次（当前任务收尾）、中断执行、下班停工结算、保存续做检查点或恢复批次。中断/续做/恢复/停工须先询问用户；recoverTask 必须核查磁盘改动与测试并取得明确确认，不能绕过超限返工授权。resume 只恢复调度，后续用 dispatch 派发。停工动作输出结构化关机条件。',
    parameters: {
      action: { type: 'string', enum: ['pause', 'interrupt', 'checkpoint', 'recoverTask', 'resume', 'shutdown'], required: true },
      taskId: { type: 'string' }, note: { type: 'string', description: '已完成步骤、文件差异、实际测试、未完成事项、下一步；禁止编造现场核查结果' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: value.error
          ? `恢复操作提示: ${value.error}${value.hint ? `\n建议: ${value.hint}` : ''}`
          : `批次状态: ${value.status || value.board?.status}${value.shutdownConditions ? `\n关机安全核查: ${value.shutdownConditions.summary}\n排空状态: ${value.drained ? '全部排空' : '未完全排空/超时'}` : ''}${value.structuredNotice ? `\n[提示]: ${value.structuredNotice.notice || value.structuredNotice.nextSteps || ''}` : ''}`
      }]
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      if (args.action === 'resume') {
        const board = getBoard(sessionId);
        if (board?.snapshot().status === 'cancelled') {
          return {
            status: 'cancelled',
            error: '当前任务板处于已取消 (cancelled) 状态，无法直接 resume。',
            hint: '旧批次已取消终结。若要开展新工作，请直接调用 lead_worker_plan 提交新计划并请求用户批准。'
          };
        }
      }
      // Resume restores scheduling only; plan approval remains enforced by
      // board.start/scheduler. Do not ask twice for already approved work.
      if (['interrupt', 'recoverTask', 'shutdown'].includes(args.action)) {
        const id = `batch-recovery-confirm-${args.action}`;
        let question;
        if (args.action === 'interrupt') {
          question = '是否中断当前批次？可能保留未完成的文件修改。';
        } else if (args.action === 'recoverTask') {
          question = `已核查文件与测试，是否按以下记录续做任务 ${args.taskId}？\n${args.note || ''}`;

        } else if (args.action === 'shutdown') {
          question = '是否执行下班停工结算？系统将中断当前执行实例、等待安全排空并核查持久化现场。';
        }
        const answer = await askUserQuestion([{
          id,
          question,
          options: [{ label: '确认执行' }, { label: '取消' }]
        }], exec);
        if (!answer?.answers?.find(a => a.id === id)?.selected?.includes('确认执行')) {
          return {
            status: getBoard(sessionId)?.snapshot()?.status,
            cancelled: true,
            hint: `用户未确认执行 ${args.action} 操作，保持当前状态不变。`
          };
        }
      }
      return batchAction(sessionId, args.action, { taskId: args.taskId, note: args.note, continuationNote: args.note, timeoutMs: 3000 });
    }
  });
  return [statusTool, planTool, approveTool, dispatchTool, reviewTool, membersTool, recoveryTool];
}
