/**
 * Pure-function Quality Gate and Verifiable Acceptance Module.
 * 
 * 严格遵循验收裁决理念自主实现（不复制未经许可的外来源码）：
 * 1. 纯函数设计，不执行任何外部命令（零 shell、零子进程、零文件系统 I/O）；
 * 2. 评估测试命令退出状态、成果回执与写范围声明；
 * 3. 区分 passed / failed / unknown 三态，缺少实测、陈旧或仅口头声明一律判定为 unknown；
 * 4. 严格区分 worker reported 与宿主独立 trusted input：worker JSON 无法自选 trusted，
 *    reported exitCode 0 默认判定为 unknown，只有宿主独立上下文提供的回执可标 verified；
 * 5. canAutoAccept 始终为 false（本插件由主控审查验收，严禁自动放行）；
 * 6. 路径匹配与既有 core 一致：规范化处理，拒绝盘符、ADS colon、.. 路径穿越与空字节，
 *    scope 目录 src 正常包含 src/a，不启用 core 不支持的 glob 语义；
 * 7. 严守返工上限与用户批准边界：maxRetries 未提供时不默认 0（默认 2），
 *    初始 userApproved plan 绝不可替代超限返工授权。
 */

export class QualityGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QualityGateError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new QualityGateError(code, message); };
const assert = (condition, code, message) => { if (!condition) fail(code, message); };

/**
 * 校验并规范化安全的相对文件或目录路径。
 * 严格与 core 及 contracts 规范对齐：
 * - 拒绝绝对路径（/ 开头）
 * - 拒绝 Windows 盘符（^[a-zA-Z]:）
 * - 拒绝冒号 colon（ADS 备用数据流与非相对路径）
 * - 拒绝 UNC 网络路径（// 开头）
 * - 拒绝目录穿越段（..）
 * - 拒绝空字节（\0）
 * @param {string} input
 * @param {string} [label='path']
 * @returns {string} 规范化后的安全相对路径
 */
export function validateSafeRelativePath(input, label = 'path') {
  assert(typeof input === 'string', 'INVALID_INPUT', `${label} must be a string`);
  const raw = input.trim();
  assert(raw.length > 0, 'INVALID_PATH', `${label} must be a nonempty relative path`);
  assert(!raw.includes('\0'), 'INVALID_PATH', `${label} contains illegal null byte`);

  // 严格拒绝冒号：拦截盘符 (C:) 以及 NTFS 备用数据流 (ADS, 如 file.txt:stream)
  assert(!raw.includes(':'), 'INVALID_PATH', `${label} must not contain colon (drive letter or ADS): "${raw}"`);

  // 统一正斜杠
  const normalized = raw.replace(/\\/g, '/');

  // 拒绝绝对路径与 UNC 路径
  assert(!normalized.startsWith('/'), 'INVALID_PATH', `${label} must not be an absolute path: "${raw}"`);
  assert(!normalized.startsWith('//'), 'INVALID_PATH', `${label} must not be a UNC path: "${raw}"`);

  // 遍历段，拒绝 .. 穿越
  const segments = normalized.split('/');
  for (const seg of segments) {
    assert(seg !== '..', 'INVALID_PATH', `${label} must not contain directory traversal (".."): "${raw}"`);
  }

  // 剔除空段和单一 dot（如 ./foo -> foo）
  const cleaned = segments.filter((s) => s.length > 0 && s !== '.').join('/');
  assert(cleaned.length > 0, 'INVALID_PATH', `${label} resolves to an empty path: "${raw}"`);

  return cleaned;
}

/**
 * 判断指定文件路径是否在允许的 scope 模式内。
 * 严格遵循 core.mjs 的语义实现，不启用 core 不支持的 glob 语义（如 *、? 等）：
 * - '**' 或 '.' 匹配所有路径；
 * - 精确路径匹配（如 a.txt === a.txt）；
 * - 目录前缀匹配（如 scope 为 'src'，包含 'src/a.js'、'src/sub/b.js' 等）。
 * @param {string} filePath
 * @param {string} scopePattern
 * @returns {boolean}
 */
export function isPathInScope(filePath, scopePattern) {
  if (typeof filePath !== 'string' || typeof scopePattern !== 'string') return false;
  const s = scopePattern.trim().replace(/\\/g, '/').replace(/\/$/, '');
  const p = filePath.trim().replace(/\\/g, '/');
  if (s === '**' || s === '.') return true;
  return p === s || p.startsWith(`${s}/`);
}

/**
 * 判断指定文件是否在 scopes 列表内
 * @param {string} filePath
 * @param {string[]} scopes
 * @returns {boolean}
 */
export function isPathInScopes(filePath, scopes = []) {
  if (!Array.isArray(scopes) || scopes.length === 0) return false;
  return scopes.some((scope) => isPathInScope(filePath, scope));
}

/**
 * 校验时间戳的合法性与有效性
 * 拒绝：缺失、非有限数字、NaN、Infinity、-Infinity、<=0、非法日期字符串等
 * @param {*} val
 * @returns {number|null} 毫秒时间戳，非法则返回 null
 */
export function validateTimestamp(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || Number.isNaN(val) || val <= 0) return null;
    return val;
  }
  if (val instanceof Date) {
    const t = val.getTime();
    return Number.isFinite(t) && !Number.isNaN(t) && t > 0 ? t : null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === 'Infinity' || trimmed === '-Infinity' || trimmed === 'NaN' || trimmed.length === 0) {
      return null;
    }
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      return Number.isFinite(num) && num > 0 ? num : null;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

/**
 * 智能判定任务要求是否需要测试验证
 * @param {Object} contract
 * @returns {boolean}
 */
export function requiresTestVerification(contract = {}) {
  if (typeof contract.requireTestEvidence === 'boolean') {
    return contract.requireTestEvidence;
  }
  if (contract.taskType === 'test') return true;

  const textSources = [];
  if (typeof contract.acceptance === 'string') {
    textSources.push(contract.acceptance);
  } else if (Array.isArray(contract.acceptance)) {
    textSources.push(...contract.acceptance.filter((a) => typeof a === 'string'));
  }
  if (typeof contract.title === 'string') textSources.push(contract.title);
  if (typeof contract.instructions === 'string') textSources.push(contract.instructions);

  const combined = textSources.join('\n');
  const testPatterns = [
    /test/i,
    /测试/u,
    /验证/u,
    /验签/u,
    /spec/i,
    /coverage/i,
    /suite/i,
    /unit\s*test/i,
    /integration/i
  ];
  return testPatterns.some((pattern) => pattern.test(combined));
}

/**
 * 核查写范围与只读要求合规性
 * @param {Object} contract
 * @param {Object} submission
 * @returns {{ passed: boolean, findings: Array, outOfScopeFiles: string[] }}
 */
export function checkScopeCompliance(contract = {}, submission = {}) {
  const findings = [];
  const outOfScopeFiles = [];

  const isReadOnly = Boolean(contract.readOnly || (contract.member && contract.member.readOnly));
  const scopes = Array.isArray(contract.writeScopes) ? contract.writeScopes : [];

  // 防御性过滤非数组与非合法项
  const rawTouched = Array.isArray(submission.touchedFiles)
    ? submission.touchedFiles
    : (Array.isArray(submission.modifiedFiles) ? submission.modifiedFiles : []);
  const touchedFiles = rawTouched.filter((f) => typeof f === 'string' && f.trim().length > 0);

  const rawDeclared = Array.isArray(submission.declaredFiles) ? submission.declaredFiles : [];
  const declaredFiles = rawDeclared.filter((f) => typeof f === 'string' && f.trim().length > 0);

  // 1. 只读要求校验
  if (isReadOnly) {
    if (touchedFiles.length > 0) {
      findings.push({
        category: 'readonly',
        level: 'error',
        code: 'READONLY_TOUCHED_VIOLATION',
        message: `只读要求被破坏：当前任务或成员为只读，但实际修改了 ${touchedFiles.length} 个文件`,
        details: { touchedFiles }
      });
      outOfScopeFiles.push(...touchedFiles);
    }
    if (declaredFiles.length > 0) {
      findings.push({
        category: 'readonly',
        level: 'error',
        code: 'READONLY_DECLARED_VIOLATION',
        message: '只读要求被破坏：只读任务不可声明任何修改文件范围',
        details: { declaredFiles }
      });
    }
    return {
      passed: findings.length === 0,
      findings,
      outOfScopeFiles: Array.from(new Set(outOfScopeFiles))
    };
  }

  // 2. 可写任务核查
  if ((touchedFiles.length > 0 || declaredFiles.length > 0) && scopes.length === 0) {
    findings.push({
      category: 'scope',
      level: 'error',
      code: 'MISSING_WRITE_SCOPES_DECLARATION',
      message: '可写任务修改了文件，但要求中未声明任何 writeScopes 授权',
      details: { touchedFiles, declaredFiles }
    });
    outOfScopeFiles.push(...touchedFiles);
    return {
      passed: false,
      findings,
      outOfScopeFiles: Array.from(new Set(outOfScopeFiles))
    };
  }

  // 校验每个被触及文件的安全性与 scope 包含性
  for (const file of touchedFiles) {
    let safePath;
    try {
      safePath = validateSafeRelativePath(file, 'submission.touchedFiles');
    } catch (err) {
      findings.push({
        category: 'scope',
        level: 'error',
        code: 'INVALID_FILE_PATH',
        message: `触及的文件路径非法或存在越权风险: "${file}" (${err.message})`,
        details: { file, error: err.message }
      });
      outOfScopeFiles.push(file);
      continue;
    }

    if (!isPathInScopes(safePath, scopes)) {
      findings.push({
        category: 'scope',
        level: 'error',
        code: 'OUT_OF_SCOPE_MODIFICATION',
        message: `触及文件超出要求 writeScopes 授权范围: "${safePath}"`,
        details: { file: safePath, scopes }
      });
      outOfScopeFiles.push(safePath);
    }
  }

  return {
    passed: findings.length === 0,
    findings,
    outOfScopeFiles: Array.from(new Set(outOfScopeFiles))
  };
}

/**
 * 核查测试命令客观执行结果与新鲜度
 * 严格区分 reported 与宿主独立 trusted 实测结果：
 * - worker JSON 中的 testRuns 无论是否声称 exitCode 0，属于自报 (reported)，默认判定为 unknown；
 * - 只有 hostContext.trustedRuns 中由宿主独立注入的执行回执，才属于 verified；
 * - exitCode !== 0（不论 reported 还是 trusted）直接判定为 failed；
 * - 时间戳缺失、invalid、Infinity、早于开始基线，或执行 epoch 不匹配，判定为 unknown；
 * - 对 null/undefined 元素防御，绝不崩溃。
 * @param {Object} contract
 * @param {Object} submission
 * @param {Object} [hostContext={}]
 * @returns {{ verdict: 'passed'|'failed'|'unknown', findings: Array, metrics: Object }}
 */
export function checkEvidenceValidity(contract = {}, submission = {}, hostContext = {}) {
  const findings = [];
  const needTest = requiresTestVerification(contract);

  let testsPassedCount = 0;
  let testsFailedCount = 0;
  let missingEvidenceCount = 0;
  let staleEvidenceCount = 0;
  let unverifiedReportedCount = 0;

  // 1. 执行 Epoch 匹配核查（防陈旧代次实测结果）
  const contractEpoch = Number.isInteger(contract.executionEpoch) ? contract.executionEpoch : 0;
  if (contractEpoch > 0) {
    const subEpoch = Number.isInteger(submission.executionEpoch) ? submission.executionEpoch : null;
    if (subEpoch === null || subEpoch !== contractEpoch) {
      findings.push({
        category: 'epoch',
        level: 'error',
        code: 'EXECUTION_EPOCH_MISMATCH',
        message: `执行结果 Epoch 不匹配：要求当前为 Epoch ${contractEpoch}，提交回执为 ${subEpoch ?? '缺失'}，判定为陈旧无效结果`,
        details: { contractEpoch, subEpoch }
      });
      return {
        verdict: 'unknown',
        findings,
        metrics: { testsPassedCount: 0, testsFailedCount: 0, missingEvidenceCount: 1, staleEvidenceCount: 1, unverifiedReportedCount: 0 }
      };
    }
  }

  // 2. 基准开始时间核查
  const baselineStartedAt = validateTimestamp(submission.startedAt) ?? validateTimestamp(hostContext.startedAt);

  // 3. 提取受信任测试集与自报测试集
  const rawTrustedRuns = Array.isArray(hostContext.trustedRuns) ? hostContext.trustedRuns : [];
  const trustedRuns = rawTrustedRuns.filter((r) => r !== null && typeof r === 'object');

  const rawReportedRuns = Array.isArray(submission.testRuns)
    ? submission.testRuns
    : (Array.isArray(submission.testResults) ? submission.testResults : []);
  // 防御性过滤非对象与 null 元素，同时记录异常元素
  const reportedRuns = [];
  for (let i = 0; i < rawReportedRuns.length; i++) {
    const item = rawReportedRuns[i];
    if (item === null || typeof item !== 'object') {
      findings.push({
        category: 'test',
        level: 'warning',
        code: 'MALFORMED_TEST_RUN_ELEMENT',
        message: `测试记录索引 [${i}] 格式异常 (非对象或为 null)，已忽略`,
        details: { item }
      });
      missingEvidenceCount++;
      continue;
    }
    reportedRuns.push(item);
  }

  // 4. 若无任何测试记录
  if (trustedRuns.length === 0 && reportedRuns.length === 0) {
    if (needTest) {
      missingEvidenceCount++;
      findings.push({
        category: 'test',
        level: 'error',
        code: 'MISSING_TEST_EVIDENCE',
        message: '要求自动化测试验证，但未提供任何客观测试执行记录 (testRuns)',
        details: { requireTestEvidence: needTest }
      });
      return {
        verdict: 'unknown',
        findings,
        metrics: { testsPassedCount, testsFailedCount, missingEvidenceCount, staleEvidenceCount, unverifiedReportedCount }
      };
    }

    // 不需要测试且无测试记录：检查是否有实质工作实测结果 (touchedFiles / declaredFiles 或 deliverables 等客观可核对象)
    const rawFiles = Array.isArray(submission.touchedFiles)
      ? submission.touchedFiles
      : (Array.isArray(submission.modifiedFiles) ? submission.modifiedFiles : []);
    const touchedFiles = rawFiles.filter((f) => typeof f === 'string' && f.trim().length > 0);

    const rawDeclared = Array.isArray(submission.declaredFiles) ? submission.declaredFiles : [];
    const declaredFiles = rawDeclared.filter((f) => typeof f === 'string' && f.trim().length > 0);

    const hasFiles = touchedFiles.length > 0 || declaredFiles.length > 0;

    const rawSubDeliverables = Array.isArray(submission.deliverables) ? submission.deliverables : [];
    const subDeliverables = rawSubDeliverables.filter((d) => d !== null && typeof d === 'object');
    const rawTrustedDeliverables = Array.isArray(hostContext.trustedDeliverables) ? hostContext.trustedDeliverables : [];
    const trustedDeliverables = rawTrustedDeliverables.filter((d) => d !== null && typeof d === 'object');
    const hasDeliverables = subDeliverables.length > 0 || trustedDeliverables.length > 0;

    const hasSummary = typeof submission.summary === 'string' && submission.summary.trim().length > 0;

    // 核心安全原则：仅有 summary 属于口头自述，必须 unknown；
    // 只有存在 touchedFiles/declaredFiles 或 deliverables 等可核对象时才允许该分支通过（后续由范围/成果检查核验）。
    if (!hasFiles && !hasDeliverables) {
      missingEvidenceCount++;
      findings.push({
        category: 'evidence',
        level: 'warning',
        code: hasSummary ? 'ORAL_SUMMARY_ONLY_UNVERIFIED' : 'EMPTY_SUBMISSION_EVIDENCE',
        message: hasSummary
          ? '仅提供口头自述 (summary) 缺少实际文件修改或成果等可核对实测结果，判定为 unknown'
          : '提交回执为空且缺失任何实际修改文件、成果等可核验实测结果，无法确证任务完成',
        details: { submission }
      });
      return {
        verdict: 'unknown',
        findings,
        metrics: { testsPassedCount, testsFailedCount, missingEvidenceCount, staleEvidenceCount, unverifiedReportedCount }
      };
    }

    return {
      verdict: 'passed',
      findings,
      metrics: { testsPassedCount, testsFailedCount, missingEvidenceCount, staleEvidenceCount, unverifiedReportedCount }
    };
  }

  // 5. 优先评估宿主独立受信任测试 (hostContext.trustedRuns)
  let hasTrustedFailure = false;
  let hasTrustedUnknown = false;

  if (trustedRuns.length > 0) {
    for (let idx = 0; idx < trustedRuns.length; idx++) {
      const run = trustedRuns[idx];
      const prefix = `宿主受信任测试 #${idx + 1} (${run.command || run.name || 'cmd'}): `;

      if (run.exitCode === undefined || run.exitCode === null || !Number.isInteger(run.exitCode)) {
        hasTrustedUnknown = true;
        missingEvidenceCount++;
        findings.push({
          category: 'test',
          level: 'error',
          code: 'TRUSTED_RUN_MISSING_EXITCODE',
          message: `${prefix}缺少命令退出状态码 exitCode`,
          details: { run }
        });
        continue;
      }

      if (run.exitCode !== 0) {
        hasTrustedFailure = true;
        testsFailedCount++;
        findings.push({
          category: 'test',
          level: 'error',
          code: 'TRUSTED_TEST_FAILED',
          message: `${prefix}执行失败，退出状态码为 ${run.exitCode}`,
          details: { command: run.command, exitCode: run.exitCode, output: run.output }
        });
        continue;
      }

      // 时间戳校验
      if (run.timestamp !== undefined) {
        const ts = validateTimestamp(run.timestamp);
        if (ts === null) {
          hasTrustedUnknown = true;
          staleEvidenceCount++;
          findings.push({
            category: 'timestamp',
            level: 'error',
            code: 'INVALID_TIMESTAMP',
            message: `${prefix}时间戳非法或非有限数值: ${run.timestamp}`,
            details: { timestamp: run.timestamp }
          });
          continue;
        }
        if (baselineStartedAt !== null && ts < baselineStartedAt) {
          hasTrustedUnknown = true;
          staleEvidenceCount++;
          findings.push({
            category: 'timestamp',
            level: 'warning',
            code: 'STALE_TEST_EVIDENCE',
            message: `${prefix}测试时间早于任务启动基线时间，疑似陈旧结果`,
            details: { testTimestamp: ts, baselineStartedAt }
          });
          continue;
        }
      }

      testsPassedCount++;
    }

    if (hasTrustedFailure) {
      return {
        verdict: 'failed',
        findings,
        metrics: { testsPassedCount, testsFailedCount, missingEvidenceCount, staleEvidenceCount, unverifiedReportedCount }
      };
    }
    if (hasTrustedUnknown) {
      return {
        verdict: 'unknown',
        findings,
        metrics: { testsPassedCount, testsFailedCount, missingEvidenceCount, staleEvidenceCount, unverifiedReportedCount }
      };
    }

    // 宿主独立测试完全通过
    return {
      verdict: 'passed',
      findings,
      metrics: { testsPassedCount, testsFailedCount, missingEvidenceCount, staleEvidenceCount, unverifiedReportedCount }
    };
  }

  // 6. 仅有 worker 自报测试 (reportedRuns)
  // 核心安全原则：worker 自称 exitCode 0 不可直接当客观验证，默认 reported => unknown；若 exitCode !== 0 则 failed
  let hasReportedFailure = false;

  for (let idx = 0; idx < reportedRuns.length; idx++) {
    const run = reportedRuns[idx];
    const prefix = `子模型自报测试 #${idx + 1} (${run.command || run.name || 'cmd'}): `;

    // 拒绝由 worker JSON 自选 trusted / verified
    if (run.trusted === true || run.verified === true) {
      findings.push({
        category: 'security',
        level: 'warning',
        code: 'UNTRUSTED_SELF_CLAIM_IGNORED',
        message: `${prefix}自称包含 trusted/verified 标记，但该标记必须由宿主环境独立注入，已强制作为 reported 处理`,
        details: { run }
      });
    }

    // 检查 exitCode
    if (run.exitCode === undefined || run.exitCode === null || !Number.isInteger(run.exitCode)) {
      missingEvidenceCount++;
      findings.push({
        category: 'test',
        level: 'error',
        code: 'INCOMPLETE_TEST_EVIDENCE',
        message: `${prefix}缺少命令退出状态码 (exitCode)，无法确认执行结果`,
        details: { run }
      });
      continue;
    }

    if (run.exitCode !== 0) {
      hasReportedFailure = true;
      testsFailedCount++;
      findings.push({
        category: 'test',
        level: 'error',
        code: 'TEST_EXECUTION_FAILED',
        message: `${prefix}执行明确失败，退出状态码为 ${run.exitCode}`,
        details: { command: run.command, exitCode: run.exitCode, output: run.output }
      });
      continue;
    }

    // exitCode === 0，核验时间戳
    const runTimeMs = validateTimestamp(run.timestamp);
    if (run.timestamp !== undefined && runTimeMs === null) {
      staleEvidenceCount++;
      findings.push({
        category: 'timestamp',
        level: 'error',
        code: 'INVALID_TIMESTAMP',
        message: `${prefix}测试时间戳非法、非有限数或为 Infinity: "${run.timestamp}"`,
        details: { timestamp: run.timestamp }
      });
      continue;
    }

    if (baselineStartedAt !== null && runTimeMs !== null && runTimeMs < baselineStartedAt) {
      staleEvidenceCount++;
      findings.push({
        category: 'timestamp',
        level: 'warning',
        code: 'STALE_TEST_EVIDENCE',
        message: `${prefix}执行结果已陈旧：测试执行时间早于任务开始基线`,
        details: { runTimestamp: run.timestamp, baselineStartedAt }
      });
      continue;
    }

    unverifiedReportedCount++;
    findings.push({
      category: 'test',
      level: 'warning',
      code: 'REPORTED_TEST_UNVERIFIED_BY_HOST',
      message: `${prefix}虽自报 exitCode 为 0，但缺少宿主环境独立验证回执，按安全策略保持 unknown 状态等待主控核实`,
      details: { command: run.command, exitCode: run.exitCode }
    });
  }

  if (hasReportedFailure) {
    return {
      verdict: 'failed',
      findings,
      metrics: { testsPassedCount: 0, testsFailedCount, missingEvidenceCount, staleEvidenceCount, unverifiedReportedCount }
    };
  }

  // 自报通过但在宿主中未经独立验证 => unknown
  return {
    verdict: 'unknown',
    findings,
    metrics: { testsPassedCount: 0, testsFailedCount, missingEvidenceCount, staleEvidenceCount, unverifiedReportedCount }
  };
}

/**
 * 核查成果回执
 * 规则：
 * 1. 要求中声明的必需成果遗漏 => failed；
 * 2. 成果明确标记 exists === false => failed；
 * 3. 成果未提供客观 exists 证明（exists 为 null/undefined）或未由宿主 verified => unknown；
 * 4. 容忍 null/undefined/格式错误元素，绝不崩溃。
 * @param {Object} contract
 * @param {Object} submission
 * @param {Object} [hostContext={}]
 * @returns {{ passed: boolean, verdict: 'passed'|'failed'|'unknown', findings: Array }}
 */
export function checkDeliverables(contract = {}, submission = {}, hostContext = {}) {
  const findings = [];
  const contractDeliverables = Array.isArray(contract.deliverables) ? contract.deliverables : [];
  const rawSubDeliverables = Array.isArray(submission.deliverables) ? submission.deliverables : [];
  const subDeliverables = rawSubDeliverables.filter((d) => d !== null && typeof d === 'object');

  const rawTrustedDeliverables = Array.isArray(hostContext.trustedDeliverables) ? hostContext.trustedDeliverables : [];
  const trustedMap = new Map();

  let hasFailed = false;
  let hasUnknown = false;

  // 1. 解析与评估宿主独立受信任成果 (hostContext.trustedDeliverables)
  for (const td of rawTrustedDeliverables) {
    if (!td || typeof td !== 'object') continue;
    if (typeof td.path !== 'string') continue;
    let normPath;
    try {
      normPath = validateSafeRelativePath(td.path, 'hostContext.trustedDeliverables');
    } catch (err) {
      hasFailed = true;
      findings.push({
        category: 'deliverable',
        level: 'error',
        code: 'INVALID_DELIVERABLE_PATH',
        message: `宿主受信任成果路径非法: "${td.path}" (${err.message})`,
        details: td
      });
      continue;
    }

    trustedMap.set(normPath, td);

    // 核心安全规则：
    // trusted 条目必须显式 exists===true 才算证实，exists===false 为 failed，缺失/null 为 unknown
    if (td.exists === false) {
      hasFailed = true;
      findings.push({
        category: 'deliverable',
        level: 'error',
        code: 'DELIVERABLE_CONFIRMED_MISSING',
        message: `宿主受信任回执明确证实成果不存在: "${normPath}"`,
        details: td
      });
    } else if (td.exists === true) {
      // 显式证实存在，有效通过
    } else {
      // exists 缺失、为 null 或未提供显式布尔值 true
      hasUnknown = true;
      findings.push({
        category: 'deliverable',
        level: 'warning',
        code: 'TRUSTED_DELIVERABLE_EXISTENCE_UNVERIFIED',
        message: `宿主受信任成果 "${normPath}" 未提供显式 exists: true 证实实测结果 (exists 缺失或为 null)，判定为 unknown`,
        details: td
      });
    }
  }

  // 2. 解析 worker 提交的成果 (submission.deliverables)
  const subMap = new Map();
  for (const sd of subDeliverables) {
    if (typeof sd.path !== 'string') continue;
    let normPath;
    try {
      normPath = validateSafeRelativePath(sd.path, 'submission.deliverables');
    } catch (err) {
      hasFailed = true;
      findings.push({
        category: 'deliverable',
        level: 'error',
        code: 'INVALID_DELIVERABLE_PATH',
        message: `提交的成果路径非法: "${sd.path}" (${err.message})`,
        details: sd
      });
      continue;
    }
    subMap.set(normPath, sd);
  }

  // 3. 要求必需成果核验 (contract.deliverables)
  for (const req of contractDeliverables) {
    if (!req || typeof req.path !== 'string') continue;
    let normPath;
    try {
      normPath = validateSafeRelativePath(req.path, 'contract.deliverables');
    } catch {
      continue;
    }
    const isRequired = req.required !== false;

    const reported = subMap.get(normPath);
    const trusted = trustedMap.get(normPath);

    // 必需成果未在提交回执中列出且宿主未提供任何记录
    if (isRequired && !reported && !trusted) {
      hasFailed = true;
      findings.push({
        category: 'deliverable',
        level: 'error',
        code: 'MISSING_REQUIRED_DELIVERABLE',
        message: `要求的必需成果未提交: "${normPath}"`,
        details: req
      });
      continue;
    }

    // 若有 trusted 记录，前面在 step 1 中已经处理了 exists 的各种情况 (false -> failed, true -> ok, null/undefined -> unknown)
    if (trusted) {
      continue;
    }

    // 若无 trusted 记录，仅有 worker reported
    if (reported) {
      if (reported.exists === false) {
        hasFailed = true;
        findings.push({
          category: 'deliverable',
          level: 'error',
          code: 'DELIVERABLE_NOT_FOUND',
          message: `成果未生成或明确标记不存在: "${normPath}"`,
          details: reported
        });
      } else if (reported.exists !== true) {
        // 未提供 exists 实测结果（exists 为 undefined/null）
        hasUnknown = true;
        findings.push({
          category: 'deliverable',
          level: 'warning',
          code: 'DELIVERABLE_EXISTENCE_UNVERIFIED',
          message: `成果 "${normPath}" 未提供存在性证明 (exists 未提供)，无法确认是否生成`,
          details: reported
        });
      }
    }
  }

  // 4. 检查 submission 里未在 contract.deliverables 中声明但额外提交的成果
  for (const [path, item] of subMap.entries()) {
    // 如果该成果已有 trusted 记录，则以 trusted 评估结果为准 (在 step 1 已评估过)
    const trusted = trustedMap.get(path);
    if (trusted) {
      continue;
    }

    if (item.exists === false) {
      hasFailed = true;
      findings.push({
        category: 'deliverable',
        level: 'error',
        code: 'DELIVERABLE_NOT_FOUND',
        message: `成果未生成: "${path}"`,
        details: item
      });
    } else if (item.exists !== true) {
      hasUnknown = true;
      findings.push({
        category: 'deliverable',
        level: 'warning',
        code: 'DELIVERABLE_EXISTENCE_UNVERIFIED',
        message: `提交的成果 "${path}" 未提供 exists 状态证明`,
        details: item
      });
    }
  }

  let verdict = 'passed';
  if (hasFailed) {
    verdict = 'failed';
  } else if (hasUnknown) {
    verdict = 'unknown';
  }

  return {
    passed: verdict === 'passed',
    verdict,
    findings
  };
}

/**
 * 核查返工上限与安全批准边界
 * 规则：
 * 1. maxRetries 未提供时不默认 0（默认 2，与 host 及 core 保持一致）；
 * 2. 初始规划批准 (userApproved plan) 绝对不能替代超限返工授权；
 * 3. 只有专门的用户超限重试授权 (userApprovedRework) 才能解除超限暂停。
 * @param {Object} contract
 * @param {'passed'|'failed'|'unknown'} tentativeVerdict
 * @param {Object} [hostContext={}]
 * @returns {{ reworkLimitExceeded: boolean, requiresUserApproval: boolean, maxRetries: number, retries: number, findings: Array }}
 */
export function checkSafetyBoundaries(contract = {}, tentativeVerdict = 'passed', hostContext = {}) {
  const findings = [];
  const retries = Number.isInteger(contract.retries) ? contract.retries : 0;
  // 安全修复：maxRetries 未提供时不默认 0，默认 2
  const maxRetries = Number.isInteger(contract.maxRetries)
    ? contract.maxRetries
    : (Number.isInteger(hostContext.maxRetries) ? hostContext.maxRetries : 2);

  // 严正区分：userApproved 是规划阶段的批准，不可替代超限返工授权
  const reworkApproved = Boolean(contract.userApprovedRework || hostContext.userApprovedRework);

  const needsRework = tentativeVerdict !== 'passed';
  const reworkLimitExceeded = needsRework && retries >= maxRetries;
  const requiresUserApproval = reworkLimitExceeded && !reworkApproved;

  if (requiresUserApproval) {
    findings.push({
      category: 'safety',
      level: 'warning',
      code: 'REWORK_LIMIT_EXCEEDED_REQUIRES_APPROVAL',
      message: `任务已达到返工上限 (已尝试: ${retries} / 最大允许: ${maxRetries})。初始规划批准不能替代超限返工授权，必须暂停并向用户申请明确返工许可`,
      details: { retries, maxRetries, planApproved: Boolean(contract.userApproved), reworkApproved }
    });
  }

  return {
    reworkLimitExceeded,
    requiresUserApproval,
    maxRetries,
    retries,
    findings
  };
}

/**
 * 纯函数：全面评估验收把关与验收裁决
 * @param {Object} contract 任务要求
 * @param {Object} submission 执行提交回执
 * @param {Object} [hostContext={}] 宿主独立环境上下文
 * @returns {Object} 完整判定结果
 */
export function evaluateQualityGate(contract = {}, submission = {}, hostContext = {}) {
  // 1. 写范围与只读要求检查
  const scopeResult = checkScopeCompliance(contract, submission);

  // 2. 实测结果核查 (区分 reported 与 trusted)
  const evidenceResult = checkEvidenceValidity(contract, submission, hostContext);

  // 3. 成果回执核查
  const deliverableResult = checkDeliverables(contract, submission, hostContext);

  // 整合所有 findings
  const allFindings = [
    ...scopeResult.findings,
    ...evidenceResult.findings,
    ...deliverableResult.findings
  ];

  // 4. 初步裁决判断
  let verdict = 'passed';
  if (!scopeResult.passed || deliverableResult.verdict === 'failed' || evidenceResult.verdict === 'failed') {
    verdict = 'failed';
  } else if (evidenceResult.verdict === 'unknown' || deliverableResult.verdict === 'unknown') {
    verdict = 'unknown';
  }

  // 5. 返工上限与安全审批核查
  const safety = checkSafetyBoundaries(contract, verdict, hostContext);
  allFindings.push(...safety.findings);

  // 6. canAutoAccept 始终为 false（本插件由 Astra 主控根据验收把关摘要决定是否通过并关闭任务）
  const canAutoAccept = false;

  // 提取主要原因
  const reasons = allFindings.map((f) => f.message);
  if (reasons.length === 0 && verdict === 'passed') {
    reasons.push('要求核验完全通过：写范围合规，测试退出状态均为 0，实测结果有效且新鲜');
  }

  const result = {
    taskId: contract.id || 'unknown-task',
    taskTitle: contract.title || '未命名任务',
    verdict,
    canAutoAccept,
    reasons,
    findings: allFindings,
    metrics: {
      scopeViolationsCount: scopeResult.outOfScopeFiles.length,
      ...evidenceResult.metrics
    },
    safety,
    summary: ''
  };

  // 7. 生成面向主控审查的摘要
  result.summary = generateReviewSummary(result, contract, submission, hostContext);

  return result;
}

/**
 * 生成主控可读的审查摘要 Markdown
 * @param {Object} result
 * @param {Object} contract
 * @param {Object} submission
 * @param {Object} [hostContext={}]
 * @returns {string}
 */
export function generateReviewSummary(result, contract = {}, submission = {}, hostContext = {}) {
  const { taskId, taskTitle, verdict, canAutoAccept, metrics, safety, findings } = result;

  const verdictBadge = {
    passed: '✅【PASSED 通过】',
    failed: '❌【FAILED 失败】',
    unknown: '⚠️【UNKNOWN 结果不足/需补充核验】'
  }[verdict] || verdict;

  const autoAcceptBadge = canAutoAccept ? '🟢 允许自动验收' : '🔒 需主控审查 (严格禁用自动验收)';

  const lines = [
    `### 验收把关报告: ${taskId} (${taskTitle})`,
    `- **最终裁决**: ${verdictBadge}`,
    `- **自动验收控制**: ${autoAcceptBadge}`,
    `- **返工状态（本次审查前）**: 已返工 ${safety.retries} / 上限 ${safety.maxRetries} 次`,
    ...(typeof hostContext.reviewPassed === 'boolean' ? [hostContext.reviewPassed
      ? `- **本次审查处理**: 通过；返工计数保持 ${safety.retries} / ${safety.maxRetries} 次`
      : safety.retries < safety.maxRetries
        ? `- **本次打回后**: 进入第 ${safety.retries + 1} 次返工；返工计数 ${safety.retries + 1} / ${safety.maxRetries} 次`
        : `- **本次打回后**: 已达返工上限，暂停并等待用户专门授权；返工计数保持 ${safety.retries} / ${safety.maxRetries} 次`] : []),
    '',
    '#### 📊 指标核对',
    `- 范围违规文件数: ${metrics.scopeViolationsCount || 0}`,
    `- 实测通过数: ${metrics.testsPassedCount || 0}`,
    `- 测试失败命令数: ${metrics.testsFailedCount || 0}`,
    `- 缺少实测项数: ${metrics.missingEvidenceCount || 0}`,
    `- 陈旧/非法结果数: ${metrics.staleEvidenceCount || 0}`,
    `- 成员成员自报未验证测试数: ${metrics.unverifiedReportedCount || 0}`,
    ''
  ];

  if (findings.length > 0) {
    lines.push('#### 🔍 发现项与违背详情');
    for (const f of findings) {
      const tag = f.level === 'error' ? '❌ [严重]' : f.level === 'warning' ? '⚠️ [警告]' : 'ℹ️ [提示]';
      lines.push(`- ${tag} [${f.category}/${f.code}] ${f.message}`);
    }
    lines.push('');
  }

  lines.push('#### 🎯 主控操作建议');
  if (verdict === 'passed') {
    lines.push('1. 实测结果充分完整，建议主控批准并通过验收 (设置任务状态为 done)。');
  } else if (verdict === 'failed') {
    if (safety.requiresUserApproval) {
      lines.push('1. 任务存在确定违规或测试失败，且**已达到最大返工上限**。');
      lines.push('2. 禁止私自继续返工，主控必须通过 `ask_user_question` 征得用户明确批准后再行恢复。');
    } else {
      lines.push('1. 任务存在明确违背（如测试失败、超范围修改或缺失必需成果），建议退回修改并指明具体返工要求。');
    }
  } else {
    lines.push('1. **缺少实测结果、结果陈旧或仅有成员自报声明**，绝对不可自动验收。');
    lines.push('2. 请要求执行子模型提供实际运行测试的真实输出日志，或由主控在宿主独立环境运行验证命令。');
  }

  return lines.join('\n');
}

/**
 * 规划质量门禁与合理性核查
 * 检查规划中结构化理由说明 (planningRationale, parallelizationJustification, dependencyJustification, idleMembersJustification)
 * 1. 结构化错误携带 code 与 remedy；
 * 2. 不要机械要求任务数等于成员数（允许成员空闲，不因 idle 报错）；
 * 3. 存在并行任务时核验 parallelizationJustification；
 * 4. 存在依赖任务时核验 dependencyJustification；
 * 5. 纯函数设计，无环境副作用。
 * @param {Array|Object} planInput
 * @param {Object} [options={}]
 * @returns {{ passed: boolean, code?: string, message?: string, remedy?: string, findings: Array, metadata: Object }}
 */
export function checkPlanningQuality(planInput, options = {}) {
  const findings = [];

  let tasks = [];
  let planningRationale = null;
  let parallelizationJustification = null;
  let dependencyJustification = null;
  let idleMembersJustification = null;

  if (Array.isArray(planInput)) {
    tasks = planInput;
    planningRationale = options.planningRationale ?? null;
    parallelizationJustification = options.parallelizationJustification ?? null;
    dependencyJustification = options.dependencyJustification ?? null;
    idleMembersJustification = options.idleMembersJustification ?? null;
  } else if (planInput && typeof planInput === 'object') {
    tasks = Array.isArray(planInput.tasks) ? planInput.tasks : [];
    planningRationale = planInput.planningRationale ?? planInput.rationale ?? options.planningRationale ?? null;
    parallelizationJustification = planInput.parallelizationJustification ?? planInput.parallelRationale ?? options.parallelizationJustification ?? null;
    dependencyJustification = planInput.dependencyJustification ?? planInput.dependencyRationale ?? options.dependencyJustification ?? null;
    idleMembersJustification = planInput.idleMembersJustification ?? planInput.idleMemberRationale ?? options.idleMembersJustification ?? null;
  }

  // 1. 基础任务列表合法性检查
  if (!Array.isArray(tasks) || tasks.length === 0) {
    findings.push({
      category: 'planning',
      level: 'error',
      code: 'EMPTY_PLAN_TASKS',
      message: '规划任务列表不能为空'
    });
    return {
      passed: false,
      code: 'EMPTY_PLAN_TASKS',
      message: '规划任务列表不能为空',
      remedy: '请提供包含具体子任务定义的非空任务列表。',
      findings,
      metadata: {}
    };
  }

  // 2. 分析并行任务 (DAG 中互不依赖且可并发执行的任务)
  const taskIds = new Set(tasks.map(t => t.id));
  const directDeps = new Map();
  for (const t of tasks) {
    const deps = Array.isArray(t.dependencies) ? t.dependencies.filter(d => taskIds.has(d)) : [];
    directDeps.set(t.id, new Set(deps));
  }
  // 计算可达闭包 (all dependencies recursively)
  const allDeps = new Map();
  for (const t of tasks) {
    const visited = new Set();
    const stack = [...(directDeps.get(t.id) || [])];
    while (stack.length > 0) {
      const dep = stack.pop();
      if (!visited.has(dep)) {
        visited.add(dep);
        for (const next of (directDeps.get(dep) || [])) {
          stack.push(next);
        }
      }
    }
    allDeps.set(t.id, visited);
  }

  // 检查是否存在互不依赖的任务对（可并行）
  let hasParallelTasks = false;
  const parallelPairs = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const idA = tasks[i].id;
      const idB = tasks[j].id;
      const aDependsOnB = allDeps.get(idA)?.has(idB);
      const bDependsOnA = allDeps.get(idB)?.has(idA);
      if (!aDependsOnB && !bDependsOnA) {
        hasParallelTasks = true;
        parallelPairs.push([idA, idB]);
      }
    }
  }

  // 3. 并行化理由核查 (Parallelization Justification Gate)
  const isParallelString = typeof parallelizationJustification === 'string' && parallelizationJustification.trim().length > 0;
  if (hasParallelTasks && !isParallelString) {
    const msg = '规划包含可并行执行任务，但缺失 parallelizationJustification 并行化理由说明';
    findings.push({
      category: 'planning',
      level: 'error',
      code: 'MISSING_PARALLELIZATION_JUSTIFICATION',
      message: msg,
      details: { parallelPairs: parallelPairs.slice(0, 5) }
    });
    return {
      passed: false,
      code: 'MISSING_PARALLELIZATION_JUSTIFICATION',
      message: msg,
      remedy: '请补充 parallelizationJustification 字段，说明并发调度理由以及各任务写入范围互不冲突的依据。',
      findings,
      metadata: { hasParallelTasks, parallelPairs }
    };
  }

  // 4. 串行依赖理由核查 (Dependency Justification Gate)
  const hasDependencies = tasks.some(t => Array.isArray(t.dependencies) && t.dependencies.length > 0);
  const isDepString = typeof dependencyJustification === 'string' && dependencyJustification.trim().length > 0;
  const isRationaleString = typeof planningRationale === 'string' && planningRationale.trim().length > 0;
  if (hasDependencies && !isDepString && !isRationaleString) {
    findings.push({
      category: 'planning',
      level: 'warning',
      code: 'MISSING_DEPENDENCY_JUSTIFICATION',
      message: '规划包含串行依赖关系，建议在 dependencyJustification 或 planningRationale 中补充依赖顺序说明',
      details: { tasksWithDeps: tasks.filter(t => t.dependencies?.length).map(t => t.id) }
    });
  }

  // 5. 空闲成员核查 (Idle-Member Justification Gate) - 严禁机械要求任务数等于成员数
  const members = Array.isArray(options.members) ? options.members : [];
  if (members.length > 0) {
    const enabledMembers = members.filter(m => m.enabled !== false);
    const assignedMemberIds = new Set(tasks.map(t => t.memberId).filter(Boolean));
    const idleMembers = enabledMembers.filter(m => !assignedMemberIds.has(m.id));

    // 注意：不要机械要求任务数等于成员数！空闲成员完全合法。
    if (idleMembers.length > 0) {
      findings.push({
        category: 'planning',
        level: 'info',
        code: 'IDLE_MEMBERS_DETECTED',
        message: `当前规划存在 ${idleMembers.length} 名空闲成员 (${idleMembers.map(m => m.id).join(', ')})，允许空闲（不机械要求任务数等于成员数）`,
        details: {
          idleMemberIds: idleMembers.map(m => m.id),
          idleMembersJustification: idleMembersJustification || null
        }
      });
    }
  }

  return {
    passed: findings.every(f => f.level !== 'error'),
    findings,
    metadata: {
      planningRationale,
      parallelizationJustification,
      dependencyJustification,
      idleMembersJustification,
      hasParallelTasks,
      hasDependencies
    }
  };
}
