// Pure, dependency-free task orchestration. No agents, clocks, filesystem or I/O.
import { checkPlanningQuality } from './quality-gates.mjs';
const ACTORS = new Set(['user', 'model']);
const TASK_STATUSES = new Set(['pending', 'running', 'review', 'done', 'failed', 'cancelled', 'needs_attention']);
const BOARD_STATUSES = new Set(['draft', 'ready', 'paused', 'cancelled', 'draining', 'drained']);
const OWN = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export class BoardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BoardError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new BoardError(code, message); };
const assert = (condition, code, message) => { if (!condition) fail(code, message); };
function object(value, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  'INVALID_INPUT', `${label} must be a plain object`);
}
function keys(value, allowed, label) {
  object(value, label);
  for (const key of Reflect.ownKeys(value)) {
    assert(typeof key === 'string' && allowed.includes(key), 'INVALID_INPUT', `${label}: unknown field ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert(descriptor && 'value' in descriptor && descriptor.enumerable, 'INVALID_INPUT', `${label}: only enumerable data fields are supported`);
  }
}
function text(value, label, empty = false) {
  assert(typeof value === 'string' && (empty || value.trim().length > 0), 'INVALID_INPUT', `${label} must be ${empty ? 'a' : 'a nonempty'} string`);
  return value;
}
function bool(value, label) {
  assert(typeof value === 'boolean', 'INVALID_INPUT', `${label} must be boolean`);
  return value;
}
function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  assert(Number.isSafeInteger(value) && value >= minimum && value <= maximum, 'INVALID_INPUT', `${label} must be a safe integer between ${minimum} and ${maximum}`);
  return value;
}
function strings(value, label) {
  assert(Array.isArray(value), 'INVALID_INPUT', `${label} must be an array`);
  const result = Array.from(value, (v) => text(v, label));
  assert(new Set(result).size === result.length, 'INVALID_INPUT', `${label} must not contain duplicates`);
  return result;
}
function json(value, label = 'value', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  assert(typeof value === 'object' && value !== null, 'INVALID_INPUT', `${label} must contain only JSON values`);
  assert(!seen.has(value), 'INVALID_INPUT', `${label} must not be cyclic`);
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    assert(Object.keys(value).length === value.length, 'INVALID_INPUT', `${label} must be a dense JSON array`);
    result = Array.from(value, (v) => json(v, label, seen));
  } else {
    object(value, label);
    result = {};
    for (const key of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      assert(typeof key === 'string' && d.enumerable && 'value' in d, 'INVALID_INPUT', `${label} must contain only JSON data fields`);
      Object.defineProperty(result, key, { value: json(d.value, label, seen), enumerable: true, writable: true, configurable: true });
    }
  }
  seen.delete(value);
  return result;
}
function actor(value) {
  assert(ACTORS.has(value), 'INVALID_INPUT', 'actor must be user or model');
}
function normalizeConfig(input) {
  keys(input, ['enabled', 'mode', 'leadPrompt', 'members', 'maxParallel', 'maxRetries', 'confirmPlan', 'askApprovalPrompt', 'bossDirect', 'autopilot'], 'config');
  const enabled = bool(input.enabled, 'config.enabled');
  assert(['auto', 'manual', 'mixed'].includes(input.mode), 'INVALID_INPUT', 'invalid team mode');
  const leadPrompt = OWN(input, 'leadPrompt') ? text(input.leadPrompt, 'config.leadPrompt', true) : '';
  assert(Array.isArray(input.members) && input.members.length > 0, 'INVALID_INPUT', 'members must be a nonempty array');
  const members = Array.from(input.members, (m) => {
    keys(m, ['id', 'name', 'provider', 'model', 'role', 'instructions', 'enabled', 'readOnly'], 'member');
    return {
      id: text(m.id, 'member.id'), name: text(m.name, 'member.name'),
      provider: text(m.provider, 'member.provider'), model: text(m.model, 'member.model'),
      role: text(m.role, 'member.role'), instructions: text(m.instructions, 'member.instructions', true),
      enabled: bool(m.enabled, 'member.enabled'), readOnly: bool(m.readOnly, 'member.readOnly'),
    };
  });
  assert(new Set(members.map((m) => m.id)).size === members.length, 'INVALID_INPUT', 'member IDs must be unique');
  const askApprovalPrompt = OWN(input, 'askApprovalPrompt') ? bool(input.askApprovalPrompt, 'askApprovalPrompt') : true;
  const bossDirect = OWN(input, 'bossDirect') ? bool(input.bossDirect, 'bossDirect') : false;
  return { enabled, mode: input.mode, leadPrompt, members, maxParallel: integer(input.maxParallel, 'maxParallel', 1, 1000),
    maxRetries: integer(input.maxRetries, 'maxRetries', 0, 1000), confirmPlan: bool(input.confirmPlan, 'confirmPlan'), askApprovalPrompt, bossDirect, autopilot: OWN(input, 'autopilot') ? bool(input.autopilot, 'autopilot') : false };
}
const TASK_FIELDS = ['id', 'title', 'instructions', 'acceptance', 'memberId', 'locked', 'dependencies', 'writeScopes', 'readOnly', 'status', 'retries', 'taskType', 'deliverables', 'phase', 'evidence'];
const STORED_FIELDS = [...TASK_FIELDS, 'result', 'feedback', 'reviewHistory', 'waitingReason', 'executionEpoch', 'checkpoint', 'executionHistory', 'executionApproval', 'extraRetryCredit'];
const VALID_TASK_TYPES = Object.freeze(['code', 'test', 'analysis', 'review', 'doc', 'general']);
const VALID_PHASES = Object.freeze(['planned', 'ready', 'running', 'verifying', 'completed', 'failed', 'blocked']);
const STATUS_TO_PHASE_MAP = Object.freeze({
  pending: 'ready',
  running: 'running',
  review: 'verifying',
  done: 'completed',
  failed: 'failed',
  needs_attention: 'blocked',
  cancelled: 'failed',
});
function normalizeTask(input, restored = false) {
  keys(input, restored ? STORED_FIELDS : TASK_FIELDS, 'task');
  const status = OWN(input, 'status') ? input.status : 'pending';
  const retries = OWN(input, 'retries') ? integer(input.retries, 'task.retries') : 0;
  assert(TASK_STATUSES.has(status), 'INVALID_INPUT', 'invalid task status');
  if (!restored) assert(status === 'pending' && retries === 0, 'INVALID_INPUT', 'new tasks must be pending with zero retries');
  const acceptance = Array.isArray(input.acceptance)
    ? strings(input.acceptance, 'task.acceptance') : text(input.acceptance, 'task.acceptance');
  assert(!Array.isArray(acceptance) || acceptance.length > 0, 'INVALID_INPUT', 'acceptance criteria must not be empty');
  const memberId = !OWN(input, 'memberId') || input.memberId === null ? null : text(input.memberId, 'task.memberId');
  const readOnly = OWN(input, 'readOnly') ? bool(input.readOnly, 'task.readOnly') : false;
  const writeScopes = OWN(input, 'writeScopes') ? strings(input.writeScopes, 'task.writeScopes') : [];

  let taskType;
  if (OWN(input, 'taskType')) {
    taskType = text(input.taskType, 'task.taskType');
    assert(VALID_TASK_TYPES.includes(taskType), 'INVALID_TYPE', 'invalid taskType');
  } else {
    taskType = readOnly ? 'analysis' : (writeScopes.length > 0 ? 'code' : 'general');
  }

  let deliverables = [];
  if (OWN(input, 'deliverables')) {
    assert(Array.isArray(input.deliverables), 'INVALID_INPUT', 'task.deliverables must be an array');
    deliverables = json(input.deliverables, 'task.deliverables');
  }

  let phase;
  if (OWN(input, 'phase')) {
    phase = text(input.phase, 'task.phase');
    assert(VALID_PHASES.includes(phase), 'INVALID_INPUT', 'invalid task.phase');
  } else {
    phase = STATUS_TO_PHASE_MAP[status] || 'planned';
  }

  let evidence = null;
  if (OWN(input, 'evidence') && input.evidence !== null) {
    evidence = json(input.evidence, 'task.evidence');
  }

  const task = {
    id: text(input.id, 'task.id'), title: text(input.title, 'task.title'),
    instructions: text(input.instructions, 'task.instructions'), acceptance, memberId,
    locked: OWN(input, 'locked') ? bool(input.locked, 'task.locked') : false,
    dependencies: OWN(input, 'dependencies') ? strings(input.dependencies, 'task.dependencies') : [],
    writeScopes,
    readOnly,
    status, retries,
    taskType, deliverables, phase, evidence,
    result: restored && OWN(input, 'result') ? json(input.result, 'task.result') : null,
    feedback: restored && OWN(input, 'feedback') ? text(input.feedback, 'task.feedback', true) : '',
    reviewHistory: restored && OWN(input, 'reviewHistory') ? json(input.reviewHistory, 'task.reviewHistory') : [],
    waitingReason: restored && OWN(input, 'waitingReason') ? text(input.waitingReason, 'task.waitingReason', true) : '',
    executionEpoch: restored && OWN(input, 'executionEpoch') ? integer(input.executionEpoch, 'executionEpoch') : 0,
    checkpoint: restored && OWN(input, 'checkpoint') ? json(input.checkpoint) : null,
    executionHistory: restored && OWN(input, 'executionHistory') ? json(input.executionHistory) : [],
    executionApproval: restored && typeof input.executionApproval === 'string' ? input.executionApproval : null,
    extraRetryCredit: restored && OWN(input, 'extraRetryCredit') ? integer(input.extraRetryCredit, 'extraRetryCredit', 0, 1) : 0,
  };
  assert(!task.locked || task.memberId !== null, 'INVALID_INPUT', 'a locked task must have a member');
  assert(!task.readOnly || task.writeScopes.length === 0, 'INVALID_INPUT', 'read-only tasks cannot declare write scopes');
  return task;
}

/**
 * All successful mutations return a detached snapshot and advance revision once.
 * expectedRevision is optional; supply it for CAS. Actor is a trusted caller claim,
 * not authentication. Failed operations never mutate state.
 * snapshot() is JSON-serializable; restore with new TeamBoard(config, snapshot).
 */
export class TeamBoard {
  #config;
  #state;
  #onChange;
  constructor(config, state, onChange) {
    this.#config = normalizeConfig(config);
    this.#onChange = typeof onChange === 'function' ? onChange : null;
    this.#state = { version: 1, revision: 0, status: 'draft', approved: false, tasks: [], archivedTasks: [], batchId: 1, planning: null };
    if (state !== undefined) this.#restore(state);
  }
  reconfigure(config) {
    const next = normalizeConfig(config);
    // Preserve task history and live state. Active assignments must remain valid.
    for (const task of this.#state.tasks.filter(t => !['done', 'cancelled', 'failed'].includes(t.status))) {
      if (task.memberId === null) continue;
      const member = next.members.find(m => m.id === task.memberId && m.enabled);
      const alreadyUnavailable = !this.#config.members.some(m => m.id === task.memberId && m.enabled);
      if (!member && alreadyUnavailable) continue;
      assert(member, 'INVALID_MEMBER', `任务 ${task.id} 的成员仍在使用中，不能删除或禁用`);
      assert(!member.readOnly || task.writeScopes.length === 0, 'READ_ONLY', `任务 ${task.id} 需要写入权限`);
    }
    const modeChanged = this.#config.autopilot !== next.autopilot;
    this.#config = next;
    if (modeChanged && this.#state.tasks.length) {
      this.#invalidateApproval();
      return this.#commit();
    }
    return this.snapshot();
  }
  get config() { return json(this.#config); }
  snapshot() {
    const snap = json(this.#state);
    if (!snap.archivedTasks) snap.archivedTasks = [];
    if (!snap.batchId) snap.batchId = 1;
    if (!snap.planning) snap.planning = null;
    return snap;
  }
  #member(id) {
    const member = this.#config.members.find((m) => m.id === id);
    assert(member, 'INVALID_MEMBER', `unknown member: ${id}`);
    assert(member.enabled, 'INVALID_MEMBER', `member is disabled: ${id}`);
    return member;
  }
  #task(id) {
    text(id, 'taskId');
    const task = this.#state.tasks.find((t) => t.id === id);
    assert(task, 'UNKNOWN_TASK', `unknown task: ${id}`);
    return task;
  }
  #assignment(task, memberId) {
    const member = this.#member(memberId);
    assert(!member.readOnly || task.writeScopes.length === 0, 'READ_ONLY', 'a read-only member cannot receive write scopes');
    return member;
  }
  #readOnly(task) { return task.readOnly || this.#member(task.memberId).readOnly; }
  #writeConflict(a, b) {
    if (this.#readOnly(a) || this.#readOnly(b)) return false;
    const scopesA = a.writeScopes.length ? a.writeScopes : ['**'];
    const scopesB = b.writeScopes.length ? b.writeScopes : ['**'];
    const overlaps = (left, right) => {
      if (left === '**' || left === '.' || right === '**' || right === '.') return true;
      const norm = s => s.replace(/\\/g, '/').replace(/\/$/, '');
      const x = norm(left), y = norm(right);
      return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
    };
    return scopesA.some(x => scopesB.some(y => overlaps(x, y)));
  }
  #validateTasks(tasks, restoring = false) {
    const ids = new Map(tasks.map((t) => [t.id, t]));
    assert(ids.size === tasks.length, 'INVALID_INPUT', 'task IDs must be unique');
    for (const task of tasks) {
      const unavailable = restoring && task.memberId !== null && !this.#config.members.some(m => m.id === task.memberId && m.enabled);
      if (unavailable) {
        // Historical identity is evidence, not a license to invent a new model.
        // Keep accepted history intact; quarantine unfinished work for explicit repair.
        if (!['done', 'cancelled', 'failed'].includes(task.status)) {
          if (task.status === 'running') task.executionEpoch++;
          if (task.status !== 'pending') {
            task.status = 'needs_attention';
            task.phase = STATUS_TO_PHASE_MAP.needs_attention;
          }
          if (task.waitingReason !== 'RETRY_LIMIT_REACHED') task.waitingReason = 'MEMBER_UNAVAILABLE';
        }
      }
      if (task.memberId !== null && !unavailable) this.#member(task.memberId);
      if (task.memberId !== null && !unavailable && !task.readOnly && !this.#member(task.memberId).readOnly) {
        assert(task.writeScopes.length > 0, 'MISSING_WRITE_SCOPE', `可写任务 ${task.id} 必须声明精确的 writeScopes`);
      }
      // retries records historical attempts; lowering maxRetries must not invalidate saved tasks.
      // Future retry permission remains enforced by review/retry transitions.
      if (task.memberId !== null && !unavailable) this.#assignment(task, task.memberId);
      for (const dep of task.dependencies) assert(ids.has(dep), 'INVALID_DEPENDENCY', `missing dependency: ${dep}`);
    }
    // Iterative topological traversal avoids a recursion limit on long DAGs.
    const indegrees = new Map(tasks.map((t) => [t.id, t.dependencies.length]));
    const children = new Map(tasks.map((t) => [t.id, []]));
    for (const task of tasks) for (const dep of task.dependencies) children.get(dep).push(task.id);
    const queue = tasks.filter((t) => indegrees.get(t.id) === 0).map((t) => t.id);
    for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i])) {
      indegrees.set(child, indegrees.get(child) - 1);
      if (indegrees.get(child) === 0) queue.push(child);
    }
    assert(queue.length === tasks.length, 'DEPENDENCY_CYCLE', 'task dependencies contain a cycle');
  }
  #check(revision, allowCancelled = false) {
    if (revision !== undefined) {
      integer(revision, 'expectedRevision');
      assert(revision === this.#state.revision, 'REVISION_CONFLICT', 'state revision changed');
    }
    assert(this.#state.revision < Number.MAX_SAFE_INTEGER, 'REVISION_EXHAUSTED', 'revision counter exhausted');
    assert(allowCancelled || this.#state.status !== 'cancelled', 'CANCELLED', 'board is cancelled');
  }
  #commit() {
    this.#state.revision++;
    const snapshot = this.snapshot();
    this.#onChange?.(snapshot);
    return snapshot;
  }
  #invalidateApproval() { this.#state.approved = this.#config.autopilot || !this.#config.confirmPlan; }
  #restore(input) {
    keys(input, ['version', 'revision', 'status', 'approved', 'tasks', 'recovery', 'archivedTasks', 'batchId', 'planning'], 'state');
    assert(input.version === 1, 'INVALID_INPUT', 'unsupported state version');
    const state = { version: 1, revision: integer(input.revision, 'state.revision'), status: input.status,
      approved: bool(input.approved, 'state.approved'), tasks: [], archivedTasks: [], batchId: typeof input.batchId === 'number' ? input.batchId : 1,
      planning: OWN(input, 'planning') && input.planning !== null ? json(input.planning) : null };
    assert(BOARD_STATUSES.has(state.status), 'INVALID_INPUT', 'invalid board status');
    assert(Array.isArray(input.tasks), 'INVALID_INPUT', 'state.tasks must be an array');
    if (OWN(input, 'recovery')) state.recovery = json(input.recovery);
    if (OWN(input, 'archivedTasks')) {
      assert(Array.isArray(input.archivedTasks), 'INVALID_INPUT', 'state.archivedTasks must be an array');
      state.archivedTasks = Array.from(input.archivedTasks, (t) => normalizeTask(t, true));
    }
    state.tasks = Array.from(input.tasks, (t) => normalizeTask(t, true));
    this.#validateTasks(state.tasks, true);
    if (state.tasks.some(t => t.memberId !== null && !this.#config.members.some(m => m.id === t.memberId && m.enabled) && !['done', 'cancelled', 'failed'].includes(t.status))) {
      state.approved = false;
      state.status = 'paused';
    }
    assert(state.status !== 'draft' || (state.tasks.length === 0 && !state.approved), 'INVALID_INPUT', 'draft state must be empty and unapproved');
    assert(state.status === 'draft' || state.status === 'cancelled' || state.tasks.length > 0, 'INVALID_INPUT', 'active board must contain tasks');
    const running = state.tasks.filter((t) => t.status === 'running');
    assert(running.length <= this.#config.maxParallel && new Set(running.map((t) => t.memberId)).size === running.length,
      'INVALID_INPUT', 'restored running tasks violate concurrency limits');
    for (let i = 0; i < running.length; i++) for (let j = i + 1; j < running.length; j++) {
      assert(!this.#writeConflict(running[i], running[j]), 'INVALID_INPUT', 'restored running tasks have overlapping write scopes');
    }
    for (const task of state.tasks) {
      if (['running', 'review', 'done', 'failed', 'needs_attention'].includes(task.status)) {
        assert(task.memberId !== null, 'INVALID_INPUT', 'started tasks require an assigned member');
        assert(task.dependencies.every((id) => state.tasks.find((t) => t.id === id).status === 'done'), 'INVALID_INPUT', 'started task dependencies must be accepted');
      }
      if (task.status === 'failed') assert(task.retries >= this.#config.maxRetries, 'INVALID_INPUT', 'failed task must exhaust retries');
      if (task.waitingReason === 'RETRY_LIMIT_REACHED') assert(task.status === 'needs_attention' && task.retries >= this.#config.maxRetries, 'INVALID_INPUT', 'retry-limit tasks require user attention');
      if (state.status === 'cancelled') assert(['done', 'failed', 'cancelled'].includes(task.status), 'INVALID_INPUT', 'cancelled board contains active tasks');
    }
    // Persisted executions are not resumed here. Even an unapproved legacy
    // snapshot must be quarantined instead of making the whole board unreadable.
    if (running.length) {
      assert(state.revision < Number.MAX_SAFE_INTEGER, 'REVISION_EXHAUSTED', 'cannot record recovery revision');
      const interruptedAt = new Date().toISOString();
      for (const task of running) {
        task.status = 'needs_attention'; task.waitingReason = 'INTERRUPTED_RESTART';
        task.phase = STATUS_TO_PHASE_MAP.needs_attention;
        task.executionEpoch++;
        task.executionHistory.push({ epoch: task.executionEpoch - 1, status: 'interrupted', at: interruptedAt, reason: 'RESTART' });
      }
      state.status = 'paused';
      state.recovery = {
        interruptedAt,
        reason: 'RESTART',
        drained: false,
        settled: false,
        processStopped: false,
        safeToShutdown: false,
        needsCheck: true,
        activeExecutions: 0,
        interruptedTaskIds: running.map((t) => t.id)
      };
      state.revision++; // Recovery is a real state transition; stale workers fail CAS.
    }
    this.#state = state;
  }
  plan(planInput, by = 'model', expectedRevision) {
    this.#check(expectedRevision, true);
    actor(by);
    assert(this.#state.status !== 'paused' && this.#state.status !== 'draining', 'PAUSED', 'resume before planning');

    let tasks;
    let planningMeta = null;
    let isStructuredPlan = false;
    if (Array.isArray(planInput)) {
      tasks = planInput;
    } else if (planInput && typeof planInput === 'object') {
      object(planInput, 'plan');
      assert(Array.isArray(planInput.tasks), 'INVALID_INPUT', 'plan.tasks must be an array');
      tasks = planInput.tasks;
      isStructuredPlan = true;
      planningMeta = {
        planningRationale: planInput.planningRationale ?? planInput.rationale ?? null,
        parallelizationJustification: planInput.parallelizationJustification ?? planInput.parallelRationale ?? null,
        dependencyJustification: planInput.dependencyJustification ?? planInput.dependencyRationale ?? null,
        idleMembersJustification: planInput.idleMembersJustification ?? planInput.idleMemberRationale ?? null,
      };
    } else {
      fail('INVALID_INPUT', 'plan must be an array or plan object');
    }

    assert(Array.isArray(tasks) && tasks.length > 0, 'INVALID_INPUT', 'plan must contain tasks');

    // 规划质量门禁核查 (针对结构化规划对象)
    if (isStructuredPlan) {
      const qualityResult = checkPlanningQuality(
        { tasks, ...planningMeta },
        { members: this.#config.members, maxParallel: this.#config.maxParallel }
      );
      if (!qualityResult.passed) {
        const err = new BoardError(
          qualityResult.code || 'PLANNING_QUALITY_ERROR',
          qualityResult.message || '规划质量门禁未通过'
        );
        if (qualityResult.remedy) err.remedy = qualityResult.remedy;
        if (qualityResult.findings) err.findings = qualityResult.findings;
        throw err;
      }
    }

    const normalized = Array.from(tasks, (t) => normalizeTask(t));
    if (this.#config.bossDirect && by === 'model' && this.#config.mode !== 'manual') {
      const nonLeadMembers = this.#config.members.filter(m => !m.id.toLowerCase().includes('lead') && !m.role.toLowerCase().includes('主控') && !m.role.toLowerCase().includes('planner'));
      const pool = nonLeadMembers.length > 0 ? nonLeadMembers : this.#config.members;
      for (const task of normalized) {
        if (!task.memberId) {
          const candidate = pool.find(m => m.enabled && (!m.readOnly || task.readOnly || (task.writeScopes && task.writeScopes.length === 0)));
          if (candidate) task.memberId = candidate.id;
        }
      }
    }
    this.#validateTasks(normalized);

    const existingTasks = this.#state.tasks;
    // 判断是否为旧终止批次（任务板处于 cancelled，或者所有历史任务均已进入 done/cancelled/failed 终态）
    const isSettledBatch = this.#state.status === 'cancelled' ||
      (existingTasks.length > 0 && existingTasks.every((t) => ['done', 'failed', 'cancelled'].includes(t.status)));

    if (!isSettledBatch && existingTasks.length > 0) {
      // 活跃任务保护：仍有 running / review / needs_attention 的原任务禁止覆盖，保留历史！
      const activeTasks = existingTasks.filter(t => ['running', 'review', 'needs_attention'].includes(t.status));
      if (activeTasks.length > 0) {
        for (const act of activeTasks) {
          const rep = normalized.find(t => t.id === act.id);
          if (rep) {
            const scopeChanged = JSON.stringify(rep.writeScopes.slice().sort()) !== JSON.stringify(act.writeScopes.slice().sort());
            const depChanged = JSON.stringify(rep.dependencies.slice().sort()) !== JSON.stringify(act.dependencies.slice().sort());
            const instChanged = rep.instructions !== act.instructions;
            const memberChanged = rep.memberId !== act.memberId;
            if (scopeChanged || depChanged || instChanged || memberChanged) {
              fail('CANNOT_OVERWRITE_ACTIVE_TASK', `原任务 ${act.id} 仍处于 ${act.status} 状态，禁止覆盖，必须保留历史`);
            }
          } else {
            fail('CANNOT_OVERWRITE_ACTIVE_TASK', `活跃任务 ${act.id} (${act.status}) 不能被新规划丢弃`);
          }
        }
      } else {
        // 没有活跃任务，但已有任务执行过（有非 pending 任务，如全部 done）
        const hasStarted = existingTasks.some(t => t.status !== 'pending');
        if (hasStarted) {
          for (const old of existingTasks.filter(t => t.status === 'done')) {
            const rep = normalized.find(t => t.id === old.id);
            if (rep && rep.status !== 'done') {
              fail('INVALID_STATE', `已完成任务 ${old.id} 不能被重置为未完成`);
            }
          }
        }
      }
    }

    // 锁定规则与权限校验：全量校验通过前，绝不修改 this.#state 任何字段
    if (by === 'model') {
      if (!isSettledBatch) {
        for (const old of this.#state.tasks.filter((t) => t.locked)) {
          const replacement = normalized.find((t) => t.id === old.id);
          assert(replacement && replacement.locked && replacement.memberId === old.memberId, 'LOCKED', 'model cannot remove or reassign a user-locked task');
        }
        for (const task of normalized) {
          const old = this.#state.tasks.find((t) => t.id === task.id);
          assert(!task.locked || (old?.locked && old.memberId === task.memberId), 'FORBIDDEN', 'only user may lock an assignment');
          assert(this.#config.mode !== 'manual' || task.memberId === null || old?.memberId === task.memberId,
            'MANUAL_ASSIGNMENT', 'manual mode requires user assignment');
          assert(this.#config.mode !== 'manual' || !old?.memberId || task.memberId === old.memberId,
            'MANUAL_ASSIGNMENT', 'model cannot alter manual assignments');
        }
        if (this.#config.mode === 'manual') for (const old of this.#state.tasks.filter((t) => t.memberId !== null)) {
          assert(normalized.some((t) => t.id === old.id), 'MANUAL_ASSIGNMENT', 'model cannot remove a manually assigned task');
        }
      } else {
        // 在 settledBatch（旧终止批次或已取消）规划新批次时：模型不得自行声明 locked 锁定，手动模式须由用户分配
        for (const task of normalized) {
          assert(!task.locked, 'FORBIDDEN', 'only user may lock an assignment');
          assert(this.#config.mode !== 'manual' || task.memberId === null,
            'MANUAL_ASSIGNMENT', 'manual mode requires user assignment');
        }
      }
    }

    // 所有校验、规则与权限全部通过后，原子提交更新并撤销批准
    if (isSettledBatch) {
      const nextArchived = Array.isArray(this.#state.archivedTasks) ? [...this.#state.archivedTasks] : [];
      if (this.#state.tasks.length > 0) {
        nextArchived.push(...this.#state.tasks);
      }
      this.#state.archivedTasks = nextArchived;
      this.#state.recovery = null;
      this.#state.batchId = (this.#state.batchId || 1) + 1;
    }

    // 保留已存在任务的历史记录与状态（例如活跃任务或已完成任务）
    const mergedTasks = [];
    for (const next of normalized) {
      const old = !isSettledBatch ? this.#state.tasks.find(t => t.id === next.id) : null;
      if (old && ['pending', 'running', 'review', 'needs_attention', 'done', 'failed', 'cancelled'].includes(old.status)) {
        mergedTasks.push({
          ...next,
          status: old.status,
          retries: old.retries,
          phase: old.phase,
          result: old.result,
          feedback: old.feedback,
          reviewHistory: old.reviewHistory,
          waitingReason: old.waitingReason,
          executionEpoch: old.executionEpoch,
          checkpoint: old.checkpoint,
          executionHistory: old.executionHistory,
          executionApproval: old.executionApproval,
          extraRetryCredit: old.extraRetryCredit,
          evidence: old.evidence ?? next.evidence
        });
      } else {
        mergedTasks.push(next);
      }
    }

    this.#state.tasks = mergedTasks;
    if (isStructuredPlan) {
      this.#state.planning = planningMeta ? { ...planningMeta, updatedAt: new Date().toISOString() } : null;
    } else if (this.#state.planning === undefined) {
      this.#state.planning = null;
    }
    // 注意：旧数组规划调用时保留既有 this.#state.planning，不清除已有 planning 元数据
    this.#state.status = 'ready';
    this.#invalidateApproval();
    return this.#commit();
  }
  appendTasks(appendInput, by = 'model', expectedRevision) {
    this.#check(expectedRevision);
    actor(by);
    let tasks;
    let appendPlanningMeta = null;
    let isStructuredAppend = false;
    if (Array.isArray(appendInput)) {
      tasks = appendInput;
    } else if (appendInput && typeof appendInput === 'object') {
      object(appendInput, 'appendInput');
      assert(Array.isArray(appendInput.tasks), 'INVALID_INPUT', 'appendInput.tasks must be an array');
      tasks = appendInput.tasks;
      isStructuredAppend = true;
      appendPlanningMeta = {
        planningRationale: appendInput.planningRationale ?? appendInput.rationale ?? null,
        parallelizationJustification: appendInput.parallelizationJustification ?? appendInput.parallelRationale ?? null,
        dependencyJustification: appendInput.dependencyJustification ?? appendInput.dependencyRationale ?? null,
        idleMembersJustification: appendInput.idleMembersJustification ?? appendInput.idleMemberRationale ?? null,
      };
    } else {
      fail('INVALID_INPUT', 'appendTasks must receive an array or append object');
    }
    assert(Array.isArray(tasks) && tasks.length > 0, 'INVALID_INPUT', 'appendTasks must contain tasks');

    const normalized = Array.from(tasks, (t) => normalizeTask(t));
    const existingIds = new Set(this.#state.tasks.map((t) => t.id));
    for (const t of normalized) {
      assert(!existingIds.has(t.id), 'DUPLICATE_TASK_ID', `cannot append existing task ID: ${t.id}`);
    }

    // 活跃任务保护：仍有 running / review / needs_attention 的原任务禁止被追加或篡改
    const activeTasks = this.#state.tasks.filter(t => ['running', 'review', 'needs_attention'].includes(t.status));
    const activeIds = new Set(activeTasks.map(t => t.id));
    for (const t of normalized) {
      assert(!activeIds.has(t.id), 'CANNOT_OVERWRITE_ACTIVE_TASK', `活跃任务 ${t.id} 禁止通过 append 覆盖`);
    }

    // 依赖合法性核查：追加任务依赖的 ID 必须存在于已有任务或本次追加任务中
    const allTaskIds = new Set([...existingIds, ...normalized.map(t => t.id)]);
    for (const t of normalized) {
      for (const depId of t.dependencies) {
        assert(allTaskIds.has(depId), 'INVALID_DEPENDENCY', `追加任务 ${t.id} 依赖不存在的任务 ${depId}`);
      }
    }

    const combined = [...this.#state.tasks, ...normalized];
    this.#validateTasks(combined);

    // 规划质量门禁核查 (针对包含追加的整体规划结构)
    if (isStructuredAppend) {
      const mergedMeta = {
        planningRationale: appendPlanningMeta.planningRationale ?? this.#state.planning?.planningRationale ?? null,
        parallelizationJustification: appendPlanningMeta.parallelizationJustification ?? this.#state.planning?.parallelizationJustification ?? null,
        dependencyJustification: appendPlanningMeta.dependencyJustification ?? this.#state.planning?.dependencyJustification ?? null,
        idleMembersJustification: appendPlanningMeta.idleMembersJustification ?? this.#state.planning?.idleMembersJustification ?? null,
      };
      const qualityResult = checkPlanningQuality(
        { tasks: combined, ...mergedMeta },
        { members: this.#config.members, maxParallel: this.#config.maxParallel }
      );
      if (!qualityResult.passed) {
        const err = new BoardError(
          qualityResult.code || 'PLANNING_QUALITY_ERROR',
          qualityResult.message || '追加任务规划质量门禁未通过'
        );
        if (qualityResult.remedy) err.remedy = qualityResult.remedy;
        if (qualityResult.findings) err.findings = qualityResult.findings;
        throw err;
      }
      this.#state.planning = { ...mergedMeta, updatedAt: new Date().toISOString() };
    }

    this.#state.tasks = combined;
    this.#invalidateApproval();
    return this.#commit();
  }
  getDrainStatus() {
    const running = this.#state.tasks.filter((t) => t.status === 'running');
    const isDrained = running.length === 0 && this.#state.status === 'drained';
    const isHostSettled = Boolean(this.#state.recovery?.settled);
    const processStopped = Boolean(this.#state.recovery?.processStopped);
    const safeToShutdown = isDrained && isHostSettled && processStopped;
    return {
      status: this.#state.status,
      activeExecutions: running.length,
      activeTaskIds: running.map((t) => t.id),
      isDrained,
      safeToShutdown,
      processStopped,
      interruptedAt: this.#state.recovery?.interruptedAt || null,
      stopReason: this.#state.recovery?.reason || null,
      drainedAt: this.#state.recovery?.drainedAt || null,
    };
  }
  drain(hostSettlement = {}, expectedRevision) {
    if (typeof hostSettlement === 'number') {
      expectedRevision = hostSettlement;
      hostSettlement = {};
    }
    this.#check(expectedRevision);
    const running = this.#state.tasks.filter((t) => t.status === 'running');
    if (running.length > 0) {
      this.#state.status = 'draining';
      const at = new Date().toISOString();
      this.#state.recovery = {
        ...(this.#state.recovery || {}),
        drained: false,
        settled: false,
        processStopped: false,
        safeToShutdown: false,
        activeExecutions: running.length,
        drainingAt: at,
      };
      return this.#commit();
    }
    this.#state.status = 'drained';
    const drainedAt = new Date().toISOString();
    const hasExplicitSettlement = hostSettlement && typeof hostSettlement === 'object' &&
      (OWN(hostSettlement, 'settled') || OWN(hostSettlement, 'processStopped'));
    const hostSettled = hasExplicitSettlement
      ? Boolean(hostSettlement.settled ?? hostSettlement.drained ?? false)
      : false;
    const processStopped = hasExplicitSettlement
      ? Boolean(hostSettlement.processStopped)
      : false;
    const safeToShutdown = hostSettled && processStopped;
    this.#state.recovery = {
      ...(this.#state.recovery || {}),
      drained: true,
      settled: hostSettled,
      processStopped,
      safeToShutdown,
      activeExecutions: 0,
      drainedAt,
    };
    return this.#commit();
  }
  assign(taskId, memberId, by = 'user', expectedRevision) {
    this.#check(expectedRevision);
    actor(by);
    const task = this.#task(taskId);
    assert(task.status === 'pending' || task.status === 'needs_attention', 'INVALID_STATE', 'only unstarted or interrupted tasks can be reassigned');
    assert(by !== 'model' || !task.locked, 'LOCKED', 'model cannot change a locked assignment');
    assert(by !== 'model' || this.#config.mode !== 'manual', 'MANUAL_ASSIGNMENT', 'manual mode requires user assignment');
    this.#assignment(task, memberId);
    task.memberId = memberId;
    if (by === 'user') task.locked = true;
    this.#invalidateApproval();
    return this.#commit();
  }
  balanceReadyAssignments() {
    if (this.#config.mode === 'manual' || this.#state.status !== 'ready' || !this.#state.approved) return this.snapshot();
    const running = this.#state.tasks.filter(t => t.status === 'running');
    const reserved = new Set(running.map(t => t.memberId));
    let changed = false;
    const equivalent = (a, b) => a && b && ['provider', 'model', 'role', 'instructions', 'readOnly'].every(k => a[k] === b[k]);
    // Locked user choices reserve their member first. Never change a running assignment.
    const ready = this.#state.tasks.filter(t => t.status === 'pending' && t.dependencies.every(id => this.#task(id).status === 'done') && !running.some(active => this.#writeConflict(t, active)));
    for (const task of [...ready.filter(t => t.locked), ...ready.filter(t => !t.locked)]) {
      const current = this.#config.members.find(m => m.id === task.memberId);
      if (!task.locked && reserved.has(task.memberId)) {
        const spare = this.#config.members.find(m => m.enabled && !m.id.startsWith('task-route-') && !reserved.has(m.id) && equivalent(current, m) && (!m.readOnly || task.writeScopes.length === 0));
        if (spare) { task.memberId = spare.id; changed = true; }
      }
      if (task.memberId) reserved.add(task.memberId);
    }
    // Identical-role routing does not change task scope, dependencies or approved work.
    return changed ? this.#commit() : this.snapshot();
  }
  approve(by = 'user', expectedRevision) {
    this.#check(expectedRevision);
    actor(by);
    assert(by === 'user', 'FORBIDDEN', 'only user can approve a plan');
    assert(this.#state.status === 'ready' || this.#state.status === 'paused', 'INVALID_STATE', 'no plan to approve');
    assert(this.#state.tasks.every((t) => t.memberId !== null || t.status === 'cancelled'), 'UNASSIGNED', 'assign all tasks before approval');
    this.#state.approved = true;
    return this.#commit();
  }
  #approvalScope(task) {
    return JSON.stringify([task.id, task.instructions, task.acceptance, task.dependencies, task.writeScopes, task.readOnly]);
  }
  isTaskExecutionApproved(taskId) {
    const task = this.#task(taskId);
    return task.executionApproval === this.#approvalScope(task);
  }
  start(taskId, expectedRevision, userTaskApproval = false) {
    this.#check(expectedRevision);
    assert(this.#config.enabled, 'DISABLED', 'team is disabled');
    assert(this.#state.status === 'ready', 'INVALID_STATE', 'board must be ready to start');
    const task = this.#task(taskId);
    assert(this.#state.approved || userTaskApproval === true || this.isTaskExecutionApproved(taskId), 'APPROVAL_REQUIRED', 'plan requires user approval');
    assert(task.status === 'pending', 'INVALID_STATE', 'task must be pending');
    assert(task.memberId !== null, 'UNASSIGNED', 'task requires an assigned member');
    this.#assignment(task, task.memberId);
    assert(task.dependencies.every((id) => this.#task(id).status === 'done'), 'DEPENDENCY_NOT_DONE', 'dependencies must pass review before starting');
    const running = this.#state.tasks.filter((t) => t.status === 'running');
    assert(running.length < this.#config.maxParallel, 'PARALLEL_LIMIT', 'maxParallel reached');
    assert(!running.some((t) => t.memberId === task.memberId), 'MEMBER_BUSY', 'member already has a running task');
    assert(!running.some(other => this.#writeConflict(task, other)), 'WRITE_SCOPE_CONFLICT', 'write scopes overlap with another running task');
    assert(task.executionEpoch < Number.MAX_SAFE_INTEGER, 'REVISION_EXHAUSTED', 'execution epoch exhausted');
    task.extraRetryCredit = 0;
    task.executionApproval = this.#approvalScope(task);
    task.executionEpoch++;
    task.executionHistory.push({ epoch: task.executionEpoch, status: 'started', memberId: task.memberId, at: new Date().toISOString() });
    task.status = 'running';
    task.phase = STATUS_TO_PHASE_MAP.running;
    task.waitingReason = '';
    return this.#commit();
  }
  recordDispatch(taskId, dispatch, executionEpoch) {
    this.#check();
    const task = this.#task(taskId);
    assert(task.status === 'running' && task.executionEpoch === executionEpoch, 'STALE_EXECUTION', 'dispatch record does not match running execution');
    task.evidence = { dispatchStatus: 'running', dispatch: json(dispatch, 'dispatch') };
    return this.#commit();
  }
  finish(taskId, result, expectedRevision, executionEpoch) {
    this.#check(expectedRevision);
    const task = this.#task(taskId);
    if (executionEpoch !== undefined) assert(task.executionEpoch === executionEpoch, 'STALE_EXECUTION', 'old execution result ignored');
    assert(task.status === 'running', 'INVALID_STATE', 'only running tasks can finish');
    const value = json(result, 'result');
    task.result = value;
    if (value && typeof value === 'object' && OWN(value, 'evidence') && value.evidence !== null) {
      task.evidence = json(value.evidence, 'task.evidence');
    }
    const failed = Boolean(value && typeof value === 'object' && value.error);
    task.status = failed ? 'needs_attention' : 'review';
    task.phase = STATUS_TO_PHASE_MAP[task.status];
    task.waitingReason = failed ? 'EXECUTION_FAILED' : '';
    task.executionHistory.push({ epoch: task.executionEpoch, status: task.status, at: new Date().toISOString(), result: value });
    return this.#commit();
  }
  continueAfterRetryLimit(taskId, by = 'user', expectedRevision) {
    this.#check(expectedRevision);
    actor(by);
    assert(by === 'user', 'FORBIDDEN', 'only user may authorize more retries');
    const task = this.#task(taskId);
    assert(task.status === 'needs_attention' && task.waitingReason === 'RETRY_LIMIT_REACHED', 'INVALID_STATE', 'task is not waiting for retry-limit approval');
    task.status = 'pending';
    task.phase = STATUS_TO_PHASE_MAP.pending;
    task.retries++;
    task.extraRetryCredit = 1;
    task.waitingReason = '';
    task.feedback = `${task.feedback}\n用户已批准额外一轮返工；累计返工次数保留，本次授权仅允许再执行一次。`;
    return this.#commit();
  }
  review(taskId, passed, feedback = '', expectedRevision) {
    this.#check(expectedRevision);
    bool(passed, 'passed');
    text(feedback, 'feedback', true);
    const task = this.#task(taskId);
    assert(task.status === 'review', 'INVALID_STATE', 'only completed executions can be reviewed');
    task.feedback = feedback;
    task.reviewHistory.push({
      attempt: task.retries + 1,
      passed,
      feedback,
      result: task.result,
      reviewedAt: new Date().toISOString(),
    });
    task.waitingReason = '';
    if (passed) {
      task.status = 'done';
      task.phase = STATUS_TO_PHASE_MAP.done;
    } else if (task.retries < this.#config.maxRetries) {
      task.retries++;
      task.status = 'pending';
      task.phase = STATUS_TO_PHASE_MAP.pending;
      task.result = null;
    } else {
      task.status = 'needs_attention';
      task.phase = STATUS_TO_PHASE_MAP.needs_attention;
      task.waitingReason = 'RETRY_LIMIT_REACHED';
    }
    return this.#commit();
  }
  checkpointTask(taskId, note, executionEpoch) {
    this.#check(); text(note, 'checkpoint.note');
    const task = this.#task(taskId);
    if (executionEpoch !== undefined) assert(task.executionEpoch === executionEpoch, 'STALE_EXECUTION', 'old checkpoint ignored');
    task.checkpoint = { note, updatedAt: new Date().toISOString() };
    return this.#commit();
  }
  interrupt(reason = 'USER_INTERRUPTED', taskId) {
    this.#check();
    const at = new Date().toISOString();
    for (const task of this.#state.tasks.filter(t => t.status === 'running' && (taskId === undefined || t.id === taskId))) {
      task.executionHistory.push({ epoch: task.executionEpoch, status: 'interrupted', at, reason });
      task.executionEpoch++; task.status = 'needs_attention'; task.phase = STATUS_TO_PHASE_MAP.needs_attention; task.waitingReason = reason;
    }
    const runningLeft = this.#state.tasks.filter(t => t.status === 'running').length;
    this.#state.status = 'paused';
    this.#state.recovery = {
      interruptedAt: at,
      reason,
      drained: runningLeft === 0,
      processStopped: false,
      safeToShutdown: false,
      activeExecutions: runningLeft
    };
    return this.#commit();
  }
  recoverTask(taskId, continuationNote, by = 'user') {
    this.#check(); actor(by); assert(by === 'user', 'FORBIDDEN', 'recovery requires user confirmation');
    text(continuationNote, 'continuationNote'); const task = this.#task(taskId);
    assert(task.status === 'needs_attention' && task.waitingReason !== 'RETRY_LIMIT_REACHED', 'INVALID_STATE', 'only interrupted tasks can recover');
    task.checkpoint = { note: continuationNote, updatedAt: new Date().toISOString() };
    task.executionHistory.push({ epoch: task.executionEpoch, status: 'recovery-confirmed', at: task.checkpoint.updatedAt, note: continuationNote });
    task.status = 'pending'; task.phase = STATUS_TO_PHASE_MAP.pending; task.waitingReason = '';
    // Recovery is not a failed review: preserve retry budget, previous results and review history.
    return this.#commit();
  }
  pause(expectedRevision) {
    this.#check(expectedRevision);
    assert(this.#state.status === 'ready', 'INVALID_STATE', 'only a ready board can pause');
    this.#state.status = 'paused';
    return this.#commit();
  }
  resume(expectedRevision) {
    this.#check(expectedRevision);
    assert(['paused', 'draining', 'drained'].includes(this.#state.status), 'INVALID_STATE', 'only a paused or drained board can resume');
    this.#state.status = 'ready';
    return this.#commit();
  }
  cancel(expectedRevision) {
    this.#check(expectedRevision);
    this.#state.status = 'cancelled';
    for (const task of this.#state.tasks) if (!['done', 'failed', 'cancelled'].includes(task.status)) {
      task.status = 'cancelled';
      task.phase = STATUS_TO_PHASE_MAP.cancelled;
    }
    return this.#commit();
  }
  cancelTask(taskId, expectedRevision) {
    this.#check(expectedRevision);
    const task = this.#task(taskId);
    assert(!['done', 'failed', 'cancelled'].includes(task.status), 'INVALID_STATE', 'terminal task cannot be cancelled');
    task.status = 'cancelled';
    task.phase = STATUS_TO_PHASE_MAP.cancelled;
    return this.#commit();
  }
  /** An interrupted execution never restarts implicitly. User explicitly accepts re-run risk. */
  retry(taskId, by = 'user', expectedRevision) {
    this.#check(expectedRevision);
    actor(by);
    assert(by === 'user', 'FORBIDDEN', 'only user may retry an interrupted execution');
    const task = this.#task(taskId);
    assert(task.status === 'needs_attention' && task.waitingReason !== 'RETRY_LIMIT_REACHED', 'INVALID_STATE', 'retry-limit tasks require explicit user authorization');
    assert(task.retries < this.#config.maxRetries, 'RETRY_LIMIT', 'retry budget exhausted');
    task.retries++;
    task.status = 'pending';
    task.phase = STATUS_TO_PHASE_MAP.pending;
    task.result = null;
    task.waitingReason = '';
    return this.#commit();
  }
}
