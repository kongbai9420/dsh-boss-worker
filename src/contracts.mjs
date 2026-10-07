// Pure, dependency-free contracts and structured reporting module.
// Strictly zero I/O, no filesystem mutation, no process execution, no environment side effects.

export class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new ContractError(code, message); };
const assert = (condition, code, message) => { if (!condition) fail(code, message); };

export const VALID_TASK_TYPES = Object.freeze(['code', 'test', 'analysis', 'review', 'doc', 'general']);
export const VALID_PHASES = Object.freeze(['planned', 'ready', 'running', 'verifying', 'completed', 'failed', 'blocked']);
export const VALID_DELIVERABLE_TYPES = Object.freeze(['code', 'test', 'doc', 'config', 'report', 'asset', 'file']);

const STATUS_TO_PHASE_MAP = Object.freeze({
  pending: 'ready',
  running: 'running',
  review: 'verifying',
  done: 'completed',
  failed: 'failed',
  needs_attention: 'blocked',
  cancelled: 'failed',
});

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertObject(value, label) {
  assert(isPlainObject(value), 'INVALID_INPUT', `${label} must be a plain object`);
}

function checkKeys(value, allowed, label) {
  assertObject(value, label);
  for (const key of Reflect.ownKeys(value)) {
    assert(typeof key === 'string' && allowed.includes(key), 'UNKNOWN_FIELD', `${label}: unknown field "${String(key)}"`);
    assert(key !== '__proto__' && key !== 'constructor' && key !== 'prototype', 'INVALID_INPUT', `${label}: illegal field "${String(key)}"`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert(descriptor && 'value' in descriptor && descriptor.enumerable && !descriptor.get && !descriptor.set, 'INVALID_INPUT', `${label}: only enumerable data fields without getters/setters are supported`);
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

export function assertDenseArray(value, label) {
  assert(Array.isArray(value), 'INVALID_INPUT', `${label} must be an array`);
  const len = value.length;
  for (let i = 0; i < len; i++) {
    const key = String(i);
    assert(Object.prototype.hasOwnProperty.call(value, key), 'INVALID_INPUT', `${label} must be dense, missing element at index ${i}`);
    const desc = Object.getOwnPropertyDescriptor(value, key);
    assert(desc && 'value' in desc && desc.enumerable && !desc.get && !desc.set, 'INVALID_INPUT', `${label}[${i}] must be an enumerable data property without getters/setters`);
  }
  for (const k of Reflect.ownKeys(value)) {
    if (k === 'length') continue;
    assert(typeof k === 'string', 'INVALID_INPUT', `${label} must not contain symbol properties`);
    const num = Number(k);
    assert(Number.isInteger(num) && num >= 0 && num < len && String(num) === k, 'INVALID_INPUT', `${label} contains illegal property "${k}"`);
  }
  return value;
}

function strings(value, label) {
  assertDenseArray(value, label);
  const result = [];
  for (let i = 0; i < value.length; i++) {
    result.push(text(value[i], `${label}[${i}]`));
  }
  assert(new Set(result).size === result.length, 'INVALID_INPUT', `${label} must not contain duplicates`);
  return result;
}

export function deepCloneJson(value, label = 'value', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  assert(typeof value === 'object' && value !== null, 'INVALID_INPUT', `${label} must contain only JSON values`);
  assert(!seen.has(value), 'INVALID_INPUT', `${label} must not be cyclic`);
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    assertDenseArray(value, label);
    result = [];
    for (let i = 0; i < value.length; i++) {
      result.push(deepCloneJson(value[i], `${label}[${i}]`, seen));
    }
  } else {
    assertObject(value, label);
    result = {};
    for (const key of Reflect.ownKeys(value)) {
      assert(typeof key === 'string', 'INVALID_INPUT', `${label} must not contain symbol properties`);
      assert(key !== '__proto__', 'INVALID_INPUT', `${label} must not contain __proto__ key`);
      assert(key !== 'constructor', 'INVALID_INPUT', `${label} must not contain constructor key`);
      assert(key !== 'prototype', 'INVALID_INPUT', `${label} must not contain prototype key`);
      const d = Object.getOwnPropertyDescriptor(value, key);
      assert(d && d.enumerable && 'value' in d && !d.get && !d.set, 'INVALID_INPUT', `${label} must contain only enumerable data fields without getters/setters`);
      Object.defineProperty(result, key, {
        value: deepCloneJson(d.value, `${label}.${key}`, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  seen.delete(value);
  return result;
}

/**
 * Validates and normalizes safe relative file or directory paths.
 * Blocks absolute paths (Unix/Windows), UNC shares, drive letters, Windows colon ADS, null bytes, and traversal (`..`).
 * Preserves valid filenames with consecutive dots like `a..b`.
 */
export function validateSafeRelativePath(input, label = 'path') {
  assert(typeof input === 'string', 'INVALID_INPUT', `${label} must be a string`);
  const raw = input.trim();
  assert(raw.length > 0, 'INVALID_PATH', `${label} must be a nonempty relative path`);
  assert(!raw.includes('\0'), 'INVALID_PATH', `${label} contains illegal null byte: "${raw}"`);
  assert(!raw.includes(':'), 'INVALID_PATH', `${label} contains illegal colon (Windows ADS or drive): "${raw}"`);

  // Normalize backslashes to forward slashes
  const normalized = raw.replace(/\\/g, '/');

  // Disallow absolute paths
  assert(!normalized.startsWith('/'), 'INVALID_PATH', `${label} must not be an absolute path: "${raw}"`);
  assert(!normalized.startsWith('//'), 'INVALID_PATH', `${label} must not be a UNC path: "${raw}"`);

  // Split segments and verify no directory traversal (`..`)
  const segments = normalized.split('/');
  for (const seg of segments) {
    assert(seg !== '..', 'INVALID_PATH', `${label} must not contain directory traversal (".."): "${raw}"`);
  }

  // Filter out redundant empty segments or single dots (e.g. "./foo" -> "foo")
  const cleaned = segments.filter((s) => s.length > 0 && s !== '.').join('/');
  assert(cleaned.length > 0, 'INVALID_PATH', `${label} resolves to an empty path: "${raw}"`);

  return cleaned;
}

/**
 * Scope match check: checks if a file path falls within a defined write scope.
 */
export function isPathInScope(filePath, scopePattern) {
  const normScope = scopePattern.replace(/\\/g, '/').replace(/\/$/, '');
  const normPath = filePath.replace(/\\/g, '/');
  if (normScope === '**' || normScope === '.') return true;
  return normPath === normScope || normPath.startsWith(`${normScope}/`);
}

/**
 * Normalizes a single deliverable declaration.
 */
const DELIVERABLE_FIELDS = ['path', 'type', 'description', 'required'];
export function normalizeDeliverable(input, label = 'deliverable') {
  checkKeys(input, DELIVERABLE_FIELDS, label);
  const path = validateSafeRelativePath(input.path, `${label}.path`);
  const type = Object.prototype.hasOwnProperty.call(input, 'type')
    ? text(input.type, `${label}.type`)
    : 'file';
  assert(VALID_DELIVERABLE_TYPES.includes(type), 'INVALID_TYPE', `${label}.type must be one of: ${VALID_DELIVERABLE_TYPES.join(', ')}`);
  const description = Object.prototype.hasOwnProperty.call(input, 'description')
    ? text(input.description, `${label}.description`, true)
    : '';
  const required = Object.prototype.hasOwnProperty.call(input, 'required')
    ? bool(input.required, `${label}.required`)
    : true;

  return { path, type, description, required };
}

/**
 * Normalizes test result entries within evidence.
 * Retains null for missing exitCode without fabricating 0/1.
 */
const TEST_RESULT_FIELDS = ['name', 'command', 'passed', 'output', 'exitCode', 'durationMs'];
export function normalizeTestResult(input, label = 'test') {
  checkKeys(input, TEST_RESULT_FIELDS, label);
  const name = Object.prototype.hasOwnProperty.call(input, 'name')
    ? text(input.name, `${label}.name`, true)
    : '';
  const command = Object.prototype.hasOwnProperty.call(input, 'command')
    ? text(input.command, `${label}.command`, true)
    : '';
  assert(name.length > 0 || command.length > 0, 'INVALID_INPUT', `${label} must have either name or command`);
  const passed = bool(input.passed, `${label}.passed`);
  const output = Object.prototype.hasOwnProperty.call(input, 'output')
    ? text(input.output, `${label}.output`, true)
    : '';
  let exitCode = null;
  if (Object.prototype.hasOwnProperty.call(input, 'exitCode') && input.exitCode !== null && input.exitCode !== undefined) {
    exitCode = integer(input.exitCode, `${label}.exitCode`, -1000, 1000);
  }
  const durationMs = Object.prototype.hasOwnProperty.call(input, 'durationMs') && input.durationMs !== null && input.durationMs !== undefined
    ? integer(input.durationMs, `${label}.durationMs`, 0, 10000000)
    : null;

  return { name: name || command, command, passed, output, exitCode, durationMs };
}

/**
 * Normalizes structured evidence object.
 */
const EVIDENCE_FIELDS = ['summary', 'files', 'tests', 'deliverables', 'unfinished', 'risks', 'metrics'];
export function normalizeEvidence(input, label = 'evidence') {
  if (input === null || input === undefined) return null;
  checkKeys(input, EVIDENCE_FIELDS, label);

  const summary = Object.prototype.hasOwnProperty.call(input, 'summary')
    ? text(input.summary, `${label}.summary`, true)
    : '';

  const files = Object.prototype.hasOwnProperty.call(input, 'files')
    ? (() => {
        assertDenseArray(input.files, `${label}.files`);
        return input.files.map((f, idx) => validateSafeRelativePath(f, `${label}.files[${idx}]`));
      })()
    : [];
  assert(new Set(files).size === files.length, 'INVALID_INPUT', `${label}.files must not contain duplicate paths`);

  const tests = Object.prototype.hasOwnProperty.call(input, 'tests')
    ? (() => {
        assertDenseArray(input.tests, `${label}.tests`);
        return input.tests.map((t, idx) => normalizeTestResult(t, `${label}.tests[${idx}]`));
      })()
    : [];

  const deliverables = Object.prototype.hasOwnProperty.call(input, 'deliverables')
    ? (() => {
        assertDenseArray(input.deliverables, `${label}.deliverables`);
        return input.deliverables.map((d, idx) => {
          checkKeys(d, ['path', 'verified', 'note'], `${label}.deliverables[${idx}]`);
          return {
            path: validateSafeRelativePath(d.path, `${label}.deliverables[${idx}].path`),
            verified: bool(d.verified, `${label}.deliverables[${idx}].verified`),
            note: Object.prototype.hasOwnProperty.call(d, 'note') ? text(d.note, `${label}.deliverables[${idx}].note`, true) : '',
          };
        });
      })()
    : [];

  const unfinished = Object.prototype.hasOwnProperty.call(input, 'unfinished')
    ? strings(input.unfinished, `${label}.unfinished`)
    : [];

  const risks = Object.prototype.hasOwnProperty.call(input, 'risks')
    ? strings(input.risks, `${label}.risks`)
    : [];

  const metrics = Object.prototype.hasOwnProperty.call(input, 'metrics') && input.metrics !== null && input.metrics !== undefined
    ? deepCloneJson(input.metrics, `${label}.metrics`)
    : null;

  return { summary, files, tests, deliverables, unfinished, risks, metrics };
}

/**
 * Normalizes full task representation, backward compatible with legacy tasks from core.mjs.
 */
const LEGACY_TASK_FIELDS = [
  'id', 'title', 'instructions', 'acceptance', 'memberId', 'locked',
  'dependencies', 'writeScopes', 'readOnly', 'status', 'retries'
];
const LEGACY_STORED_FIELDS = [
  ...LEGACY_TASK_FIELDS,
  'result', 'feedback', 'reviewHistory', 'waitingReason', 'executionEpoch',
  'checkpoint', 'executionHistory'
];
const EXTENDED_CONTRACT_FIELDS = [
  ...LEGACY_STORED_FIELDS,
  'taskType', 'deliverables', 'phase', 'evidence'
];

export function normalizeContractTask(input, options = {}) {
  assertObject(input, 'task');
  checkKeys(input, EXTENDED_CONTRACT_FIELDS, 'task');

  // Core required fields
  const id = text(input.id, 'task.id');
  const title = text(input.title, 'task.title');
  const instructions = text(input.instructions, 'task.instructions');

  const acceptance = Array.isArray(input.acceptance)
    ? strings(input.acceptance, 'task.acceptance')
    : text(input.acceptance, 'task.acceptance');
  assert(!Array.isArray(acceptance) || acceptance.length > 0, 'INVALID_INPUT', 'task.acceptance must not be empty');

  const memberId = !Object.prototype.hasOwnProperty.call(input, 'memberId') || input.memberId === null
    ? null
    : text(input.memberId, 'task.memberId');

  const locked = Object.prototype.hasOwnProperty.call(input, 'locked')
    ? bool(input.locked, 'task.locked')
    : false;
  assert(!locked || memberId !== null, 'INVALID_INPUT', 'a locked task must have an assigned member');

  const dependencies = Object.prototype.hasOwnProperty.call(input, 'dependencies')
    ? strings(input.dependencies, 'task.dependencies')
    : [];

  const writeScopes = Object.prototype.hasOwnProperty.call(input, 'writeScopes')
    ? (() => {
        assertDenseArray(input.writeScopes, 'task.writeScopes');
        return input.writeScopes.map((scope, idx) => {
          const raw = text(scope, `task.writeScopes[${idx}]`).trim();
          assert(raw.length > 0, 'INVALID_PATH', `writeScopes[${idx}] must not be empty`);
          assert(!raw.includes('\0'), 'INVALID_PATH', `writeScopes[${idx}] must not contain null bytes`);
          assert(!raw.includes(':'), 'INVALID_PATH', `writeScopes[${idx}] must not contain colon or Windows ADS: "${scope}"`);
          const s = raw.replace(/\\/g, '/');
          assert(!s.startsWith('/'), 'INVALID_PATH', `writeScopes must not be absolute: "${scope}"`);
          assert(!s.startsWith('//'), 'INVALID_PATH', `writeScopes must not be UNC path: "${scope}"`);
          const segments = s.split('/');
          for (const seg of segments) {
            assert(seg !== '..', 'INVALID_PATH', `writeScopes must not contain traversal (".."): "${scope}"`);
          }
          return s;
        });
      })()
    : [];
  assert(new Set(writeScopes).size === writeScopes.length, 'INVALID_INPUT', 'task.writeScopes must not contain duplicates');

  const readOnly = Object.prototype.hasOwnProperty.call(input, 'readOnly')
    ? bool(input.readOnly, 'task.readOnly')
    : false;
  assert(!readOnly || writeScopes.length === 0, 'INVALID_INPUT', 'read-only tasks cannot declare write scopes');

  const status = Object.prototype.hasOwnProperty.call(input, 'status')
    ? text(input.status, 'task.status')
    : 'pending';
  assert(Object.prototype.hasOwnProperty.call(STATUS_TO_PHASE_MAP, status), 'INVALID_INPUT', `invalid task status: "${status}"`);

  const retries = Object.prototype.hasOwnProperty.call(input, 'retries')
    ? integer(input.retries, 'task.retries')
    : 0;

  // Stored execution tracking fields
  const result = Object.prototype.hasOwnProperty.call(input, 'result') && input.result !== null
    ? deepCloneJson(input.result, 'task.result')
    : null;
  const feedback = Object.prototype.hasOwnProperty.call(input, 'feedback')
    ? text(input.feedback, 'task.feedback', true)
    : '';
  const reviewHistory = Object.prototype.hasOwnProperty.call(input, 'reviewHistory')
    ? deepCloneJson(input.reviewHistory, 'task.reviewHistory')
    : [];
  const waitingReason = Object.prototype.hasOwnProperty.call(input, 'waitingReason')
    ? text(input.waitingReason, 'task.waitingReason', true)
    : '';
  const executionEpoch = Object.prototype.hasOwnProperty.call(input, 'executionEpoch')
    ? integer(input.executionEpoch, 'task.executionEpoch')
    : 0;
  const checkpoint = Object.prototype.hasOwnProperty.call(input, 'checkpoint') && input.checkpoint !== null
    ? deepCloneJson(input.checkpoint, 'task.checkpoint')
    : null;
  const executionHistory = Object.prototype.hasOwnProperty.call(input, 'executionHistory')
    ? deepCloneJson(input.executionHistory, 'task.executionHistory')
    : [];

  // Contract extension: taskType
  let taskType;
  if (Object.prototype.hasOwnProperty.call(input, 'taskType')) {
    taskType = text(input.taskType, 'task.taskType');
    assert(VALID_TASK_TYPES.includes(taskType), 'INVALID_TYPE', `task.taskType must be one of: ${VALID_TASK_TYPES.join(', ')}`);
  } else {
    // Deduce type smoothly for legacy tasks
    if (readOnly) {
      taskType = 'analysis';
    } else if (writeScopes.length > 0) {
      taskType = 'code';
    } else {
      taskType = 'general';
    }
  }

  // Contract extension: deliverables
  const deliverables = Object.prototype.hasOwnProperty.call(input, 'deliverables')
    ? (() => {
        assertDenseArray(input.deliverables, 'task.deliverables');
        return input.deliverables.map((d, idx) => normalizeDeliverable(d, `task.deliverables[${idx}]`));
      })()
    : [];

  // Contract extension: phase
  let phase;
  if (Object.prototype.hasOwnProperty.call(input, 'phase')) {
    phase = text(input.phase, 'task.phase');
    assert(VALID_PHASES.includes(phase), 'INVALID_PHASE', `task.phase must be one of: ${VALID_PHASES.join(', ')}`);
  } else {
    phase = STATUS_TO_PHASE_MAP[status] || 'planned';
  }

  // Contract extension: evidence
  const evidence = Object.prototype.hasOwnProperty.call(input, 'evidence')
    ? normalizeEvidence(input.evidence, 'task.evidence')
    : null;

  return {
    id,
    title,
    instructions,
    acceptance,
    memberId,
    locked,
    dependencies,
    writeScopes,
    readOnly,
    status,
    retries,
    result,
    feedback,
    reviewHistory,
    waitingReason,
    executionEpoch,
    checkpoint,
    executionHistory,
    taskType,
    deliverables,
    phase,
    evidence,
  };
}

/**
 * Strict evaluation of task evidence.
 * Verifies reported completeness, test outputs, exit codes, scope bounds, and deliverable presence.
 *
 * NOTE: This function evaluates model self-reported completeness (source: 'reported')
 * and does NOT perform independent external verification. Therefore, canAutoAccept is ALWAYS false
 * and verified is ALWAYS false. It cannot be used as a final independent acceptance verdict.
 *
 * Returns: {
 *   passed: boolean,
 *   reasons: string[],
 *   source: 'reported',
 *   canAutoAccept: false,
 *   verified: false,
 *   completeness: 'reported_complete' | 'incomplete' | 'missing',
 *   note: string,
 *   normalizedEvidence: object | null
 * }
 */
export function verifyTaskEvidence(taskInput, evidenceInput, options = {}) {
  const task = normalizeContractTask(taskInput);
  const evidence = evidenceInput ? normalizeEvidence(evidenceInput) : null;
  const reasons = [];

  // 1. Evidence existence
  if (!evidence) {
    return {
      passed: false,
      reasons: ['缺少分项执行结果 (No evidence provided)'],
      source: 'reported',
      canAutoAccept: false,
      verified: false,
      completeness: 'missing',
      note: '缺少自报结果，不可通过 (Missing evidence)',
      normalizedEvidence: null,
    };
  }

  // 2. Unfinished items block pass
  if (evidence.unfinished.length > 0) {
    reasons.push(`仍有未完成事项: ${evidence.unfinished.join('; ')}`);
  }

  // 3. Summary check
  if (!evidence.summary || evidence.summary.trim().length === 0) {
    reasons.push('执行结果缺少摘要说明 (Missing evidence summary)');
  }

  // 4. Scope and file modification checks
  if (task.writeScopes.length > 0 || task.taskType === 'code') {
    if (!task.readOnly && evidence.files.length === 0) {
      reasons.push('代码类任务未报告任何修改的文件 (No modified files reported)');
    }
    // Check if any modified file exceeds writeScopes
    if (task.writeScopes.length > 0) {
      const outOfScopeFiles = evidence.files.filter(
        (f) => !task.writeScopes.some((scope) => isPathInScope(f, scope))
      );
      if (outOfScopeFiles.length > 0) {
        reasons.push(`文件修改超出允许的 writeScopes: ${outOfScopeFiles.join(', ')}`);
      }
    }
  }

  // 5. Test evidence checks
  if (task.taskType === 'code' || task.taskType === 'test') {
    if (evidence.tests.length === 0) {
      reasons.push(`任务类型为 ${task.taskType}，必须提供自动化测试运行结果`);
    } else {
      for (const t of evidence.tests) {
        if (!t.passed) {
          reasons.push(`测试未通过: [${t.name || t.command}] (退出码: ${t.exitCode})`);
        }
        if (t.passed && (t.exitCode === null || t.exitCode === undefined)) {
          reasons.push(`测试结果不充分: [${t.name || t.command}] 声明 passed 为 true 但未提供客观退出码 (exitCode 缺失，不能客观判定通过)`);
        } else if (t.passed && t.exitCode !== 0) {
          reasons.push(`测试结果矛盾: [${t.name || t.command}] 退出码为 ${t.exitCode}，与 passed: true 矛盾`);
        }
        if (!t.output || t.output.trim().length === 0) {
          reasons.push(`测试结果存在伪造风险: [${t.name || t.command}] 未提供真实测试输出日志`);
        }
      }
    }
  }

  // 6. Deliverables verification
  if (task.deliverables.length > 0) {
    const verifiedDeliverablePaths = new Set(
      evidence.deliverables.filter((d) => d.verified).map((d) => d.path)
    );
    const modifiedFileSet = new Set(evidence.files);

    for (const reqDeliverable of task.deliverables) {
      if (reqDeliverable.required) {
        const foundInFiles = modifiedFileSet.has(reqDeliverable.path);
        const foundInVerified = verifiedDeliverablePaths.has(reqDeliverable.path);
        if (!foundInFiles && !foundInVerified) {
          reasons.push(`缺少关键成果: "${reqDeliverable.path}" (${reqDeliverable.description || reqDeliverable.type})`);
        }
      }
    }
  }

  const passed = reasons.length === 0;
  return {
    passed,
    reasons,
    source: 'reported',
    canAutoAccept: false,
    verified: false,
    completeness: passed ? 'reported_complete' : 'incomplete',
    note: '自评结果自洽性检查，非独立验证；source=reported且canAutoAccept=false，不可直接作最终验收 (Reported completeness only; not independently verified; cannot be accepted automatically)',
    normalizedEvidence: evidence,
  };
}

/**
 * Pure evaluation helper to determine if a task and its execution report can pass review.
 * Inherits honesty rules: source: 'reported', canAutoAccept: false, verified: false.
 */
export function canPassReview(task, evidenceOrReport) {
  const evidence = evidenceOrReport && isPlainObject(evidenceOrReport) && Reflect.has(evidenceOrReport, 'modifiedFiles')
    ? reportToEvidence(normalizeStructuredReport(evidenceOrReport))
    : evidenceOrReport;
  return verifyTaskEvidence(task, evidence);
}

/**
 * Normalizes subagent structured final report.
 */
const STRUCTURED_REPORT_FIELDS = [
  'summary',
  'completed',
  'unfinished',
  'modifiedFiles',
  'testResults',
  'risks',
  'nextSteps',
  'deliverables'
];

export function normalizeStructuredReport(input, label = 'report') {
  checkKeys(input, STRUCTURED_REPORT_FIELDS, label);

  const summary = Object.prototype.hasOwnProperty.call(input, 'summary')
    ? text(input.summary, `${label}.summary`, true)
    : '';

  const completed = Object.prototype.hasOwnProperty.call(input, 'completed')
    ? strings(input.completed, `${label}.completed`)
    : [];

  const unfinished = Object.prototype.hasOwnProperty.call(input, 'unfinished')
    ? strings(input.unfinished, `${label}.unfinished`)
    : [];

  const modifiedFiles = Object.prototype.hasOwnProperty.call(input, 'modifiedFiles')
    ? (() => {
        assertDenseArray(input.modifiedFiles, `${label}.modifiedFiles`);
        return input.modifiedFiles.map((f, idx) => validateSafeRelativePath(f, `${label}.modifiedFiles[${idx}]`));
      })()
    : [];
  assert(new Set(modifiedFiles).size === modifiedFiles.length, 'INVALID_INPUT', `${label}.modifiedFiles must not contain duplicates`);

  const testResults = Object.prototype.hasOwnProperty.call(input, 'testResults')
    ? (() => {
        assertDenseArray(input.testResults, `${label}.testResults`);
        return input.testResults.map((t, idx) => normalizeTestResult(t, `${label}.testResults[${idx}]`));
      })()
    : [];

  const risks = Object.prototype.hasOwnProperty.call(input, 'risks')
    ? strings(input.risks, `${label}.risks`)
    : [];

  const nextSteps = Object.prototype.hasOwnProperty.call(input, 'nextSteps')
    ? strings(input.nextSteps, `${label}.nextSteps`)
    : [];

  const deliverables = Object.prototype.hasOwnProperty.call(input, 'deliverables')
    ? (() => {
        assertDenseArray(input.deliverables, `${label}.deliverables`);
        return input.deliverables.map((d, idx) => {
          checkKeys(d, ['path', 'verified', 'note'], `${label}.deliverables[${idx}]`);
          return {
            path: validateSafeRelativePath(d.path, `${label}.deliverables[${idx}].path`),
            verified: bool(d.verified, `${label}.deliverables[${idx}].verified`),
            note: Object.prototype.hasOwnProperty.call(d, 'note') ? text(d.note, `${label}.deliverables[${idx}].note`, true) : '',
          };
        });
      })()
    : [];

  return { summary, completed, unfinished, modifiedFiles, testResults, risks, nextSteps, deliverables };
}

/**
 * Converts a structured report into standard evidence format.
 */
export function reportToEvidence(report) {
  const norm = normalizeStructuredReport(report);
  return {
    summary: norm.summary,
    files: norm.modifiedFiles,
    tests: norm.testResults,
    deliverables: norm.deliverables,
    unfinished: norm.unfinished,
    risks: norm.risks,
    metrics: null,
  };
}

/**
 * Formats a structured report into clean, verifiable Markdown text.
 */
export function formatReportMarkdown(report) {
  const norm = normalizeStructuredReport(report);
  const lines = [];

  lines.push('### 📋 任务执行分项汇报');
  if (norm.summary) {
    lines.push(`\n**概述**: ${norm.summary}`);
  }

  lines.push('\n#### 1. 已完成事项');
  if (norm.completed.length === 0) {
    lines.push('- (无)');
  } else {
    for (const item of norm.completed) lines.push(`- [x] ${item}`);
  }

  lines.push('\n#### 2. 未完成事项');
  if (norm.unfinished.length === 0) {
    lines.push('- (无)');
  } else {
    for (const item of norm.unfinished) lines.push(`- [ ] ${item}`);
  }

  lines.push('\n#### 3. 实际修改文件');
  if (norm.modifiedFiles.length === 0) {
    lines.push('- (未修改文件)');
  } else {
    for (const file of norm.modifiedFiles) lines.push(`- \`${file}\``);
  }

  lines.push('\n#### 4. 测试命令与真实结果');
  if (norm.testResults.length === 0) {
    lines.push('- (未运行自动化测试)');
  } else {
    for (const t of norm.testResults) {
      const statusIcon = t.passed ? '✅ 通过' : '❌ 失败';
      const exitCodeStr = t.exitCode !== null ? `退出码: ${t.exitCode}` : '退出码: 缺失/未提供';
      lines.push(`- **命令/用例**: \`${t.command || t.name}\` -> **${statusIcon}** (${exitCodeStr})`);
      if (t.output) {
        lines.push(`  - 输出摘要: ${t.output.trim().replace(/\n+/g, ' ')}`);
      }
    }
  }

  if (norm.deliverables.length > 0) {
    lines.push('\n#### 5. 关键成果核对');
    for (const d of norm.deliverables) {
      lines.push(`- [${d.verified ? 'x' : ' '}] \`${d.path}\`${d.note ? ` (${d.note})` : ''}`);
    }
  }

  if (norm.risks.length > 0) {
    lines.push('\n#### 6. 已知风险');
    for (const r of norm.risks) lines.push(`- ⚠️ ${r}`);
  }

  if (norm.nextSteps.length > 0) {
    lines.push('\n#### 7. 下一步建议');
    for (const step of norm.nextSteps) lines.push(`- ➡️ ${step}`);
  }

  return lines.join('\n');
}
