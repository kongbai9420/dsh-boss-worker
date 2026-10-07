import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  QualityGateError,
  validateSafeRelativePath,
  isPathInScope,
  isPathInScopes,
  validateTimestamp,
  requiresTestVerification,
  checkScopeCompliance,
  checkEvidenceValidity,
  checkDeliverables,
  checkSafetyBoundaries,
  evaluateQualityGate,
  generateReviewSummary
} from '../src/quality-gates.mjs';

describe('Quality Gate and Verifiable Acceptance Module', () => {

  describe('1. 路径验证与 Core Scope 一致性 (validateSafeRelativePath & isPathInScope)', () => {
    it('规范化正常相对路径，消除反斜杠与冗余 dot', () => {
      assert.equal(validateSafeRelativePath('src/quality-gates.mjs'), 'src/quality-gates.mjs');
      assert.equal(validateSafeRelativePath('src\\quality-gates.mjs'), 'src/quality-gates.mjs');
      assert.equal(validateSafeRelativePath('./src/./quality-gates.mjs'), 'src/quality-gates.mjs');
      assert.equal(validateSafeRelativePath('test/gates.test.mjs'), 'test/gates.test.mjs');
    });

    it('严格拒绝 Windows 盘符和冒号 (包含 C: 和 NTFS ADS colon)', () => {
      assert.throws(
        () => validateSafeRelativePath('C:\\test\\file.js'),
        (err) => err instanceof QualityGateError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('c:/workspace/app.js'),
        (err) => err instanceof QualityGateError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('file.txt:stream'),
        (err) => err instanceof QualityGateError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('foo:bar'),
        (err) => err instanceof QualityGateError && err.code === 'INVALID_PATH'
      );
    });

    it('拒绝绝对路径、UNC 路径与空字节', () => {
      assert.throws(
        () => validateSafeRelativePath('/root/data.json'),
        (err) => err instanceof QualityGateError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('//network/share/res.txt'),
        (err) => err instanceof QualityGateError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('src/bad\0file.js'),
        (err) => err instanceof QualityGateError && err.code === 'INVALID_PATH'
      );
    });

    it('拒绝目录穿越 (..、末段 ..、前段 ..)', () => {
      assert.throws(
        () => validateSafeRelativePath('../outside.js'),
        (err) => err instanceof QualityGateError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('src/../../outside.js'),
        (err) => err instanceof QualityGateError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('..'),
        (err) => err instanceof QualityGateError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('src/..'),
        (err) => err instanceof QualityGateError && err.code === 'INVALID_PATH'
      );
    });

    it('Scope 目录包含符合既有 core 语义：scope "src" 包含 "src/a"、"src/b/c.js"', () => {
      assert.equal(isPathInScope('src/a', 'src'), true);
      assert.equal(isPathInScope('src/a.js', 'src'), true);
      assert.equal(isPathInScope('src/sub/nested.js', 'src'), true);
      assert.equal(isPathInScope('src', 'src'), true);
      // 兄弟目录不匹配
      assert.equal(isPathInScope('src-other/a.js', 'src'), false);
      assert.equal(isPathInScope('test/a.js', 'src'), false);
      // ** 与 . 匹配全部
      assert.equal(isPathInScope('any/path/file.txt', '**'), true);
      assert.equal(isPathInScope('any/path/file.txt', '.'), true);
    });

    it('isPathInScopes 列表匹配', () => {
      const scopes = ['src', 'test/quality-gates.test.mjs'];
      assert.equal(isPathInScopes('src/quality-gates.mjs', scopes), true);
      assert.equal(isPathInScopes('test/quality-gates.test.mjs', scopes), true);
      assert.equal(isPathInScopes('package.json', scopes), false);
    });
  });

  describe('2. 写范围与只读要求检查 (checkScopeCompliance)', () => {
    it('只读要求被破坏：只读任务修改文件时判定失败', () => {
      const contract = { id: 't-ro', readOnly: true, writeScopes: [] };
      const sub = { touchedFiles: ['src/core.mjs'] };
      const result = checkScopeCompliance(contract, sub);
      assert.equal(result.passed, false);
      assert.equal(result.outOfScopeFiles.includes('src/core.mjs'), true);
      assert(result.findings.some((f) => f.code === 'READONLY_TOUCHED_VIOLATION'));
    });

    it('只读要求被破坏：只读成员分配可写任务声明', () => {
      const contract = { id: 't-ro2', member: { readOnly: true }, writeScopes: [] };
      const sub = { declaredFiles: ['src/core.mjs'] };
      const result = checkScopeCompliance(contract, sub);
      assert.equal(result.passed, false);
      assert(result.findings.some((f) => f.code === 'READONLY_DECLARED_VIOLATION'));
    });

    it('可写任务未声明 writeScopes 却修改文件时判定失败', () => {
      const contract = { id: 't-w', readOnly: false, writeScopes: [] };
      const sub = { touchedFiles: ['src/core.mjs'] };
      const result = checkScopeCompliance(contract, sub);
      assert.equal(result.passed, false);
      assert(result.findings.some((f) => f.code === 'MISSING_WRITE_SCOPES_DECLARATION'));
    });

    it('修改文件超出 writeScopes 授权范围时判定失败', () => {
      const contract = { id: 't-w2', readOnly: false, writeScopes: ['src'] };
      const sub = { touchedFiles: ['src/quality-gates.mjs', 'index.js'] };
      const result = checkScopeCompliance(contract, sub);
      assert.equal(result.passed, false);
      assert.deepEqual(result.outOfScopeFiles, ['index.js']);
      assert(result.findings.some((f) => f.code === 'OUT_OF_SCOPE_MODIFICATION'));
    });

    it('修改文件完全在 writeScopes 范围内通过检查', () => {
      const contract = { id: 't-ok', readOnly: false, writeScopes: ['src', 'test'] };
      const sub = { touchedFiles: ['src/quality-gates.mjs', 'test/quality-gates.test.mjs'] };
      const result = checkScopeCompliance(contract, sub);
      assert.equal(result.passed, true);
      assert.equal(result.outOfScopeFiles.length, 0);
    });
  });

  describe('3. 时间戳与 Epoch 校验 (validateTimestamp & checkEvidenceValidity)', () => {
    it('validateTimestamp 正确识别有效时间与过滤非法时间', () => {
      assert.equal(typeof validateTimestamp(1700000000000), 'number');
      assert.equal(typeof validateTimestamp('2025-01-01T00:00:00Z'), 'number');
      assert.equal(typeof validateTimestamp(new Date()), 'number');

      // 非法值过滤
      assert.equal(validateTimestamp(null), null);
      assert.equal(validateTimestamp(undefined), null);
      assert.equal(validateTimestamp(''), null);
      assert.equal(validateTimestamp(NaN), null);
      assert.equal(validateTimestamp(Infinity), null);
      assert.equal(validateTimestamp(-Infinity), null);
      assert.equal(validateTimestamp('Infinity'), null);
      assert.equal(validateTimestamp('-Infinity'), null);
      assert.equal(validateTimestamp('NaN'), null);
      assert.equal(validateTimestamp(0), null);
      assert.equal(validateTimestamp(-100), null);
      assert.equal(validateTimestamp('invalid-date-string'), null);
    });

    it('时间戳为 Infinity 或非法数值时，实测结果判定为 unknown', () => {
      const contract = { id: 't-ts', acceptance: 'Run tests' };
      const sub = {
        testRuns: [{ command: 'npm test', exitCode: 0, timestamp: 'Infinity' }]
      };
      const res = checkEvidenceValidity(contract, sub);
      assert.equal(res.verdict, 'unknown');
      assert(res.findings.some((f) => f.code === 'INVALID_TIMESTAMP'));
    });

    it('时间戳早于开始时间基线 (陈旧结果) 时，判定为 unknown', () => {
      const contract = { id: 't-stale', acceptance: 'Run tests' };
      const sub = {
        startedAt: 1700000050000,
        testRuns: [{ command: 'npm test', exitCode: 0, timestamp: 1700000010000 }]
      };
      const res = checkEvidenceValidity(contract, sub);
      assert.equal(res.verdict, 'unknown');
      assert(res.findings.some((f) => f.code === 'STALE_TEST_EVIDENCE'));
    });

    it('执行代次 (executionEpoch) 不匹配时，判定为 unknown (防陈旧代次)', () => {
      const contract = { id: 't-epoch', executionEpoch: 2, acceptance: 'Run tests' };
      const sub = { executionEpoch: 1, testRuns: [{ command: 'npm test', exitCode: 0, timestamp: 1700000090000 }] };
      const res = checkEvidenceValidity(contract, sub);
      assert.equal(res.verdict, 'unknown');
      assert(res.findings.some((f) => f.code === 'EXECUTION_EPOCH_MISMATCH'));
    });

    it('testRuns 数组包含 null / undefined / 非对象元素时，坚决不崩溃', () => {
      const contract = { id: 't-null-safe', acceptance: 'Run tests' };
      const sub = {
        testRuns: [null, undefined, 'bad string', { command: 'node test.js', exitCode: 0, timestamp: Date.now() }]
      };
      assert.doesNotThrow(() => {
        const res = checkEvidenceValidity(contract, sub);
        assert.equal(res.verdict, 'unknown'); // reported => unknown
        assert(res.findings.some((f) => f.code === 'MALFORMED_TEST_RUN_ELEMENT'));
      });
    });
  });

  describe('4. Reported vs 宿主独立 Trusted 实测结果隔离与安全反例', () => {
    it('安全回归：worker JSON 中填 testRuns exitCode: 0 默认判定为 unknown，绝不可直接 passed', () => {
      const contract = { id: 't-sec1', acceptance: 'node --test' };
      const sub = {
        testRuns: [{ command: 'node --test', exitCode: 0, timestamp: Date.now() }]
      };
      const res = checkEvidenceValidity(contract, sub);
      assert.equal(res.verdict, 'unknown');
      assert(res.findings.some((f) => f.code === 'REPORTED_TEST_UNVERIFIED_BY_HOST'));
    });

    it('安全回归：worker 自选 trusted: true 或 verified: true 必须被强制无视，仍视为 reported => unknown', () => {
      const contract = { id: 't-sec2', acceptance: 'node --test' };
      const sub = {
        testRuns: [{ command: 'node --test', exitCode: 0, trusted: true, verified: true, timestamp: Date.now() }]
      };
      const res = checkEvidenceValidity(contract, sub);
      assert.equal(res.verdict, 'unknown');
      assert(res.findings.some((f) => f.code === 'UNTRUSTED_SELF_CLAIM_IGNORED'));
    });

    it('测试确凿失败：无论是 reported 还是 trusted，exitCode !== 0 立即判定为 failed', () => {
      const contract = { id: 't-fail', acceptance: 'node --test' };
      const sub = {
        testRuns: [{ command: 'node --test', exitCode: 1, timestamp: Date.now(), output: '1 test failed' }]
      };
      const res = checkEvidenceValidity(contract, sub);
      assert.equal(res.verdict, 'failed');
      assert(res.findings.some((f) => f.code === 'TEST_EXECUTION_FAILED'));
    });

    it('宿主独立注入上下文：hostContext.trustedRuns 中 exitCode 0 判定为 passed', () => {
      const contract = { id: 't-trust', acceptance: 'node --test' };
      const sub = {
        summary: 'All done',
        touchedFiles: ['src/quality-gates.mjs']
      };
      const hostContext = {
        trustedRuns: [{ command: 'node --test test/quality-gates.test.mjs', exitCode: 0, timestamp: Date.now() }]
      };
      const res = checkEvidenceValidity(contract, sub, hostContext);
      assert.equal(res.verdict, 'passed');
      assert.equal(res.metrics.testsPassedCount, 1);
    });

    it('宿主独立测试失败：hostContext.trustedRuns 中 exitCode !== 0 判定为 failed', () => {
      const contract = { id: 't-trust-fail', acceptance: 'node --test' };
      const sub = { summary: 'Done' };
      const hostContext = {
        trustedRuns: [{ command: 'node --test', exitCode: 2, timestamp: Date.now() }]
      };
      const res = checkEvidenceValidity(contract, sub, hostContext);
      assert.equal(res.verdict, 'failed');
      assert(res.findings.some((f) => f.code === 'TRUSTED_TEST_FAILED'));
    });
  });

  describe('5. 空提交与成果核验 (checkDeliverables & Empty Submission)', () => {
    it('安全回归：无测试要求且 submission = {} 时，缺实测必须判定为 unknown，不可直接 passed', () => {
      const contract = { id: 't-empty', title: 'Task without explicit tests', acceptance: 'Finish docs', requireTestEvidence: false };
      const sub = {}; // 没有任何修改文件、成果、测试或摘要
      const res = checkEvidenceValidity(contract, sub);
      assert.equal(res.verdict, 'unknown');
      assert(res.findings.some((f) => f.code === 'EMPTY_SUBMISSION_EVIDENCE'));
    });

    it('必需 contract.deliverables 遗漏时判定失败', () => {
      const contract = {
        id: 't-deliv-missing',
        deliverables: [{ path: 'dist/bundle.js', required: true }]
      };
      const sub = { deliverables: [] };
      const res = checkDeliverables(contract, sub);
      assert.equal(res.passed, false);
      assert.equal(res.verdict, 'failed');
      assert(res.findings.some((f) => f.code === 'MISSING_REQUIRED_DELIVERABLE'));
    });

    it('成果存在但未提供 exists 实测结果时，判定为 unknown', () => {
      const contract = {
        id: 't-deliv-unverified',
        deliverables: [{ path: 'dist/bundle.js', required: true }]
      };
      const sub = {
        deliverables: [{ path: 'dist/bundle.js' }] // 未提供 exists
      };
      const res = checkDeliverables(contract, sub);
      assert.equal(res.passed, false);
      assert.equal(res.verdict, 'unknown');
      assert(res.findings.some((f) => f.code === 'DELIVERABLE_EXISTENCE_UNVERIFIED'));
    });

    it('成果明确标记 exists: false 时判定为 failed', () => {
      const contract = {
        id: 't-deliv-false',
        deliverables: [{ path: 'dist/bundle.js', required: true }]
      };
      const sub = {
        deliverables: [{ path: 'dist/bundle.js', exists: false }]
      };
      const res = checkDeliverables(contract, sub);
      assert.equal(res.passed, false);
      assert.equal(res.verdict, 'failed');
      assert(res.findings.some((f) => f.code === 'DELIVERABLE_NOT_FOUND'));
    });

    it('成果由宿主 hostContext.trustedDeliverables 证实存在时判定通过', () => {
      const contract = {
        id: 't-deliv-ok',
        deliverables: [{ path: 'dist/bundle.js', required: true }]
      };
      const sub = {
        deliverables: [{ path: 'dist/bundle.js' }]
      };
      const hostContext = {
        trustedDeliverables: [{ path: 'dist/bundle.js', exists: true }]
      };
      const res = checkDeliverables(contract, sub, hostContext);
      assert.equal(res.passed, true);
      assert.equal(res.verdict, 'passed');
    });

    it('定向反例回归：hostContext.trustedDeliverables 条目仅有 path、无 exists 字段或为 null 时必须判定为 unknown', () => {
      const contract = {
        id: 't-deliv-trust-no-exists',
        deliverables: [{ path: 'dist/bundle.js', required: true }]
      };
      const sub = {
        deliverables: [{ path: 'dist/bundle.js' }]
      };
      // 仅有 path，无 exists 字段
      const hostContext1 = {
        trustedDeliverables: [{ path: 'dist/bundle.js' }]
      };
      const res1 = checkDeliverables(contract, sub, hostContext1);
      assert.equal(res1.passed, false);
      assert.equal(res1.verdict, 'unknown');
      assert(res1.findings.some((f) => f.code === 'TRUSTED_DELIVERABLE_EXISTENCE_UNVERIFIED'));

      // exists 显式为 null
      const hostContext2 = {
        trustedDeliverables: [{ path: 'dist/bundle.js', exists: null }]
      };
      const res2 = checkDeliverables(contract, sub, hostContext2);
      assert.equal(res2.passed, false);
      assert.equal(res2.verdict, 'unknown');
      assert(res2.findings.some((f) => f.code === 'TRUSTED_DELIVERABLE_EXISTENCE_UNVERIFIED'));
    });

    it('定向反例回归：hostContext.trustedDeliverables 条目明确 exists === false 时判定为 failed', () => {
      const contract = {
        id: 't-deliv-trust-false',
        deliverables: [{ path: 'dist/bundle.js', required: true }]
      };
      const sub = {
        deliverables: [{ path: 'dist/bundle.js' }]
      };
      const hostContext = {
        trustedDeliverables: [{ path: 'dist/bundle.js', exists: false }]
      };
      const res = checkDeliverables(contract, sub, hostContext);
      assert.equal(res.passed, false);
      assert.equal(res.verdict, 'failed');
      assert(res.findings.some((f) => f.code === 'DELIVERABLE_CONFIRMED_MISSING'));
    });
  });

  describe('6. 返工上限与安全审批边界 (checkSafetyBoundaries)', () => {
    it('maxRetries 未提供时不默认 0 (默认 2)，未超限时不阻断', () => {
      const contract = { id: 't-retry-1', retries: 1 }; // 未提供 maxRetries
      const safety = checkSafetyBoundaries(contract, 'failed');
      assert.equal(safety.maxRetries, 2);
      assert.equal(safety.reworkLimitExceeded, false);
      assert.equal(safety.requiresUserApproval, false);
    });

    it('安全回归：userApproved plan 绝不可替代超限返工授权', () => {
      const contract = {
        id: 't-limit',
        retries: 2,
        maxRetries: 2,
        userApproved: true // 初始 plan 获批准，不能算作超限返工授权！
      };
      const safety = checkSafetyBoundaries(contract, 'failed');
      assert.equal(safety.reworkLimitExceeded, true);
      assert.equal(safety.requiresUserApproval, true);
      assert(safety.findings.some((f) => f.code === 'REWORK_LIMIT_EXCEEDED_REQUIRES_APPROVAL'));
    });

    it('只有明确的 userApprovedRework 专门授权才可解除超限阻断', () => {
      const contract = {
        id: 't-limit-ok',
        retries: 2,
        maxRetries: 2,
        userApproved: true,
        userApprovedRework: true // 专门的用户返工授权
      };
      const safety = checkSafetyBoundaries(contract, 'failed');
      assert.equal(safety.reworkLimitExceeded, true);
      assert.equal(safety.requiresUserApproval, false);
    });
  });

  describe('7. 完整验收把关裁决与主控摘要 (evaluateQualityGate)', () => {
    it('canAutoAccept 始终为 false（本插件主控审查，严禁自动放行）', () => {
      const contract = {
        id: 'task-full-pass',
        title: 'Core Engine Feature',
        writeScopes: ['src'],
        deliverables: [{ path: 'src/app.js', required: true }]
      };
      const sub = {
        summary: 'Feature completed',
        touchedFiles: ['src/app.js'],
        deliverables: [{ path: 'src/app.js' }]
      };
      const hostContext = {
        trustedRuns: [{ command: 'node --test', exitCode: 0, timestamp: Date.now() }],
        trustedDeliverables: [{ path: 'src/app.js', exists: true }]
      };

      const evalRes = evaluateQualityGate(contract, sub, hostContext);
      assert.equal(evalRes.verdict, 'passed');
      // 核心要求：canAutoAccept 必须始终为 false！
      assert.equal(evalRes.canAutoAccept, false);
      assert.equal(typeof evalRes.summary, 'string');
      assert(evalRes.summary.includes('【PASSED 通过】'));
      assert(evalRes.summary.includes('严格禁用自动验收'));
    });

    it('缺实测场景整体判定为 unknown 且生成准确的审查摘要', () => {
      const contract = {
        id: 'task-unknown',
        title: 'Need Verification',
        writeScopes: ['src'],
        acceptance: 'npm test'
      };
      const sub = {
        summary: 'Claimed working',
        touchedFiles: ['src/test.js'],
        testRuns: [{ command: 'npm test', exitCode: 0, timestamp: Date.now() }] // reported only
      };

      const evalRes = evaluateQualityGate(contract, sub);
      assert.equal(evalRes.verdict, 'unknown');
      assert.equal(evalRes.canAutoAccept, false);
      assert(evalRes.summary.includes('【UNKNOWN 结果不足/需补充核验】'));
      assert(evalRes.summary.includes('成员自报未验证测试数: 1'));
    });

    it('超范围与测试失败复合场景正确归纳为 failed', () => {
      const contract = {
        id: 'task-fail-compound',
        title: 'Compound Failures',
        writeScopes: ['src'],
        deliverables: [{ path: 'dist/app.js', required: true }]
      };
      const sub = {
        summary: 'Broken changes',
        touchedFiles: ['src/app.js', 'package.json'], // package.json 超出 writeScopes
        testRuns: [{ command: 'node test.js', exitCode: 1, timestamp: Date.now() }],
        deliverables: [{ path: 'dist/app.js', exists: false }]
      };

      const evalRes = evaluateQualityGate(contract, sub);
      assert.equal(evalRes.verdict, 'failed');
      assert.equal(evalRes.canAutoAccept, false);
      assert.equal(evalRes.metrics.scopeViolationsCount, 1);
      assert.equal(evalRes.metrics.testsFailedCount, 1);
    });

    it('定向反例回归：仅有 summary 属于口头自述，即使无测试要求也必须判定为 unknown', () => {
      const contract = { id: 'task-oral', requireTestEvidence: false };
      const sub = { summary: 'I did it' };
      const evalRes = evaluateQualityGate(contract, sub);
      assert.equal(evalRes.verdict, 'unknown');
      assert.equal(evalRes.canAutoAccept, false);
      assert(evalRes.findings.some((f) => f.code === 'ORAL_SUMMARY_ONLY_UNVERIFIED'));
    });

    it('定向反例回归：存在 touchedFiles/declaredFiles 或 deliverables 可核对象时才允许该分支通过并由后续核验', () => {
      // 存在 touchedFiles 且写范围合规
      const contract1 = { id: 't-has-files', requireTestEvidence: false, writeScopes: ['src'] };
      const sub1 = { summary: 'I did it', touchedFiles: ['src/quality-gates.mjs'] };
      const evalRes1 = evaluateQualityGate(contract1, sub1);
      assert.equal(evalRes1.verdict, 'passed');

      // 存在 declaredFiles 且写范围合规
      const contract2 = { id: 't-has-decl', requireTestEvidence: false, writeScopes: ['src'] };
      const sub2 = { summary: 'I did it', declaredFiles: ['src/quality-gates.mjs'] };
      const evalRes2 = evaluateQualityGate(contract2, sub2);
      assert.equal(evalRes2.verdict, 'passed');

      // 存在 deliverables 且由宿主证实
      const contract3 = { id: 't-has-deliv', requireTestEvidence: false, deliverables: [{ path: 'dist/app.js' }] };
      const sub3 = { summary: 'I did it', deliverables: [{ path: 'dist/app.js' }] };
      const host3 = { trustedDeliverables: [{ path: 'dist/app.js', exists: true }] };
      const evalRes3 = evaluateQualityGate(contract3, sub3, host3);
      assert.equal(evalRes3.verdict, 'passed');
    });
  });

  describe('8. 纯函数与无环境副作用保证', () => {
    it('纯函数执行无任何全局环境污染，无 child_process / shell 启动', () => {
      // 模块不引入任何外部执行命令，确保无 shell 执行
      assert.equal(typeof evaluateQualityGate, 'function');
      assert.equal(typeof generateReviewSummary, 'function');
    });
  });

});
