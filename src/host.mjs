import { loadHostModule, isolatedTestRuntime } from './host-runtime.mjs';
let Service, z;
try {
  Service = (await loadHostModule('@deepseek-ai/cordis')).Service;
  const schema = await loadHostModule('@deepseek-ai/schemastery');
  z = schema.default || schema;
} catch (err) {
  if (!isolatedTestRuntime) throw err;
  Service = class { constructor(ctx, name) { this.ctx = ctx; this.name = name; } };
  z = { object: () => ({ default: () => ({}) }), any: () => ({ default: v => v }) };
}

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveStorePath } from './profile-storage.mjs';
import { TeamBoard } from './core.mjs';
import { teamAvailability } from './availability.mjs';
import { createLeadWorkerTools } from './tools.mjs';
import { evaluateQualityGate } from './quality-gates.mjs';
import { normalizeEvidence } from './contracts.mjs';
import { bossGuardReason, requireParent } from './boss-policy.mjs';
import { notifyParentReview, getReviewNoticeStates } from './review-notifier.mjs';
import { validateApiRequest } from './api-security.mjs';

let createUserMessage;
try { createUserMessage = (await loadHostModule('@deepseek-ai/dsh-llm')).createUserMessage; }
catch (err) {
  if (!isolatedTestRuntime) throw err;
  createUserMessage = input => ({ role: 'user', content: input.content, source: input.source });
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',

  });
  res.end(JSON.stringify(payload));
}

const DEFAULT_TEAM_CONFIG = {
  enabled: true,
  mode: 'mixed',
  bossDirect: true,
  leadPrompt: '你是 BOSS 主控负责人。收到需求后先用中文分析目标、检查相关结构并主动拆解为独立任务，分配给子模型执行；主模型负责检查、审查与把关验收这些主控规则，切勿亲自编写具体业务实现代码。无论是单任务还是多任务，均先使用 lead_worker_plan 拆分任务并用 lead_worker_dispatch 派发给子模型执行，子模型交付后由主模型核对改动、测试凭据并通过 lead_worker_review 严格把关验收。',
  members: [
    {
      id: 'worker-sol',
      name: 'Sol (代码执行)',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      role: '负责具体编码、文件修改与逻辑实现',
      instructions: '请全程使用中文理解任务、分析方案并汇报。严格按主控任务书与验收标准执行，不擅自扩大范围；只修改分配的 writeScopes，不触碰其他任务负责的文件。先检查相关文件和约束，再做最小必要改动；完成后运行适用测试，逐项报告修改文件、关键实现、测试命令与真实结果、已知风险。遇到范围冲突、信息不足或无法验证时立即说明并暂停相关改动，不要编造完成情况。',
      enabled: true,
      readOnly: false
    },
    {
      id: 'worker-qa',
      name: 'QA 测试员',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      role: '负责编写测试用例、运行验证、检查缺陷',
      instructions: '请全程使用中文。作为只读质量检查员，不修改、创建或删除任何文件；检查主控指定范围内的实现、边界条件、安全性与测试覆盖，运行可执行的相关测试。按严重程度列出问题，给出文件位置和复现依据；没有发现问题时也须说明检查了什么、运行了哪些命令及结果。不得把推测写成事实。',
      enabled: true,
      readOnly: true
    }
  ],
  maxParallel: 4,
  maxRetries: 2,
  confirmPlan: true,
  askApprovalPrompt: true
};

export class LeadWorkerHostService extends Service {
  static Config = z.object({
    defaultConfig: z.any().default(DEFAULT_TEAM_CONFIG)
  });

  #boards = new Map();
  #sessionConfigs = new Map();
  #sessionRoutes = new Map();
  #sharedConfig = null;
  #configRevision = 0;
  #store;
  #sessionBoss = new Map();
  #sessionAutopilot = new Map();
  #automaticDispatchStopped = new Set();
  #sessionStates = new Map();
  #schedulerJobs = new Map();
  #activeExecutions = new Map();
  #sessionExecs = new Map();
  #recoveryAudits = new Map();
  #notifiedPhaseReviews = new Set();

  constructor(ctx, config) {
    super(ctx, 'leadWorker');
    this.config = config ?? {};
    // Unit harnesses explicitly isolate APPDATA; never let inherited shell
    // DSH_PROFILE_DIR redirect those harnesses to a real running profile.
    const storageEnv = isolatedTestRuntime ? { APPDATA: process.env.APPDATA } : process.env;
    this.#store = resolveStorePath(ctx, storageEnv);
    if (this.#store.source === 'fallback') ctx.logger?.warn?.('未提供Profile上下文，使用兼容存储路径；请核对Profile隔离');
    if (!this.#sharedConfig) this.#sharedConfig = new TeamBoard(this.config.defaultConfig || DEFAULT_TEAM_CONFIG).config;
    try {
      const stored = JSON.parse(readFileSync(this.#store.file, 'utf8'));
      if (Number.isSafeInteger(stored.configRevision)) this.#configRevision = stored.configRevision;
      if (stored.shared) {
        this.#sharedConfig = new TeamBoard(stored.shared).config;
        for (const id of stored.automaticDispatchStopped || []) if (typeof id === 'string') this.#automaticDispatchStopped.add(id);
        for (const [id, value] of Object.entries(stored.sessionAutopilot || {})) {
          if (typeof value === 'boolean') this.#sessionAutopilot.set(id, value);
        }
        for (const [id, value] of Object.entries(stored.sessionBoss || {})) {
          if (typeof value === 'boolean') this.#sessionBoss.set(id, value);
        }
        // Preserve saved user settings on restart; defaults apply only to new installations.
        for (const [id, state] of Object.entries(stored.boards || {})) this.#sessionStates.set(id, state);
        for (const [id, routes] of Object.entries(stored.sessionRoutes || {})) {
          if (Array.isArray(routes)) this.#sessionRoutes.set(id, routes.filter(m => m?.id?.startsWith('task-route-')));
        }
        // Recover older globally stored task routes into their owning sessions.
        const legacyRoutes = this.#sharedConfig.members.filter(m => m.id.startsWith('task-route-'));
        const sessionIds = new Set([...this.#sessionStates.keys(), ...this.#sessionBoss.keys(), ...this.#sessionAutopilot.keys(), ...this.#sessionRoutes.keys()]);
        for (const member of legacyRoutes) {
          // Prefer the longest known session ID to avoid prefix collisions.
          const owner = [...sessionIds].filter(id => member.id.startsWith(`task-route-${id}-`)).sort((a, b) => b.length - a.length)[0];
          // Unknown legacy ownership is archived privately, not discarded or
          // exposed to all sessions. Keep its complete historical member data.
          const id = owner || `legacy-unowned:${member.id}`;
          const routes = this.#sessionRoutes.get(id) || [];
          if (!routes.some(m => m.id === member.id)) routes.push(member);
          this.#sessionRoutes.set(id, routes);
        }
        this.#sharedConfig = { ...this.#sharedConfig, members: this.#sharedConfig.members.filter(m => !m.id.startsWith('task-route-')) };
        this.persistStore();
      } else if (stored.sessions) {
        this.#sharedConfig = new TeamBoard(this.config.defaultConfig || DEFAULT_TEAM_CONFIG).config;
      } else {
        // Migrate the previous per-session file format to one shared config.
        const legacyConfig = Object.values(stored).find(value => value && typeof value === 'object' && Array.isArray(value.members));
        if (legacyConfig) this.#sharedConfig = new TeamBoard(legacyConfig).config;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') ctx.logger.warn(`读取协作设置失败: ${err.message}`);
    }

    // Bounded idle-only reminders; never approve or rerun business tasks.
    if (!isolatedTestRuntime && typeof ctx.on === 'function') {
      const timer = setInterval(() => this.remindPendingReviews().catch(err => ctx.logger.warn(`审查补提醒失败: ${err.message}`)), 60000);
      timer.unref?.();
      ctx.on('dispose', () => clearInterval(timer));
    }

    // 1. 注册主控端工具
    // tools.guard 是真正作用于主模型工具执行面的全局单调门禁；仅包裹 subagents.start
    // 无法拦截主模型通过原生 subagent 工具发起的调用。
    ctx.inject(['tools'], ({ tools }) => {
      if (!tools?.guard) return;
      tools.guard((exec) => {
        const sessionId = exec?.agent?.session?.header?.id;
        return sessionId ? bossGuardReason(exec, this.getConfig(sessionId)) : undefined;
      });
    });

    ctx.inject(['tools', 'userQuestions'], (toolsCtx) => {
      const tools = createLeadWorkerTools({
        getBoard: (sessionId) => this.getOrCreateBoard(sessionId),
        resetBoard: (sessionId) => {
          const config = this.getConfig(sessionId);
          const newBoard = new TeamBoard(config, undefined, state => {
            this.#sessionStates.set(sessionId, state);
            this.persistStore();
          });
          this.#boards.set(sessionId, newBoard);
          this.#sessionStates.set(sessionId, newBoard.snapshot());
          this.persistStore();
          return newBoard;
        },
        batchAction: (sessionId, action, params) => this.handleAction(sessionId, action, params),
        getMemberCatalog: (sessionId) => this.getConfig(sessionId).members,
        dispatchTask: (sessionId, taskId, exec) => this.dispatchTask(sessionId, taskId, exec),
        scheduleReadyTasks: (sessionId, exec, explicitTaskId) => this.scheduleReadyTasks(sessionId, exec, explicitTaskId),
        askUserQuestion: async (questions, exec) => toolsCtx.userQuestions.ask({ questions, agent: exec.agent, signal: exec.signal })
      });
      for (const tool of tools) {
        toolsCtx.tools.register(tool);
      }
    });

    // 2. 注册系统提示词提示
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: 'lead-worker-coordination',
        order: 120,
        text: (context) => {
          const sessionId = context.session?.header?.id;
          if (!sessionId || context.session.header.parentSession || context.session.header.origin === 'subagent') return '';
          const board = this.#boards.get(sessionId);
          const config = this.getConfig(sessionId);
          if (!config || !config.enabled) return '';
          const coordinationActive = config.bossDirect === true || config.autopilot === true;
          const configuredPrompt = (config.leadPrompt || '').replace(/【👑 BOSS直派规则】:[^\n]*\n?/g, '').trim();
          const leadPrompt = !coordinationActive && configuredPrompt === DEFAULT_TEAM_CONFIG.leadPrompt ? '' : configuredPrompt;
          const effectiveLeadPrompt = config.autopilot ? leadPrompt.replace('严格遵守用户批准门禁，不得绕过审批。', '当前会话已授权全自动托管，常规项目规划与推进无需逐项批准；保留宿主安全限制和返工上限。') : leadPrompt;
          const customLeadPrompt = effectiveLeadPrompt ? `\n【主控定制准则】:\n${effectiveLeadPrompt}\n` : '';
          const askApproval = !config.autopilot && config.askApprovalPrompt !== false;
          const availability = teamAvailability(this.#sharedConfig || config, board?.snapshot());
          const isBossDirect = config.bossDirect === true || config.autopilot;
          const bossDirectRules = isBossDirect ? `
# 👑 BOSS直派核心规则 (已开启强制执行)
- 绝对分权原则：无论是单任务还是多任务、不论需求大小或复杂度，严禁主模型亲自编写实现代码、修改文件或直接在终端执行改动！所有具体代码实现、命令执行、测试验证必须先分配并派发给子模型（如 Sol、QA 等）干活。
- 主模型职责（BOSS / 主控）：负责且仅负责需求分析、任务拆分与规则约定（lead_worker_plan）、调度派发（lead_worker_dispatch）、以及严格审查把关（lead_worker_review）。
- 无论单任务还是多任务均强制派发：即使是用户只提出的单个简单任务或小需求，主模型也必须使用 lead_worker_plan 建立任务并分配给子模型，通过 lead_worker_dispatch 派发给子模型执行代码；待子模型执行完毕交付后，主模型再严格核实其改动与测试结果，调用 lead_worker_review 把关验收，严禁自己直接写代码实现。
` : '';
          return `
# 验收收敛与避免重复检查
- 子任务执行期间由成员自测；交付进入 review 后，主控独立核验并调用 lead_worker_review。通过即结束该次验收；仅返工后的新产出需要再次验收。
- 主控验收不默认另建子任务检查该子任务，更不建立逐层审计链；必要时可委派一次范围明确的独立技术验证，主控仍负责最终决定。
- 同一文件版本、相同范围、相同验证命令已有有效通过证据时必须复用；不得仅换任务标题重复检查。
- 新建检查任务的 instructions 必须写明【新增核验理由】：具体变更文件/版本、新失败或证据缺口，以及已有验收为何无法覆盖；仅检查增量。
- 真实测试失败、证据缺失、材料或授权不足时，汇总阻断及最小下一步；不能不断追加全面审计来制造进展。总目标达成则总结结束，不默认再建最终审计。
# BOSS直派协同模式 (Lead-Worker Mode)
${isBossDirect ? '当前会话已激活 BOSS 直派协作模式。' : '当前会话未开启BOSS直派或托管，主模型可直接处理请求；协作工具可按需使用。'}
${bossDirectRules}
${config.autopilot ? '【全自动托管已开启】用户已授权当前会话项目的常规规划与执行，无需逐步提问批准。主控持续规划、派发、严格审查并推进依赖和下一批工作；批次结束不等于项目完成，必须核对原始目标并安排集成测试，只有实际验收全部通过才汇报完成。子模型报告不能直接视为通过。不得绕过宿主权限、安全确认、返工上限、写入范围和真实阻塞；遇到缺失凭据或无法解决的故障明确报告。暂停和停工仍由用户控制。' : ''}
【动态角色与容量】${JSON.stringify(availability)}
- 每次规划、追加需求、成员变更后以及派发前，必须调用 lead_worker_list_members 获取最新角色，不沿用旧角色数量；根据职责、模型、读写权限和忙闲合理分工。
- 可用并发取 maxParallel、适合的空闲角色数、依赖已满足且范围不冲突的任务数的最小值。优先把独立任务分配给不同角色；相同模型的副本也是独立成员，不把工作全堆给第一个成员。
- 发现角色空闲时检查可否拆出有价值的独立工作（实现、只读调查、测试准备等）；不能为凑数量制造无意义任务或删除真实依赖。向用户说明每个等待任务的依赖、成员忙碌、范围冲突或并发上限原因。
- 运行中的任务、用户锁定的负责人和已批准工作范围不可擅自变更。职责不同的改派或范围/依赖变更必须重新提交规划与审批；调度器只允许未锁定任务在配置完全相同的空闲副本间平衡分配。
你是主控模型 (BOSS / Astra)，负责理解用户需求、提炼纲要、拆分任务、把关验收。${customLeadPrompt}
- 全程中文：分析、规划、分派说明、审查意见、子模型指令和最终汇报均使用中文；代码标识符、命令与文件路径保持原文。
- 主动规划：收到开发需求后先检查相关结构，用中文分析并主动拆分为可独立交付的任务。每项给出依赖、成员、可验证验收标准和准确 writeScopes。
- 指令自闭环上下文：派发子模型前，在任务说明（instructions）中必须完整提供必要的业务背景、用户需求意图、目标文件路径、技术规范与入参出参约定。子模型运行在干净独立的沙盒环境中，不依赖主会话的历史闲聊；主控必须确保每项任务指令都是自包含、上下文完备的完整技术任务书，让子模型拿到即可精准开工。
- 安全并行：优先并行依赖已满足且写入范围不相交的任务；共享接口、锁文件、公共配置指定单一任务所有者，其它任务依赖它。可写任务必须声明精确范围；范围不明确则先检查或询问，不得猜测。
- 并发派发：按需为就绪任务调用 lead_worker_dispatch，可在同一轮调用多个不冲突任务；系统会在可用成员、依赖、writeScopes 和 maxParallel 限制内自动排队派发，完成并验收后继续解锁队列。
- 审查返工：核对实际改动、测试与验收凭据。未通过时用中文逐条写明缺陷、文件位置和可执行返工要求；返工提示须包含此前全部审查记录。达到最大返工次数后，状态会转为“需人工介入”；停止自动派发，由任务卡向用户请求继续返工许可。用户明确同意前不得再派发该任务。
- 任务规划与审批门禁: 使用 \`lead_worker_list_members\` 了解可用成员，使用 \`lead_worker_plan\` 提交任务清单。${askApproval && config.confirmPlan ? '规划工具会在入队前展示一次执行确认卡，不要另行重复提问或调用批准。若返回 cancelled，表示用户拒绝：未加入任务板，停止该计划，不重复提交，不自行追加任务。' : ''}
- 任务执行: ${config.autopilot ? '托管授权内规划后自动调度，主控无需再次询问批准，继续审查和推进后续阶段。' : '用户批准后，应使用 lead_worker_dispatch 派发给对应的子模型执行，严禁未经审批私自执行代码。'}
- 验收闭环: 子模型执行完毕后进入 review 环节，你必须核实其改动和结果，调用 \`lead_worker_review\` 决定通过或附带具体意见要求返工。
- 跨重启续做：用户要求暂停时使用 lead_worker_recovery pause，保存每项任务的 checkpoint（已完成、实际文件改动、测试结果、未完成、下一步），不再派发新任务。重启后先读状态和磁盘差异；已完成不重跑，review先审查，needs_attention先核查现场并取得用户确认后 recoverTask；resume只恢复调度，随后安全派发。禁止清空任务板、虚构检查点或绕过超限审批。
`;
        }
      });
    });

    // 3. 注册 WebServer HTTP API 路由
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.webServer.register({
        kind: 'prefixes',
        path: '/api/lead-worker',
        handler: async (req, res) => {
          const url = new URL(req.url, 'http://127.0.0.1');
          const pathname = url.pathname;

          const security = validateApiRequest(req);
          if (!security.ok) return sendJson(res, security.status, { ok: false, error: security.error });
          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type',
            });
            return res.end();
          }

          try {
            if (pathname === '/api/lead-worker/debug-sessions') return sendJson(res, 404, { ok: false, error: 'Not found' });

            if (pathname === '/api/lead-worker/view') {
              const body = req.method === 'POST' ? await parseRequestBody(req) : {};
              const sessionId = url.searchParams.get('sessionId') || body.sessionId;
              if (!sessionId) {
                return sendJson(res, 400, { ok: false, error: 'sessionId is required' });
              }

              const config = this.getConfig(sessionId);
              const board = this.getOrCreateBoard(sessionId);
              const models = await this.listAvailableModels();

              return sendJson(res, 200, {
                ok: true,
                sessionId,
                runtime: {
                  revision: 'boss-audit-v2',
                  rootToolGuard: true,
                  liveParentAvailable: Boolean(this.ctx.get('agents')?.get(sessionId)),
                  activeExecutions: [...this.#activeExecutions.values()].filter(item => item.sessionId === sessionId).length,
                  recoveryAudits: this.getRecoveryAudits(sessionId),
                  reviewNotices: getReviewNoticeStates(sessionId),
                },
                enabled: config.enabled,
                config,
                configRevision: this.#configRevision,
                board: board ? board.snapshot() : null,
                canRunInParallel: Boolean(board && board.config.maxParallel > 1),
                availability: teamAvailability(board?.config || config, board?.snapshot()),
                models,
              });
            }

            if (pathname === '/api/lead-worker/action' && req.method === 'POST') {
              const body = await parseRequestBody(req);
              const { sessionId, action, ...params } = body;
              if (!sessionId || !action) {
                return sendJson(res, 400, { ok: false, error: 'sessionId and action are required' });
              }

              const result = await this.handleAction(sessionId, action, params);
              return sendJson(res, 200, { ok: true, result });
            }

            sendJson(res, 404, { ok: false, error: 'Not found' });
          } catch (err) {
            this.ctx.logger.error(`lead-worker api error: ${err.message}`);
            sendJson(res, 500, { ok: false, error: err.message, code: err.code });
          }
        }
      });
    });
  }

  persistStore() {
    mkdirSync(this.#store.directory, { recursive: true });
    const temporary = `${this.#store.file}.tmp`;
    const value = {
      configRevision: this.#configRevision,
      shared: this.#sharedConfig || this.config.defaultConfig || DEFAULT_TEAM_CONFIG,
      boards: Object.fromEntries(this.#sessionStates),
      sessionBoss: Object.fromEntries(this.#sessionBoss),
      sessionAutopilot: Object.fromEntries(this.#sessionAutopilot),
      automaticDispatchStopped: [...this.#automaticDispatchStopped],
      sessionRoutes: Object.fromEntries(this.#sessionRoutes),
    };
    writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
    renameSync(temporary, this.#store.file);
  }

  getConfig(sessionId) {
    if (!this.#sessionConfigs.has(sessionId)) {
      const base = this.#sharedConfig || this.config.defaultConfig || DEFAULT_TEAM_CONFIG;
      const members = [...base.members.filter(m => !m.id.startsWith('task-route-')), ...(this.#sessionRoutes.get(sessionId) || [])];
      this.#sessionConfigs.set(sessionId, { ...JSON.parse(JSON.stringify({ ...base, members })), bossDirect: this.#sessionBoss.get(sessionId) ?? false, autopilot: this.#sessionAutopilot.get(sessionId) ?? false });
    }
    return this.#sessionConfigs.get(sessionId);
  }

  recordRecoveryAudit(sessionId, record) {
    if (!this.#recoveryAudits.has(sessionId)) {
      this.#recoveryAudits.set(sessionId, []);
    }
    this.#recoveryAudits.get(sessionId).push({
      ...record,
      timestamp: new Date().toISOString()
    });
  }

  getRecoveryAudits(sessionId) {
    return this.#recoveryAudits.get(sessionId) || [];
  }

  async remindPendingReviews() {
    for (const [sessionId, board] of this.#boards) {
      if (board.snapshot().status !== 'ready') continue;
      const parent = this.ctx.get('agents')?.get(sessionId);
      if (parent?.status !== 'idle') continue;
      for (const task of board.snapshot().tasks.filter(t => t.status === 'review')) {
        await notifyParentReview({ ctx: this.ctx, sessionId, taskId: task.id, epoch: task.executionEpoch, board,
          outputText: task.result?.output || '', reportedFiles: task.result?.files || [],
          parentAgentOverride: parent, reminder: true });
      }
    }
  }

  async auditAndNotifyRecoveredReviews(sessionId, board) {
    if (!board) return [];
    const snap = board.snapshot();
    const reviewTasks = (snap.tasks || []).filter(t => t.status === 'review');
    const records = [];
    const proxyBoard = { snapshot: () => ({ ...snap, status: 'ready' }) };
    for (const rTask of reviewTasks) {
      try {
        const result = await notifyParentReview({
          ctx: this.ctx,
          sessionId,
          taskId: rTask.id,
          epoch: rTask.executionEpoch,
          board: proxyBoard,
          reportedFiles: rTask.result?.files || rTask.evidence?.files || [],
          outputText: rTask.result?.output || rTask.result?.summary || '',
          member: board.config.members.find(m => m.id === rTask.memberId),
          parentAgentOverride: this.#sessionExecs.get(sessionId)?.agent || null,
          childId: rTask.evidence?.dispatch?.childId || null
        });
        const rec = {
          action: 'recovered_review_notice',
          taskId: rTask.id,
          epoch: rTask.executionEpoch,
          delivered: Boolean(result?.delivered),
          reason: result?.reason || (result?.delivered ? 'OK' : 'UNKNOWN'),
          notifiedAt: new Date().toISOString()
        };
        records.push(rec);
        this.recordRecoveryAudit(sessionId, rec);
      } catch (err) {
        this.ctx.logger.warn(`重启补投任务 ${rTask.id} review 通知失败: ${err.message}`);
      }
    }
    return records;
  }

  async drainExecutions(sessionId, { timeoutMs = 3000 } = {}) {
    const entries = [...this.#activeExecutions.values()].filter(e => !sessionId || e.sessionId === sessionId);
    const pending = entries.filter(e => !e.settled);
    if (pending.length === 0) {
      return {
        drained: true,
        safe: true,
        timedOut: false,
        total: entries.length,
        settledCount: entries.length,
        pendingCount: 0,
        settledTasks: entries.map(e => ({ taskId: e.taskId, epoch: e.epoch })),
        pendingTasks: []
      };
    }

    let timer;
    const timeoutPromise = new Promise(resolve => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });
    const allSettledPromise = Promise.allSettled(pending.map(e => e.settlePromise)).then(() => ({ timedOut: false }));

    const race = await Promise.race([allSettledPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);

    const stillPending = entries.filter(e => !e.settled);
    const isTimedOut = Boolean(race.timedOut || stillPending.length > 0);
    const drained = !isTimedOut && stillPending.length === 0;

    return {
      drained,
      safe: drained, // 超时绝对不能报安全！
      safeToShutdown: drained,
      timedOut: isTimedOut,
      total: entries.length,
      settledCount: entries.filter(e => e.settled).length,
      pendingCount: stillPending.length,
      settledTasks: entries.filter(e => e.settled).map(e => ({ taskId: e.taskId, epoch: e.epoch })),
      pendingTasks: stillPending.map(e => ({
        taskId: e.taskId,
        epoch: e.epoch,
        durationMs: Date.now() - e.startedAt
      }))
    };
  }

  async notifyPhaseReview(sessionId, event = {}) {
    const board = this.#boards.get(sessionId);
    if (!board) return { delivered: false, reason: 'NO_BOARD' };
    const snap = board.snapshot();
    if (snap.status !== 'ready' && event.type === 'batch_settled') return { delivered: false, reason: 'BOARD_NOT_READY' };
    const batchId = snap.batchId || 1;

    const eventType = event.type || 'state_change';
    // Completion already has a dedicated review notice. Approval adds no new
    // work for the lead, and idle capacity alone is not actionable.
    if (eventType === 'task_completed') return { delivered: false, reason: 'COVERED_BY_REVIEW_NOTICE' };
    if (eventType === 'members_idle_or_blocked' &&
        (!snap.tasks.some(t => t.status === 'pending') || snap.tasks.some(t => t.status === 'review'))) {
      return { delivered: false, reason: 'NO_ACTIONABLE_PENDING_WORK' };
    }
    if (event.taskId && event.epoch !== undefined) {
      const task = snap.tasks.find(t => t.id === event.taskId);
      if (!task || task.executionEpoch !== event.epoch) return { delivered: false, reason: 'STALE_EVENT' };
    }
    let dedupeKey;
    if (event.taskId) {
      dedupeKey = `${sessionId}:${batchId}:${eventType}:${event.taskId}:${event.epoch ?? snap.tasks.find(t => t.id === event.taskId)?.executionEpoch ?? 0}:${event.status || ''}`;
    } else if (eventType === 'members_idle_or_blocked') {
      const blocked = (event.blockedTasks || []).map(t => t.id).sort().join(',');
      const idle = (event.idleMembers || []).map(m => m.id).sort().join(',');
      dedupeKey = `${sessionId}:${batchId}:idle_blocked:[idle:${idle}]:[blocked:${blocked}]`;
    } else {
      dedupeKey = `${sessionId}:${batchId}:${eventType}:${JSON.stringify(event.payload || {})}`;
    }

    if (this.#notifiedPhaseReviews.has(dedupeKey)) {
      return { delivered: false, reason: 'ALREADY_NOTIFIED', dedupeKey };
    }

    const liveAgent = this.ctx.get('agents')?.get(sessionId);
    const parent = liveAgent || this.#sessionExecs.get(sessionId)?.agent;
    if (!parent || typeof parent.followup !== 'function') {
      return { delivered: false, reason: 'NO_LIVE_PARENT_FOLLOWUP', dedupeKey };
    }

    const running = snap.tasks.filter(t => t.status === 'running');
    const review = snap.tasks.filter(t => t.status === 'review');
    const done = snap.tasks.filter(t => t.status === 'done');
    const pending = snap.tasks.filter(t => t.status === 'pending');
    const needsAttention = snap.tasks.filter(t => t.status === 'needs_attention');

    const desc = event.description || `阶段性状态变更 (${eventType})`;
    const noticeText = [
      `【阶段性复评通知: 请重新评估可执行工作】`,
      `- 触发事件: ${desc}`,
      `- 任务板批次: ${batchId} | 状态: ${snap.status} (已批准: ${snap.approved ? '是' : '否'})`,
      `- 任务总览: 总计 ${snap.tasks.length} 项 (进行中: ${running.length}, 待审查: ${review.length}, 已完成: ${done.length}, 待派发: ${pending.length}, 需人工关注: ${needsAttention.length})`,
      event.details ? `- 事件详情: ${event.details}` : '',
      ``,
      board.config.autopilot ? `【主控自动推进指令（托管授权内）】:` : `【主控复评建议（严守批准边界）】:`,
      `1. 当前出现了阶段性状态变化，请主控重新评估当前可执行工作；`,
      review.length > 0 ? `2. 现有 ${review.length} 项任务处于待审查阶段，请及时调用 lead_worker_review 验收；` : '',
      needsAttention.length > 0 ? `3. 现有 ${needsAttention.length} 项任务需人工关注，请核查现场并根据需要处理；` : '',
      board.config.autopilot ? `4. 全自动托管授权有效：先复用已通过的同版本证据核对用户总目标。只有明确未完成的目标才规划下一阶段，无需逐步审批；目标完成则总结结束。缺少授权、材料或测试失败则报告具体阻断，不得用重复审计代替解决。不得扩大目标，不得跳过必要验收。` : `4. ⚠️ 边界铁律：系统绝不自动扩大工作范围，绝不自动执行未获批准的任务！若需新任务或调整范围，必须使用 lead_worker_plan 提交规划并经用户明确批准。`
    ].filter(Boolean).join('\n');

    const message = createUserMessage({
      content: [{ type: 'text', text: noticeText }],
      source: {
        kind: 'coordination-phase-review',
        form: 'notice',
        summary: `阶段性复评通知: ${desc}`,
        senderSessionId: sessionId
      }
    });

    try {
      await parent.followup(message);
      this.#notifiedPhaseReviews.add(dedupeKey);
      this.ctx.logger.info(`已向父 Agent 投递阶段性复评通知: ${desc} (key=${dedupeKey})`);
      return { delivered: true, dedupeKey, eventType };
    } catch (err) {
      this.ctx.logger.warn(`投递阶段性复评通知失败: ${err.message}`);
      return { delivered: false, reason: 'FOLLOWUP_ERROR', error: err.message };
    }
  }

  getOrCreateBoard(sessionId) {
    const config = this.getConfig(sessionId);
    if (!config.enabled) return null;
    if (!this.#boards.has(sessionId)) {
      const savedState = this.#sessionStates.get(sessionId);
      let stateToRestore = savedState;
      if (savedState) {
        // 重启恢复现场原则：
        // 1. 不自动规划（保留既有任务列表）
        // 2. 不沿用批准（若包含未完成任务，重置 approved: false，状态置为 paused，防止自动执行未批准工作）
        const hasUnfinishedTasks = Array.isArray(savedState.tasks) && savedState.tasks.some(t => ['pending', 'running', 'needs_attention'].includes(t.status));
        if (hasUnfinishedTasks && savedState.approved) {
          stateToRestore = {
            ...savedState,
            approved: false,
            status: savedState.status === 'draft' ? 'draft' : 'paused'
          };
        }
      }
      const board = new TeamBoard(config, stateToRestore, state => {
        this.#sessionStates.set(sessionId, state);
        this.persistStore();
      });
      this.#boards.set(sessionId, board);
      // Persist restart recovery immediately; a second restart must not lose the recovery marker.
      this.#sessionStates.set(sessionId, board.snapshot());
      this.persistStore();

      // 重启后补投 review 通知并记录审计
      this.auditAndNotifyRecoveredReviews(sessionId, board).catch(err => {
        this.ctx.logger.warn(`重启补投审查通知异常: ${err.message}`);
      });
    }
    return this.#boards.get(sessionId);
  }

  _injectSessionState(sessionId, state) {
    this.#sessionStates.set(sessionId, state);
  }

  async scheduleReadyTasks(sessionId, exec, explicitTaskId = null) {
    const latestConfig = this.getConfig(sessionId);
    if (!explicitTaskId && this.#automaticDispatchStopped.has(sessionId) && !latestConfig.bossDirect && !latestConfig.autopilot) return [];
    const liveAgent = this.ctx.get('agents')?.get(sessionId);
    const parent = requireParent(sessionId, liveAgent ? { agent: liveAgent } : exec, this.ctx.get('agents'));
    // Do not retain a tool call's abort signal for background work or future resume.
    exec = { agent: parent, signal: new AbortController().signal };
    this.#sessionExecs.set(sessionId, exec);
    const board = this.getOrCreateBoard(sessionId);
    if (!board) return [];
    if (board.snapshot().status !== 'ready') return [];
    if ([...this.#activeExecutions.values()].some(active => active.sessionId === sessionId && active.signal.aborted)) return [];
    if (!board.snapshot().approved && !board.snapshot().tasks.some(t => t.status === 'pending' && board.isTaskExecutionApproved(t.id))) return [];
    // Apply newly added members when safe without altering in-flight work or locked choices.
    try {
      const latest = this.getConfig(sessionId);
      const activeIds = new Set(board.snapshot().tasks.filter(t => t.status === 'running').map(t => t.memberId));
      const oldMembers = board.config.members;
      const merged = latest.members.map(m => activeIds.has(m.id) ? oldMembers.find(old => old.id === m.id) : m);
      for (const old of oldMembers) if (activeIds.has(old.id) && !merged.some(m => m.id === old.id)) merged.push(old);
      board.reconfigure({ ...latest, members: merged });
    }
    catch (err) { this.ctx.logger.warn(`暂不应用新的角色配置: ${err.message}`); }
    board.balanceReadyAssignments();
    let snapshot = board.snapshot();

    // BOSS直派模式下，确保每个待执行任务都已有子模型成员；旧计划或用户只给单任务时也不能落回 lead/空分配。
    if (board.config.bossDirect === true || board.config.autopilot) {
      const workerPool = board.config.members.filter(m => m.enabled && !m.id.toLowerCase().includes('lead') && !m.role.toLowerCase().includes('主控') && !m.role.toLowerCase().includes('planner'));
      const fallbackPool = workerPool.length ? workerPool : board.config.members.filter(m => m.enabled);
      let next = 0;
      for (const task of snapshot.tasks.filter(t => t.status === 'pending' && !t.memberId)) {
        const candidate = fallbackPool.find((m, index) => !m.readOnly || task.readOnly || task.writeScopes.length === 0) || fallbackPool[next % Math.max(1, fallbackPool.length)];
        if (candidate) {
          try { board.assign(task.id, candidate.id, 'model'); } catch (err) { this.ctx.logger.warn(`BOSS直派自动分配 ${task.id} 失败: ${err.message}`); }
          next++;
        }
      }
      snapshot = board.snapshot();
    }
    if (board.config.autopilot && snapshot.tasks.length && snapshot.tasks.every(t => t.status === 'done')) {
      await this.notifyPhaseReview(sessionId, { type: 'batch_settled', payload: { tasks: snapshot.tasks.map(t => [t.id, t.executionEpoch]) }, description: '本批全部通过主控审查：先复用已有验收证据核对总目标；仅对明确未完成目标继续实施，不默认追加审计。存在阻断则报告缺口和所需授权；目标已达成则总结结束。' });
    }
    const running = snapshot.tasks.filter(t => t.status === 'running');
    const runningCount = running.length;
    const occupiedMembers = new Set(running.map(t => t.memberId));
    const scheduledScopes = [...running];
    const available = snapshot.tasks.filter(task => (!explicitTaskId || task.id === explicitTaskId) && task.status === 'pending' && task.memberId &&
      (snapshot.approved || board.isTaskExecutionApproved(task.id)) &&
      task.dependencies.every(id => snapshot.tasks.find(dep => dep.id === id)?.status === 'done') &&
      !occupiedMembers.has(task.memberId));
    const capacity = Math.max(0, board.config.maxParallel - runningCount);
    const started = [];
    const jobs = [];
    for (const task of available) {
      if (started.length >= capacity) break;
      // 用户点击暂停后，立即停止本轮后续新派发；已启动的任务继续由各自执行实例收尾。
      if (board.snapshot().status !== 'ready') break;
      const currentConfig = this.getConfig(sessionId);
      if (!explicitTaskId && this.#automaticDispatchStopped.has(sessionId) && !currentConfig.bossDirect && !currentConfig.autopilot) break;
      if (occupiedMembers.has(task.memberId) || this.#activeExecutions.has(`${sessionId}:${task.id}`)) continue;
      const member = board.config.members.find(m => m.id === task.memberId);
      const overlaps = scheduledScopes.some(other => {
        const otherMember = board.config.members.find(m => m.id === other.memberId);
        if (task.readOnly || member?.readOnly || other.readOnly || otherMember?.readOnly) return false;
        return task.writeScopes.some(a => other.writeScopes.some(b => {
          const norm = value => value.replace(/\\/g, '/').replace(/\/$/, '');
          const x = norm(a), y = norm(b);
          return x === '**' || y === '**' || x === '.' || y === '.' || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
        }));
      });
      if (overlaps) continue;
      try {
        board.start(task.id);
        occupiedMembers.add(task.memberId);
        scheduledScopes.push(task);
        started.push(task.id);
        jobs.push(this.dispatchTask(sessionId, task.id, exec)
          .catch(err => {
            this.ctx.logger.error(`自动派发 ${task.id} 失败: ${err.message}`);
            const current = board.snapshot().tasks.find(item => item.id === task.id);
            if (current?.status === 'running') {
              try { board.finish(task.id, { error: `Lead Worker 子模型启动失败: ${err.message}`, evidence: { dispatchStatus: 'failed', dispatchError: err.message } }, undefined, current.executionEpoch); } catch {}
            }
          })
          .finally(() => this.scheduleReadyTasks(sessionId, exec)));
      } catch (err) {
        this.ctx.logger.warn(`自动派发跳过 ${task.id}: ${err.message}`);
      }
    }
    if (jobs.length) this.#schedulerJobs.set(sessionId, Promise.all(jobs).finally(() => this.#schedulerJobs.delete(sessionId)));
    else if (available.length && capacity > 0) this.ctx.logger.warn(`BOSS直派暂无可启动任务: session=${sessionId}, pending=${available.map(t => `${t.id}:${t.memberId}`).join(',')}`);

    // 事件触发的阶段性复评通知：成员空闲或任务阻塞（去重且不自动执行未批准范围）
    const postSnap = board.snapshot();
    const stillPending = postSnap.tasks.filter(t => t.status === 'pending');
    const runningWorkers = new Set(postSnap.tasks.filter(t => t.status === 'running').map(t => t.memberId));
    const activeWorkers = board.config.members.filter(m => m.enabled && !m.id.toLowerCase().includes('lead') && !m.role.toLowerCase().includes('主控'));
    const idleWorkers = activeWorkers.filter(m => !runningWorkers.has(m.id));
    const blockedTasks = stillPending.filter(task => {
      return task.dependencies.some(id => postSnap.tasks.find(dep => dep.id === id)?.status !== 'done');
    });

    if (blockedTasks.length > 0 || (idleWorkers.length > 0 && postSnap.tasks.some(t => t.status !== 'running'))) {
      this.notifyPhaseReview(sessionId, {
        type: 'members_idle_or_blocked',
        blockedTasks,
        idleMembers: idleWorkers,
        description: `成员空闲 (${idleWorkers.length}人) 或任务阻塞 (${blockedTasks.length}项等待依赖)`
      }).catch(() => {});
    }

    return started;
  }

  async listAvailableModels() {
    const list = [];
    const llm = this.ctx.get('llm');
    if (llm) {
      try {
        const providers = llm.listProviders();
        for (const provider of providers) {
          const providerId = provider.id;
          try {
            const models = await llm.listModels(providerId);
            for (const m of (models || [])) {
              list.push({
                provider: providerId,
                model: m.id,
                name: m.name ? `${provider.name || providerId} / ${m.name}` : `${providerId}/${m.id}`,
                description: m.description || '',
              });
            }
          } catch (mErr) {
            if (provider.models && Array.isArray(provider.models)) {
              for (const m of provider.models) {
                list.push({
                  provider: providerId,
                  model: m.id,
                  name: m.name ? `${provider.name || providerId} / ${m.name}` : `${providerId}/${m.id}`,
                  description: m.description || '',
                });
              }
            }
          }
        }
      } catch (err) {
        this.ctx.logger.warn(`listAvailableModels warning: ${err.message}`);
      }
    }
    if (list.length === 0) {
      list.push(
        { provider: 'deepseek-official', model: 'deepseek-v4-pro', name: 'deepseek-official / DeepSeek V4 Pro' },
        { provider: 'deepseek-official', model: 'deepseek-flash', name: 'deepseek-official / DeepSeek Flash' }
      );
    }
    return list;
  }

  async handleAction(sessionId, action, params) {
    if (action === 'configureSession') {
      if (params.expectedConfigRevision !== undefined && params.expectedConfigRevision !== this.#configRevision) throw new Error('配置已被其他入口更新，请刷新后重试');
      const current = this.getConfig(sessionId);
      const next = new TeamBoard({ ...current, ...Object.fromEntries(['autopilot', 'bossDirect'].filter(key => Object.hasOwn(params, key)).map(key => [key, params[key]])) }).config;
      this.#boards.get(sessionId)?.reconfigure(next);
      this.#sessionBoss.set(sessionId, next.bossDirect);
      this.#sessionAutopilot.set(sessionId, next.autopilot);
      this.#sessionConfigs.set(sessionId, next);
      if (next.bossDirect || next.autopilot) this.#automaticDispatchStopped.delete(sessionId);
      else this.#automaticDispatchStopped.add(sessionId);
      this.#configRevision++;
      this.persistStore();
      if (next.autopilot && this.#boards.get(sessionId)?.snapshot().status === 'ready') await this.scheduleReadyTasks(sessionId, this.#sessionExecs.get(sessionId) || {});
      return { config: next, configRevision: this.#configRevision };
    }
    if (action === 'configure') {
      if (params.expectedConfigRevision !== undefined && params.expectedConfigRevision !== this.#configRevision) throw new Error('配置已被其他入口更新，请刷新后重试；未覆盖最新配置');
      const normalized = new TeamBoard(params.config).config;
      const newConfig = new TeamBoard({ ...normalized, members: normalized.members.filter(m => !m.id.startsWith('task-route-')) }).config;
      const existing = this.#boards.get(sessionId);
      const wasAutomatic = this.getConfig(sessionId).bossDirect || this.getConfig(sessionId).autopilot;
      const shared = value => ({ ...value, bossDirect: false, autopilot: false, members: value.members.filter(m => !m.id.startsWith('task-route-')) });
      if (JSON.stringify(shared(newConfig)) === JSON.stringify(shared(this.getConfig(sessionId)))) return this.handleAction(sessionId, 'configureSession', { bossDirect: newConfig.bossDirect, autopilot: newConfig.autopilot, expectedConfigRevision: params.expectedConfigRevision });
      const candidates = new Map();
      const sessionIds = new Set([sessionId, ...this.#sessionConfigs.keys(), ...this.#boards.keys(), ...this.#sessionStates.keys()]);
      // Validate every session before changing any config or board. A shared member
      // referenced by current or historical work cannot be removed silently.
      for (const id of sessionIds) {
        const board = this.#boards.get(id);
        const state = board?.snapshot() || this.#sessionStates.get(id);
        const members = [...newConfig.members, ...(this.#sessionRoutes.get(id) || [])];
        const previousMembers = board?.config.members || this.getConfig(id).members;
        let legacyOrphan = false;
        for (const task of [...(state?.tasks || []), ...(state?.archivedTasks || [])]) {
          if (task.memberId && !members.some(m => m.id === task.memberId)) {
            if (previousMembers.some(m => m.id === task.memberId)) throw new Error(`会话 ${id} 的任务 ${task.id} 仍引用成员 ${task.memberId}，不能删除共享成员`);
            // Already missing before this save, not a deletion by this user.
            // Preserve the snapshot; do not invent a model to restore it.
            legacyOrphan = true;
          }
        }
        // Preserve the original running member even when its shared model changes.
        const activeIds = new Set((state?.tasks || []).filter(t => t.status === 'running').map(t => t.memberId));
        const oldMembers = board?.config.members || this.getConfig(id).members;
        const merged = members.map(m => activeIds.has(m.id) ? (oldMembers.find(old => old.id === m.id) || m) : m);
        const candidate = { ...newConfig, members: merged, bossDirect: id === sessionId ? newConfig.bossDirect : this.#sessionBoss.get(id) ?? false, autopilot: id === sessionId ? newConfig.autopilot : this.#sessionAutopilot.get(id) ?? false };
        // Detached validation cannot quarantine or otherwise change the live board.
        if (state && !legacyOrphan) new TeamBoard(candidate, state);
        if (legacyOrphan) this.ctx.logger.warn(`会话 ${id} 含历史失效成员引用，保留原始任务快照；不阻止无关共享设置更新`);
        candidates.set(id, candidate);
      }
      this.#sessionBoss.set(sessionId, newConfig.bossDirect === true);
      this.#sessionAutopilot.set(sessionId, newConfig.autopilot === true);
      this.#sharedConfig = { ...newConfig, bossDirect: false, autopilot: false };
      for (const [id, candidate] of candidates) {
        this.#boards.get(id)?.reconfigure(candidate);
        this.#sessionConfigs.set(id, candidate);
      }
      const sessionConfig = candidates.get(sessionId);
      if (sessionConfig.bossDirect || sessionConfig.autopilot) this.#automaticDispatchStopped.delete(sessionId);
      else if (wasAutomatic) this.#automaticDispatchStopped.add(sessionId);
      if (!existing && newConfig.enabled) {
        const board = new TeamBoard(sessionConfig, this.#sessionStates.get(sessionId), state => {
          this.#sessionStates.set(sessionId, state);
          this.persistStore();
        });
        this.#boards.set(sessionId, board);
      }
      this.#configRevision++;
      this.persistStore();
      if (newConfig.autopilot && this.#boards.get(sessionId)?.snapshot().status === 'ready') {
        await this.scheduleReadyTasks(sessionId, this.#sessionExecs.get(sessionId) || {});
      }
      return { config: sessionConfig, configRevision: this.#configRevision };
    }

    const board = this.getOrCreateBoard(sessionId);
    if (!board) throw new Error('协作团队未启用');

    switch (action) {
      case 'plan': {
        const result = board.plan(params.tasks, params.by || 'user', params.expectedRevision);
        if (board.config.autopilot) await this.scheduleReadyTasks(sessionId, this.#sessionExecs.get(sessionId) || {});
        return board.config.autopilot ? board.snapshot() : result;
      }
      case 'append': {
        const result = board.appendTasks(params.tasks, params.by || 'user', params.expectedRevision);
        if (board.config.autopilot) await this.scheduleReadyTasks(sessionId, this.#sessionExecs.get(sessionId) || {});
        return board.config.autopilot ? board.snapshot() : result;
      }
      case 'assign':
        return board.assign(params.taskId, params.memberId, params.by || 'user', params.expectedRevision);
      case 'approve': {
        const result = board.approve('user', params.expectedRevision);
        if (board.config.bossDirect === true || board.config.autopilot) await this.scheduleReadyTasks(sessionId, this.#sessionExecs.get(sessionId) || { signal: new AbortController().signal, agent: undefined });
        return result;
      }
      case 'pause': {
        // 暂停只阻止后续新派发，不终止已经运行的子模型。
        return board.pause(params.expectedRevision);
      }
      case 'interrupt': {
        const result = board.interrupt();
        for (const active of this.#activeExecutions.values()) if (active.sessionId === sessionId) active.controller.abort(new Error('用户中断批次'));
        const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 3000;
        const drainResult = await this.drainExecutions(sessionId, { timeoutMs });
        return {
          ...result,
          drained: drainResult.drained,
          safe: drainResult.safe,
          timedOut: drainResult.timedOut,
          drain: drainResult
        };
      }
      case 'shutdown': {
        if (board.snapshot().status !== 'paused') {
          board.pause(params.expectedRevision);
        }
        for (const active of this.#activeExecutions.values()) {
          if (active.sessionId === sessionId) {
            active.controller.abort(new Error('下班停工：中断执行'));
          }
        }
        const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 3000;
        const drainResult = await this.drainExecutions(sessionId, { timeoutMs });

        const snap = board.snapshot();
        const runningTasks = snap.tasks.filter(t => t.status === 'running');
        if (runningTasks.length > 0) {
          try {
            board.interrupt('SHUTDOWN');
          } catch (e) {
            this.ctx.logger.warn(`下班停工标记中断失败: ${e.message}`);
          }
        }

        const finalSnap = board.snapshot();
        const hasGhostRunning = finalSnap.tasks.some(t => t.status === 'running');
        const persistenceVerified = !hasGhostRunning;

        const shutdownAt = new Date().toISOString();
        const shutdownRecord = {
          shutdownAt,
          safe: drainResult.safe && persistenceVerified,
          drained: drainResult.drained,
          timedOut: drainResult.timedOut,
          pendingTasks: drainResult.pendingTasks || [],
          requiresUserApprovalOnRestart: true
        };
        finalSnap.recovery = {
          interruptedAt: shutdownAt,
          reason: 'SHUTDOWN',
          shutdownRecord
        };

        this.#sessionStates.set(sessionId, finalSnap);
        this.persistStore();

        return {
          ok: true,
          action: 'shutdown',
          status: finalSnap.status,
          drained: drainResult.drained,
          safe: drainResult.safe && persistenceVerified,
          safeToShutdown: drainResult.safe && persistenceVerified,
          timedOut: drainResult.timedOut,
          drain: drainResult,
          shutdownConditions: {
            allExecutionsDrained: drainResult.drained,
            persistenceVerified,
            noPendingWrites: drainResult.safe,
            safe: drainResult.safe && persistenceVerified,
            summary: (drainResult.safe && persistenceVerified)
              ? '全部执行实例已安全排空，持久化核查通过，满足安全关机条件。'
              : '执行实例排空超时或存在未完成写入，已保存检查点，不满足完全安全关机条件（超时不能报安全）。'
          },
          structuredNotice: {
            title: '下班停工结算结果',
            safe: drainResult.safe && persistenceVerified,
            notice: '现场已安全归档持久化。重启后将自动补投 review 通知并恢复现场，不自动规划、不沿用批准；必须经用户确认后方可 resume/recover，防止旧 epoch 写回。'
          },
          board: finalSnap
        };
      }
      case 'selectTaskModel': {
        const task = board.snapshot().tasks.find(t => t.id === params.taskId);
        if (!task || !['pending', 'needs_attention'].includes(task.status)) throw new Error('仅待执行或失败中断任务可以切换模型');
        const catalog = await this.listAvailableModels();
        if (!catalog.some(m => m.provider === params.provider && m.model === params.model)) throw new Error('所选模型不在可用模型目录中');
        const latestTask = board.snapshot().tasks.find(t => t.id === params.taskId);
        if (!latestTask || !['pending', 'needs_attention'].includes(latestTask.status)) throw new Error('任务状态已变化，请刷新后再切换模型');
        const config = this.getConfig(sessionId);
        const base = config.members.find(m => m.id === latestTask.memberId);
        if (!base) throw new Error('请先选择执行成员');
        const id = `task-route-${sessionId}-${task.id}`;
        const member = { ...base, id, name: `${task.title} · 专用模型`, provider: params.provider, model: params.model };
        const routes = [...(this.#sessionRoutes.get(sessionId) || []).filter(m => m.id !== id), member];
        const nextConfig = { ...config, members: [...config.members.filter(m => m.id !== id), member] };
        board.reconfigure(nextConfig);
        this.#sessionRoutes.set(sessionId, routes);
        this.#sessionConfigs.set(sessionId, nextConfig);
        // Persist through assign's board callback, without the global configure
        // path or its autopilot scheduler. Dispatch remains an explicit action.
        return board.assign(task.id, id, 'user');
      }
      case 'dispatchTask': {
        // Explicit UI dispatch still goes through board.start approval/dependency
        // checks. Never auto-recover interrupted tasks or bypass retry limits.
        const exec = this.#sessionExecs.get(sessionId) || { signal: new AbortController().signal, agent: this.ctx.get('agents')?.get(sessionId) };
        const work = this.dispatchTask(sessionId, params.taskId, exec, params.userTaskApproval === true);
        // Allow synchronous preflight/start to settle without holding HTTP open
        // for the entire model execution.
        await Promise.resolve();
        const task = board.snapshot().tasks.find(t => t.id === params.taskId);
        if (task?.status !== 'running') return await work;
        work.catch(err => this.ctx.logger.warn(`手动派发失败: ${err.message}`));
        return { taskId: params.taskId, status: 'running', summary: '已开始派发，请在任务列表查看进度' };
      }
      case 'retryExecution': {
        const snap = board.snapshot();
        const task = snap.tasks.find(t => t.id === params.taskId);
        if (!task || !['pending', 'needs_attention'].includes(task.status)) throw new Error('仅待执行或中断失败任务可以重试');
        if (!['ready', 'paused'].includes(snap.status)) throw new Error('任务板正在停工或已结束，暂不能重试');
        // This explicit button action authorizes only this task, not the batch.
        if (task.waitingReason === 'RETRY_LIMIT_REACHED') throw new Error('返工上限已达，请先明确授权继续返工');
        if (snap.status === 'paused') board.resume();
        if (task.status === 'needs_attention') {
          board.recoverTask(task.id, '用户点击恢复/重试，授权按已配置子模型重新执行；尚未核查现场，执行子模型必须先核查文件与测试并保留已有成果。', 'user');
        }
        return this.handleAction(sessionId, 'dispatchTask', { taskId: task.id, userTaskApproval: true });
      }
      case 'recoverTask': {
        const result = board.recoverTask(params.taskId, params.continuationNote, 'user');
        if (board.config.bossDirect === true || board.config.autopilot) {
          await this.scheduleReadyTasks(sessionId, this.#sessionExecs.get(sessionId) || { signal: new AbortController().signal, agent: undefined });
          return board.snapshot();
        }
        return result;
      }
      case 'checkpoint':
        return board.checkpointTask(params.taskId, params.note);
      case 'resume': {
        const result = board.resume(params.expectedRevision);
        if (board.config.autopilot && !board.snapshot().approved) board.approve('user');
        // 1. 补投递处于 review 状态的任务（同 epoch 去重，防止暂停期间完成的任务卡死）
        const snap = board.snapshot();
        const reviewTasks = snap.tasks.filter(t => t.status === 'review');
        for (const rTask of reviewTasks) {
          try {
            await notifyParentReview({
              ctx: this.ctx,
              sessionId,
              taskId: rTask.id,
              epoch: rTask.executionEpoch,
              board,
              reportedFiles: rTask.result?.files || [],
              outputText: rTask.result?.output || '',
              member: board.config.members.find(m => m.id === rTask.memberId),
              parentAgentOverride: this.#sessionExecs.get(sessionId)?.agent || null,
              childId: rTask.evidence?.dispatch?.childId || null
            });
          } catch (notifyErr) {
            this.ctx.logger?.warn?.(`[resume] 补投递任务 ${rTask.id} 审查通知异常: ${notifyErr.message}`);
          }
        }
        // HTTP 按钮没有 agent exec；用内部最小执行上下文恢复 BOSS 直派调度。
        if (board.config.bossDirect === true || board.config.autopilot) {
          const resumeExec = { signal: new AbortController().signal, agent: this.#sessionExecs.get(sessionId)?.agent || undefined };
          await this.scheduleReadyTasks(sessionId, this.#sessionExecs.get(sessionId) || resumeExec);
        }
        return result;
      }
      case 'cancel':
        return board.cancel(params.expectedRevision);
      case 'cancelTask':
        return board.cancelTask(params.taskId, params.expectedRevision);
      case 'reset': {
        const config = this.getConfig(sessionId);
        const board = new TeamBoard(config, undefined, state => {
          this.#sessionStates.set(sessionId, state);
          this.persistStore();
        });
        this.#boards.set(sessionId, board);
        this.#sessionStates.set(sessionId, board.snapshot());
        this.persistStore();
        return { ok: true, reset: true };
      }
      case 'retry': {
        const result = params.continueAfterLimit
          ? board.continueAfterRetryLimit(params.taskId, 'user', params.expectedRevision)
          : board.retry(params.taskId, 'user', params.expectedRevision);
        if (board.config.bossDirect === true || board.config.autopilot) {
          await this.scheduleReadyTasks(sessionId, this.#sessionExecs.get(sessionId) || { signal: new AbortController().signal, agent: undefined });
          return board.snapshot();
        }
        return result;
      }
      case 'review': {
        const boardTask = board.snapshot().tasks.find(t => t.id === params.taskId);
        let reviewFeedback = params.feedback ?? '';
        if (boardTask) {
          try {
            const submission = {
              ...(boardTask.result && typeof boardTask.result === 'object' ? boardTask.result : {}),
              ...(boardTask.evidence && typeof boardTask.evidence === 'object' ? boardTask.evidence : {}),
              touchedFiles: boardTask.evidence?.files || boardTask.result?.files || [],
              modifiedFiles: boardTask.evidence?.files || boardTask.result?.files || [],
              testRuns: boardTask.evidence?.tests || (boardTask.result && Array.isArray(boardTask.result.testRuns) ? boardTask.result.testRuns : []),
              executionEpoch: boardTask.executionEpoch,
              deliverables: boardTask.deliverables || []
            };
            const gate = evaluateQualityGate({ ...boardTask, maxRetries: board.config.maxRetries }, submission, { maxRetries: board.config.maxRetries, reviewPassed: params.passed });
            if (gate && gate.summary) {
              reviewFeedback = reviewFeedback.trim()
                ? `${gate.summary}\n\n【主控审查意见】\n${reviewFeedback.trim()}`
                : gate.summary;
            }
          } catch (gateErr) {
            this.ctx.logger?.warn?.(`审查验收把关评估异常: ${gateErr.message}`);
          }
        }
        const reviewResult = board.review(params.taskId, params.passed, reviewFeedback, params.expectedRevision);
        this.notifyPhaseReview(sessionId, {
          type: params.passed ? 'task_completed' : 'task_failed',
          taskId: params.taskId,
          status: params.passed ? 'done' : 'needs_attention',
          description: `任务 ${params.taskId} 审查${params.passed ? '通过' : '未通过退回返工'}`
        }).catch(() => {});
        if (board.config.autopilot || board.config.bossDirect || board.isTaskExecutionApproved(params.taskId)) {
          await this.scheduleReadyTasks(sessionId, this.#sessionExecs.get(sessionId) || {});
        }
        return reviewResult;
      }
      default:
        throw new Error(`未知操作: ${action}`);
    }
  }

  async dispatchTask(sessionId, taskId, exec, userTaskApproval = false) {
    const board = this.getOrCreateBoard(sessionId);
    if (!board) throw new Error('Board 不存在');

    if ([...this.#activeExecutions.values()].some(active => active.sessionId === sessionId && active.signal.aborted)) throw new Error('中断中的执行实例尚未退出，请等待停止后再续做');
    const before = board.snapshot();
    const candidate = before.tasks.find(t => t.id === taskId);
    if (candidate?.status !== 'running') {
      const blocked = (candidate?.dependencies || []).map(id => before.tasks.find(t => t.id === id)).filter(t => !t || t.status !== 'done');
      if (blocked.length) {
        const labels = { pending: '待执行', running: '执行中', review: '待主控审查', needs_attention: '执行失败或中断，需恢复', cancelled: '已取消', failed: '失败' };
        throw new Error(`暂不能启动：前置任务尚未通过验收：${blocked.map(t => t ? `“${t.title || t.id}”（${labels[t.status] || t.status}）` : '缺失的前置任务').join('、')}。请先完成并由主控审查通过，之后才能继续本任务。`);
      }
      board.start(taskId, undefined, userTaskApproval);
    }
    const snap = board.snapshot();
    const task = snap.tasks.find(t => t.id === taskId);
    const member = board.config.members.find(m => m.id === task.memberId);
    if (!member) throw new Error(`任务 ${taskId} 未找到已分配的子模型成员 ${task.memberId || '(空)'}`);
    const key = `${sessionId}:${taskId}`;
    if (this.#activeExecutions.has(key)) return { taskId, status: 'running', summary: '已有执行实例；未重复启动' };
    const controller = new AbortController();
    const signal = exec.signal ? AbortSignal.any([exec.signal, controller.signal]) : controller.signal;
    let markSettled;
    const settlePromise = new Promise(resolve => { markSettled = resolve; });
    const executionEntry = {
      sessionId,
      taskId,
      controller,
      signal,
      epoch: task.executionEpoch,
      run: null,
      settled: false,
      settlePromise,
      markSettled,
      startedAt: Date.now()
    };
    this.#activeExecutions.set(key, executionEntry);
    const epoch = task.executionEpoch;
    this.ctx.logger.info(`BOSS直派准备启动子模型: task=${task.id}, member=${member.name}, provider=${member.provider}, model=${member.model}`);

    const depSummaries = (task.dependencies || []).map(depId => {
      const depTask = snap.tasks.find(t => t.id === depId);
      if (!depTask) return null;
      const files = Array.isArray(depTask.result?.files) ? depTask.result.files.join(', ') : '';
      const out = typeof depTask.result?.output === 'string' ? depTask.result.output.slice(0, 500) : '';
      return `- 前置任务 [${depTask.title || depId}] (${depTask.status}):\n  产出文件: ${files || '无'}\n  执行摘要: ${out || '完成'}`;
    }).filter(Boolean);
    const depSection = depSummaries.length ? `【前置依赖任务成果与产出】:\n${depSummaries.join('\n')}\n` : '';

    const promptText = `
你已被分配执行以下协作子任务：
【任务标题】: ${task.title}
【任务说明】: ${task.instructions}
【验收标准】: ${Array.isArray(task.acceptance) ? task.acceptance.join('; ') : task.acceptance}
${task.writeScopes?.length ? `【允许写文件范围】: ${task.writeScopes.join(', ')}` : ''}
${depSection}${task.reviewHistory?.length ? `【历次验收/返工记录（逐条处理，不得遗漏）】:\n${task.reviewHistory.map((r, i) => `${i + 1}. ${r.passed ? '通过' : '未通过'}：${r.feedback || '(未提供文字意见)'}`).join('\n')}` : ''}
${task.feedback ? `【最近一次返工要求】: ${task.feedback}` : ''}
${task.checkpoint ? `【已确认续做记录】: ${task.checkpoint.note}\n先核查文件差异和测试，保留已有成果，不盲目覆盖或重复执行。` : ''}
${task.result ? `【上次保留结果】: ${JSON.stringify(task.result)}` : ''}
【执行代次】: ${epoch}；最终报告必须列出已完成、未完成、实际修改文件、测试命令与结果、下一步。

请认真完成上述工作，提供改动成果、涉及文件以及验证结果。
`;

    try {
      const subagents = this.ctx.get('subagents');
      if (!subagents) throw new Error('Subagent service unavailable');

      const parentAgent = requireParent(sessionId, exec, this.ctx.get('agents'));
      const request = {
        label: `[Team ${member.name}] ${task.title}`,
        prompt: [{ type: 'text', text: promptText }],
        agentOptions: {
          provider: member.provider,
          model: member.model,
        },
        persona: member.instructions,
        signal,
        parent: parentAgent,
      };

      const run = await subagents.start('spawn', request);
      executionEntry.run = run;
      executionEntry.childId = run.id || null;
      const dispatch = { memberId: member.id, memberName: member.name, provider: member.provider, model: member.model, childId: run.id || null, label: request.label };
      board.recordDispatch(taskId, dispatch, epoch);
      this.ctx.logger.info(`BOSS直派子模型已启动: task=${task.id}, child=${run.id || '(未知)'}, route=${member.provider}/${member.model}`);
      // 先等待真实子模型返回；在此期间任务板保持 running，UI 可明确显示“执行中”。
      let result;
      try {
        result = await run.result;
        const actual = run.localAgent?.session?.requestHeader?.()?.config;
        dispatch.actualProvider = actual?.provider || null;
        dispatch.actualModel = actual?.model || null;
        dispatch.routeVerified = Boolean(actual?.provider === member.provider && actual?.model === member.model);
        if (actual && !dispatch.routeVerified) throw new Error(`子模型实际路由不匹配: 请求 ${member.provider}/${member.model}，实际 ${actual.provider}/${actual.model}`);
      }
      finally {
        await run.dispose();
        executionEntry.settled = true;
        markSettled({ taskId, epoch, status: 'settled', stopReason: result?.stopReason });
      }
      if (result?.stopReason !== 'completed') {
        const detail = typeof result?.error === 'string' ? result.error : result?.error?.message;
        throw new Error(`子模型未正常完成: ${result?.stopReason || '无完成状态'}${detail ? ` · ${detail}` : ''}`);
      }
      const outputText = (result?.output || []).map(b => b.text || '').join('\n') || '任务已执行完成';
      const reportedFiles = Array.isArray(result?.files) ? result.files : [];
      const outside = reportedFiles.filter(file => !task.writeScopes?.some(scope => {
        const base = scope.replace(/\\/g, '/').replace(/\/$/, '');
        const path = String(file).replace(/\\/g, '/');
        return base === '**' || base === '.' || path === base || path.startsWith(`${base}/`);
      }));
      const safeOutput = outside.length
        ? `${outputText}\n\n[范围核查提示] 子模型报告的文件超出 writeScopes: ${outside.join(', ')}`
        : outputText;

      let taskEvidence = null;
      if (result && typeof result === 'object' && result.evidence && typeof result.evidence === 'object') {
        try {
          taskEvidence = normalizeEvidence(result.evidence, 'evidence');
        } catch {
          taskEvidence = result.evidence;
        }
      } else {
        taskEvidence = {
          summary: outputText.slice(0, 500),
          files: reportedFiles,
          tests: Array.isArray(result?.testRuns) ? result.testRuns : (Array.isArray(result?.testResults) ? result.testResults : []),
          deliverables: Array.isArray(result?.deliverables) ? result.deliverables : [],
          unfinished: Array.isArray(result?.unfinished) ? result.unfinished : [],
          risks: Array.isArray(result?.risks) ? result.risks : [],
          metrics: null,
        };
      }

      board.finish(taskId, {
        output: safeOutput,
        files: reportedFiles,
        provider: member.provider,
        model: member.model,
        evidence: {
          ...taskEvidence,
          dispatchStatus: 'completed',
          dispatch,
        }
      }, undefined, epoch);

      // 子模型完成交付并进入 review 后，唤醒主控会话执行把关审查
      try {
        await notifyParentReview({
          ctx: this.ctx,
          sessionId,
          taskId,
          epoch,
          board,
          reportedFiles,
          outputText: safeOutput,
          member,
          parentAgentOverride: exec?.agent || null,
          childId: dispatch?.childId || run.id || null
        });
      } catch (notifyErr) {
        this.ctx.logger?.warn?.(`向主控会话投递审查通知失败 (非阻塞): ${notifyErr.message}`);
      }

      // Completion already has a task-specific review notice; do not wake the
      // parent a second time with a generic next-phase planning instruction.

      return { taskId, status: 'review', summary: outputText.slice(0, 300) };
    } catch (err) {
      executionEntry.settled = true;
      markSettled({ taskId, epoch, status: 'failed', error: err.message });
      const current = board.snapshot().tasks.find(t => t.id === taskId);
      if (current?.status === 'running' && current.executionEpoch === epoch) {
        if (signal.aborted) board.interrupt('EXECUTION_ABORTED', taskId);
        else board.finish(taskId, { error: err.message, evidence: { dispatchStatus: 'failed', dispatchError: err.message, dispatch: current.evidence?.dispatch || { memberId: member.id, memberName: member.name, provider: member.provider, model: member.model } } }, undefined, epoch);
      }
      this.notifyPhaseReview(sessionId, {
        type: 'task_failed',
        taskId,
        epoch,
        status: 'needs_attention',
        description: `任务 [${task.title}] 执行失败: ${err.message}`
      }).catch(() => {});
      if (err.code === 'STALE_EXECUTION' || signal.aborted) return { taskId, status: 'needs_attention', summary: '执行已中断或结果已过期；核查现场后续做' };
      throw err;
    } finally {
      executionEntry.settled = true;
      markSettled({ taskId, epoch, status: 'disposed' });
      this.#activeExecutions.delete(key);
      // Manual dispatch also needs a pump after disposal: a fast lead review
      // may have arrived while this execution key was still reserved.
      this.scheduleReadyTasks(sessionId, exec).catch(err => this.ctx.logger.warn(`执行结算后调度失败: ${err.message}`));
    }
  }
}

export function apply(ctx, config) {
  ctx.plugin(LeadWorkerHostService, config);
}
