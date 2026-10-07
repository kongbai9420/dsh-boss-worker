import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ContractError,
  VALID_TASK_TYPES,
  VALID_PHASES,
  VALID_DELIVERABLE_TYPES,
  validateSafeRelativePath,
  normalizeDeliverable,
  normalizeTestResult,
  normalizeEvidence,
  normalizeContractTask,
  verifyTaskEvidence,
  canPassReview,
  normalizeStructuredReport,
  reportToEvidence,
  formatReportMarkdown,
  assertDenseArray,
  deepCloneJson,
} from '../src/contracts.mjs';

describe('Contracts & Structured Reporting Module', () => {
  describe('Safe Relative Path Validation', () => {
    it('accepts valid relative paths and normalizes slashes and redundant dots', () => {
      assert.equal(validateSafeRelativePath('src/contracts.mjs'), 'src/contracts.mjs');
      assert.equal(validateSafeRelativePath('src\\contracts.mjs'), 'src/contracts.mjs');
      assert.equal(validateSafeRelativePath('./src/./contracts.mjs'), 'src/contracts.mjs');
      assert.equal(validateSafeRelativePath('test/contracts.test.mjs'), 'test/contracts.test.mjs');
    });

    it('accepts valid filenames with consecutive dots (e.g. a..b) without false rejection', () => {
      assert.equal(validateSafeRelativePath('a..b'), 'a..b');
      assert.equal(validateSafeRelativePath('src/a..b.js'), 'src/a..b.js');
      assert.equal(validateSafeRelativePath('foo..bar/baz..qux.txt'), 'foo..bar/baz..qux.txt');
    });

    it('rejects absolute paths on Unix and Windows', () => {
      assert.throws(
        () => validateSafeRelativePath('/etc/passwd'),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('C:\\Windows\\System32'),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('D:/workspace/file.js'),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('\\Windows\\System32'),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
    });

    it('rejects Windows colon ADS (Alternate Data Streams) and colons anywhere in path', () => {
      assert.throws(
        () => validateSafeRelativePath('file.txt:stream'),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('foo/bar.txt:$DATA'),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('C:file.txt'),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
    });

    it('rejects UNC network paths and null bytes', () => {
      assert.throws(
        () => validateSafeRelativePath('//network/share/doc.txt'),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('src/bad\0file.js'),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
    });

    it('rejects directory traversal attempts ("..") per segment', () => {
      assert.throws(
        () => validateSafeRelativePath('../outside.js'),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('src/../../outside.js'),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('..'),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('foo/..'),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
    });

    it('rejects empty or whitespace-only paths', () => {
      assert.throws(
        () => validateSafeRelativePath(''),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('   '),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
      assert.throws(
        () => validateSafeRelativePath('./.'),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
    });
  });

  describe('Strict Dense Array & Getter Defense', () => {
    it('accepts valid dense arrays', () => {
      assert.deepEqual(assertDenseArray(['a', 'b', 'c'], 'test'), ['a', 'b', 'c']);
      assert.deepEqual(assertDenseArray([], 'test'), []);
    });

    it('rejects strings and numbers passed in place of arrays', () => {
      assert.throws(
        () => assertDenseArray('not-an-array', 'test'),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
      assert.throws(
        () => assertDenseArray(123, 'test'),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
    });

    it('rejects array-like plain objects', () => {
      assert.throws(
        () => assertDenseArray({ 0: 'a', length: 1 }, 'test'),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
    });

    it('rejects sparse arrays with holes or uninitialized elements', () => {
      const sparseWithHole = ['a', , 'c']; // eslint-disable-line no-sparse-arrays
      assert.throws(
        () => assertDenseArray(sparseWithHole, 'test'),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );

      const emptyHoles = new Array(3);
      assert.throws(
        () => assertDenseArray(emptyHoles, 'test'),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
    });

    it('rejects array elements defined with getters', () => {
      const arrayWithGetter = [];
      Object.defineProperty(arrayWithGetter, '0', {
        get() { return 'evil'; },
        enumerable: true,
        configurable: true,
      });
      assert.throws(
        () => assertDenseArray(arrayWithGetter, 'test'),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
    });

    it('rejects arrays with extraneous non-index properties', () => {
      const arr = ['a', 'b'];
      arr.injected = 'exploit';
      assert.throws(
        () => assertDenseArray(arr, 'test'),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
    });

    it('enforces dense array rules on evidence files, tests, and deliverables', () => {
      assert.throws(
        () => normalizeEvidence({ summary: 's', files: 'src/contracts.mjs' }),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
      assert.throws(
        () => normalizeEvidence({ summary: 's', tests: { 0: { name: 't', passed: true } } }),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
      assert.throws(
        () => normalizeEvidence({ summary: 's', files: ['a', , 'b'] }), // eslint-disable-line no-sparse-arrays
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
    });

    it('enforces dense array rules on task writeScopes and dependencies', () => {
      assert.throws(
        () => normalizeContractTask({
          id: 't-1',
          title: 'Title',
          instructions: 'Inst',
          acceptance: 'Pass',
          writeScopes: 'src/contracts.mjs',
        }),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
      assert.throws(
        () => normalizeContractTask({
          id: 't-2',
          title: 'Title',
          instructions: 'Inst',
          acceptance: 'Pass',
          dependencies: ['dep-1', , 'dep-2'], // eslint-disable-line no-sparse-arrays
        }),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
    });
  });

  describe('DeepCloneJson Prototype & Security Defenses', () => {
    it('successfully clones valid nested JSON structures', () => {
      const original = { a: 1, b: 'str', c: [true, null, { d: 42 }] };
      const cloned = deepCloneJson(original);
      assert.deepEqual(cloned, original);
      assert.notEqual(cloned, original);
      assert.notEqual(cloned.c, original.c);
      assert.notEqual(cloned.c[2], original.c[2]);
    });

    it('rejects objects containing __proto__ key to prevent prototype pollution', () => {
      const malicious = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');
      assert.throws(
        () => deepCloneJson(malicious),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
    });

    it('rejects objects containing constructor or prototype keys', () => {
      assert.throws(
        () => deepCloneJson({ constructor: 'bad' }),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
      assert.throws(
        () => deepCloneJson({ prototype: 'bad' }),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
    });

    it('rejects custom class instances (non-plain objects)', () => {
      class CustomClass {
        constructor() { this.x = 1; }
      }
      assert.throws(
        () => deepCloneJson(new CustomClass()),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
    });

    it('rejects objects with getters in JSON structures', () => {
      const objWithGetter = {};
      Object.defineProperty(objWithGetter, 'prop', {
        get() { return 42; },
        enumerable: true,
      });
      assert.throws(
        () => deepCloneJson(objWithGetter),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
    });
  });

  describe('ExitCode Authenticity & Honest Test Normalization', () => {
    it('normalizeTestResult retains null when exitCode is omitted without fabricating 0 or 1', () => {
      const passedWithoutExit = normalizeTestResult({
        name: 'test 1',
        passed: true,
        output: 'tests passed',
      });
      assert.equal(passedWithoutExit.passed, true);
      assert.equal(passedWithoutExit.exitCode, null);

      const failedWithoutExit = normalizeTestResult({
        name: 'test 2',
        passed: false,
        output: 'tests failed',
      });
      assert.equal(failedWithoutExit.passed, false);
      assert.equal(failedWithoutExit.exitCode, null);
    });

    it('normalizeTestResult records valid explicit exit codes', () => {
      const validZero = normalizeTestResult({
        command: 'node test.js',
        passed: true,
        exitCode: 0,
        output: 'ok',
      });
      assert.equal(validZero.exitCode, 0);

      const validOne = normalizeTestResult({
        command: 'node test.js',
        passed: false,
        exitCode: 1,
        output: 'fail',
      });
      assert.equal(validOne.exitCode, 1);
    });

    it('verifyTaskEvidence rejects passed: true when exitCode is missing (null)', () => {
      const baseTask = {
        id: 't-code',
        title: 'Task',
        instructions: 'Inst',
        acceptance: 'Pass',
        taskType: 'code',
        writeScopes: ['src/contracts.mjs'],
      };
      const evidenceMissingExitCode = {
        summary: 'Finished logic',
        files: ['src/contracts.mjs'],
        tests: [
          { name: 'unit test', command: 'node test.js', passed: true, output: '1 pass' }, // missing exitCode
        ],
        unfinished: [],
      };

      const result = verifyTaskEvidence(baseTask, evidenceMissingExitCode);
      assert.equal(result.passed, false);
      assert.ok(
        result.reasons.some((r) => r.includes('未提供客观退出码') || r.includes('exitCode 缺失')),
        `Expected reasons to note missing exitCode, got: ${JSON.stringify(result.reasons)}`
      );
    });

    it('verifyTaskEvidence rejects passed: true when exitCode is non-zero', () => {
      const baseTask = {
        id: 't-code',
        title: 'Task',
        instructions: 'Inst',
        acceptance: 'Pass',
        taskType: 'code',
        writeScopes: ['src/contracts.mjs'],
      };
      const evidenceConflictingExitCode = {
        summary: 'Finished logic',
        files: ['src/contracts.mjs'],
        tests: [
          { name: 'unit test', command: 'node test.js', passed: true, exitCode: 1, output: 'fail' },
        ],
        unfinished: [],
      };

      const result = verifyTaskEvidence(baseTask, evidenceConflictingExitCode);
      assert.equal(result.passed, false);
      assert.ok(result.reasons.some((r) => r.includes('矛盾')));
    });
  });

  describe('Reported Completeness & Honesty Annotations', () => {
    const validTask = {
      id: 't-complete',
      title: 'Valid Task',
      instructions: 'Inst',
      acceptance: 'Pass',
      taskType: 'code',
      writeScopes: ['src/contracts.mjs'],
    };
    const validEvidence = {
      summary: 'Completed work with test evidence',
      files: ['src/contracts.mjs'],
      tests: [
        { name: 'test-1', command: 'node --test', passed: true, exitCode: 0, output: 'passed cleanly' },
      ],
      deliverables: [],
      unfinished: [],
      risks: [],
    };

    it('annotates source=reported and canAutoAccept=false on successful verification', () => {
      const result = verifyTaskEvidence(validTask, validEvidence);
      assert.equal(result.passed, true);
      assert.equal(result.source, 'reported');
      assert.equal(result.canAutoAccept, false);
      assert.equal(result.verified, false);
      assert.equal(result.completeness, 'reported_complete');
      assert.match(result.note, /自评/);
    });

    it('annotates source=reported and canAutoAccept=false on failed verification', () => {
      const failedEvidence = {
        ...validEvidence,
        unfinished: ['Remaining item'],
      };
      const result = verifyTaskEvidence(validTask, failedEvidence);
      assert.equal(result.passed, false);
      assert.equal(result.source, 'reported');
      assert.equal(result.canAutoAccept, false);
      assert.equal(result.verified, false);
      assert.equal(result.completeness, 'incomplete');
    });

    it('canPassReview mirrors honesty annotations', () => {
      const reviewResult = canPassReview(validTask, validEvidence);
      assert.equal(reviewResult.passed, true);
      assert.equal(reviewResult.source, 'reported');
      assert.equal(reviewResult.canAutoAccept, false);
      assert.equal(reviewResult.verified, false);
    });
  });

  describe('Legacy Task Compatibility', () => {
    it('normalizes legacy tasks without contract fields and infers defaults', () => {
      const legacyCodeTask = {
        id: 'task-1',
        title: 'Legacy Implementation',
        instructions: 'Write code',
        acceptance: 'Tests pass',
        memberId: 'worker-sol',
        writeScopes: ['src/contracts.mjs'],
        readOnly: false,
        dependencies: [],
        status: 'pending',
        retries: 0,
      };

      const normalized = normalizeContractTask(legacyCodeTask);
      assert.equal(normalized.id, 'task-1');
      assert.equal(normalized.taskType, 'code'); // inferred from writeScopes
      assert.equal(normalized.phase, 'ready'); // mapped from status: pending
      assert.deepEqual(normalized.deliverables, []);
      assert.equal(normalized.evidence, null);
      assert.equal(normalized.readOnly, false);
    });

    it('infers analysis taskType for legacy read-only tasks', () => {
      const legacyQaTask = {
        id: 'task-qa',
        title: 'QA Task',
        instructions: 'Verify behavior',
        acceptance: 'No regressions',
        memberId: 'worker-qa',
        readOnly: true,
        status: 'running',
      };

      const normalized = normalizeContractTask(legacyQaTask);
      assert.equal(normalized.taskType, 'analysis');
      assert.equal(normalized.phase, 'running');
      assert.deepEqual(normalized.writeScopes, []);
    });

    it('maps legacy task statuses to contract phases correctly', () => {
      const statuses = [
        ['pending', 'ready'],
        ['running', 'running'],
        ['review', 'verifying'],
        ['done', 'completed'],
        ['failed', 'failed'],
        ['needs_attention', 'blocked'],
        ['cancelled', 'failed'],
      ];

      for (const [st, expectedPhase] of statuses) {
        const task = {
          id: `t-${st}`,
          title: 'Test',
          instructions: 'Test',
          acceptance: 'Pass',
          status: st,
        };
        const norm = normalizeContractTask(task);
        assert.equal(norm.phase, expectedPhase);
      }
    });

    it('preserves historical stored fields from core TeamBoard execution', () => {
      const storedTask = {
        id: 't-hist',
        title: 'With history',
        instructions: 'Inst',
        acceptance: 'Pass',
        status: 'done',
        result: { output: 'finished successfully' },
        feedback: 'Looks good',
        reviewHistory: [{ attempt: 1, passed: true, feedback: 'LGTM' }],
        executionEpoch: 2,
        waitingReason: '',
        checkpoint: { note: 'Checkpoint 1' },
      };

      const normalized = normalizeContractTask(storedTask);
      assert.equal(normalized.status, 'done');
      assert.equal(normalized.phase, 'completed');
      assert.deepEqual(normalized.result, { output: 'finished successfully' });
      assert.equal(normalized.feedback, 'Looks good');
      assert.equal(normalized.reviewHistory.length, 1);
      assert.equal(normalized.executionEpoch, 2);
      assert.deepEqual(normalized.checkpoint, { note: 'Checkpoint 1' });
    });
  });

  describe('Extended Contract Task Normalization', () => {
    it('normalizes full-featured contract tasks with custom fields', () => {
      const fullTask = {
        id: 'contract-1',
        title: 'Complete Contract Feature',
        instructions: 'Write contracts and test',
        acceptance: ['All tests pass', 'No side effects'],
        taskType: 'test',
        deliverables: [
          { path: 'test/contracts.test.mjs', type: 'test', description: 'Unit test suite', required: true },
          { path: 'src/contracts.mjs', type: 'code', description: 'Contract implementation', required: true },
        ],
        phase: 'verifying',
        writeScopes: ['src/contracts.mjs', 'test/contracts.test.mjs', 'src/feature..v2.js'],
        readOnly: false,
        memberId: 'worker-sol',
        dependencies: [],
        status: 'review',
        evidence: {
          summary: 'Implementation and verification finished',
          files: ['src/contracts.mjs', 'test/contracts.test.mjs'],
          tests: [
            { name: 'contracts unit tests', command: 'node --test', passed: true, exitCode: 0, output: '12 passed' },
          ],
          deliverables: [
            { path: 'test/contracts.test.mjs', verified: true },
            { path: 'src/contracts.mjs', verified: true },
          ],
          unfinished: [],
          risks: [],
        },
      };

      const normalized = normalizeContractTask(fullTask);
      assert.equal(normalized.taskType, 'test');
      assert.equal(normalized.phase, 'verifying');
      assert.equal(normalized.deliverables.length, 2);
      assert.equal(normalized.deliverables[0].path, 'test/contracts.test.mjs');
      assert.equal(normalized.evidence.files.length, 2);
      assert.equal(normalized.evidence.tests[0].passed, true);
      assert.equal(normalized.evidence.tests[0].exitCode, 0);
      assert.equal(normalized.writeScopes[2], 'src/feature..v2.js');
    });

    it('rejects unknown fields on task object', () => {
      assert.throws(
        () => normalizeContractTask({
          id: 't-bad',
          title: 'Bad',
          instructions: 'Inst',
          acceptance: 'Pass',
          unauthorizedField: 123,
        }),
        (err) => err instanceof ContractError && err.code === 'UNKNOWN_FIELD'
      );
    });

    it('rejects invalid taskType and phase values', () => {
      assert.throws(
        () => normalizeContractTask({
          id: 't-bad-type',
          title: 'Bad Type',
          instructions: 'Inst',
          acceptance: 'Pass',
          taskType: 'invalid_type',
        }),
        (err) => err instanceof ContractError && err.code === 'INVALID_TYPE'
      );

      assert.throws(
        () => normalizeContractTask({
          id: 't-bad-phase',
          title: 'Bad Phase',
          instructions: 'Inst',
          acceptance: 'Pass',
          phase: 'unknown_phase',
        }),
        (err) => err instanceof ContractError && err.code === 'INVALID_PHASE'
      );
    });
  });

  describe('Strict Deliverable & Evidence Validation', () => {
    it('rejects unknown fields in deliverables', () => {
      assert.throws(
        () => normalizeDeliverable({ path: 'src/a.js', unexpected: true }),
        (err) => err instanceof ContractError && err.code === 'UNKNOWN_FIELD'
      );
    });

    it('rejects invalid deliverable types', () => {
      assert.throws(
        () => normalizeDeliverable({ path: 'src/a.js', type: 'exploit' }),
        (err) => err instanceof ContractError && err.code === 'INVALID_TYPE'
      );
    });

    it('rejects unknown fields in evidence', () => {
      assert.throws(
        () => normalizeEvidence({ summary: 'test', hacked: true }),
        (err) => err instanceof ContractError && err.code === 'UNKNOWN_FIELD'
      );
    });

    it('rejects duplicate file paths in evidence', () => {
      assert.throws(
        () => normalizeEvidence({ summary: 'test', files: ['src/a.js', 'src/a.js'] }),
        (err) => err instanceof ContractError && err.code === 'INVALID_INPUT'
      );
    });

    it('rejects illegal path traversal in evidence files', () => {
      assert.throws(
        () => normalizeEvidence({ summary: 'test', files: ['../secret.txt'] }),
        (err) => err instanceof ContractError && err.code === 'INVALID_PATH'
      );
    });
  });

  describe('No Evidence, No Pass Enforcement (verifyTaskEvidence)', () => {
    const baseCodeTask = {
      id: 'task-code',
      title: 'Implementation',
      instructions: 'Do logic',
      acceptance: 'Tests green',
      taskType: 'code',
      writeScopes: ['src/contracts.mjs'],
      deliverables: [
        { path: 'src/contracts.mjs', type: 'code', required: true },
      ],
    };

    it('rejects review pass when evidence is completely missing', () => {
      const res = verifyTaskEvidence(baseCodeTask, null);
      assert.equal(res.passed, false);
      assert.match(res.reasons[0], /缺少分项执行结果/);
    });

    it('rejects review pass when unfinished items exist', () => {
      const evidence = {
        summary: 'Almost done',
        files: ['src/contracts.mjs'],
        tests: [{ name: 'unit', passed: true, exitCode: 0, output: 'passed' }],
        unfinished: ['Still need to fix security edge case'],
      };
      const res = verifyTaskEvidence(baseCodeTask, evidence);
      assert.equal(res.passed, false);
      assert.match(res.reasons.find((r) => r.includes('未完成事项')), /security edge case/);
    });

    it('rejects code task when no files were modified', () => {
      const evidence = {
        summary: 'Done nothing',
        files: [],
        tests: [{ name: 'unit', passed: true, exitCode: 0, output: 'passed' }],
        unfinished: [],
      };
      const res = verifyTaskEvidence(baseCodeTask, evidence);
      assert.equal(res.passed, false);
      assert.ok(res.reasons.some((r) => r.includes('未报告任何修改的文件')));
    });

    it('rejects code task when modified files exceed writeScopes', () => {
      const evidence = {
        summary: 'Modified core too',
        files: ['src/contracts.mjs', 'src/core.mjs'],
        tests: [{ name: 'unit', passed: true, exitCode: 0, output: 'passed' }],
        unfinished: [],
      };
      const res = verifyTaskEvidence(baseCodeTask, evidence);
      assert.equal(res.passed, false);
      assert.ok(res.reasons.some((r) => r.includes('文件修改超出允许的 writeScopes')));
      assert.ok(res.reasons.some((r) => r.includes('src/core.mjs')));
    });

    it('rejects code or test task when no test evidence is provided', () => {
      const evidence = {
        summary: 'Written without tests',
        files: ['src/contracts.mjs'],
        tests: [],
        unfinished: [],
      };
      const res = verifyTaskEvidence(baseCodeTask, evidence);
      assert.equal(res.passed, false);
      assert.ok(res.reasons.some((r) => r.includes('必须提供自动化测试运行结果')));
    });

    it('rejects review pass when any test fails', () => {
      const evidence = {
        summary: 'Failed run',
        files: ['src/contracts.mjs'],
        tests: [
          { name: 'test suite 1', command: 'node test1.js', passed: true, exitCode: 0, output: 'ok' },
          { name: 'test suite 2', command: 'node test2.js', passed: false, exitCode: 1, output: 'AssertionError' },
        ],
        unfinished: [],
      };
      const res = verifyTaskEvidence(baseCodeTask, evidence);
      assert.equal(res.passed, false);
      assert.ok(res.reasons.some((r) => r.includes('测试未通过')));
    });

    it('rejects fake test evidence with empty or whitespace-only output', () => {
      const evidence = {
        summary: 'Fake test claim',
        files: ['src/contracts.mjs'],
        tests: [
          { name: 'faked test', command: 'fake run', passed: true, exitCode: 0, output: '   ' },
        ],
        unfinished: [],
      };
      const res = verifyTaskEvidence(baseCodeTask, evidence);
      assert.equal(res.passed, false);
      assert.ok(res.reasons.some((r) => r.includes('存在伪造风险')));
    });

    it('rejects review pass when required deliverable is missing from both files and deliverables verification', () => {
      const taskWithExtraDeliverable = {
        ...baseCodeTask,
        deliverables: [
          { path: 'src/contracts.mjs', required: true },
          { path: 'docs/SPEC.md', required: true },
        ],
      };
      const evidence = {
        summary: 'Only code done',
        files: ['src/contracts.mjs'],
        tests: [{ name: 'unit', passed: true, exitCode: 0, output: 'all green' }],
        deliverables: [{ path: 'src/contracts.mjs', verified: true }],
        unfinished: [],
      };
      const res = verifyTaskEvidence(taskWithExtraDeliverable, evidence);
      assert.equal(res.passed, false);
      assert.ok(res.reasons.some((r) => r.includes('缺少关键成果') && r.includes('docs/SPEC.md')));
    });

    it('passes review when all evidence requirements are genuine and satisfied', () => {
      const validEvidence = {
        summary: 'Successfully developed contracts module and verified test suite',
        files: ['src/contracts.mjs'],
        tests: [
          { name: 'contracts tests', command: 'node --test test/contracts.test.mjs', passed: true, exitCode: 0, output: '15 passed, 0 failed' },
        ],
        deliverables: [
          { path: 'src/contracts.mjs', verified: true, note: 'Pure contract module' },
        ],
        unfinished: [],
        risks: [],
      };
      const res = verifyTaskEvidence(baseCodeTask, validEvidence);
      assert.equal(res.passed, true);
      assert.equal(res.reasons.length, 0);
      assert.ok(res.normalizedEvidence);
    });
  });

  describe('Structured Report Formatting & Integration', () => {
    it('normalizes structured reports and generates clean Markdown', () => {
      const reportInput = {
        summary: 'Contracts module and unit tests implemented',
        completed: ['Added pure contracts module', 'Added unit test suite'],
        unfinished: [],
        modifiedFiles: ['src/contracts.mjs', 'test/contracts.test.mjs'],
        testResults: [
          { command: 'node --test test/contracts.test.mjs', passed: true, exitCode: 0, output: 'all tests green' },
        ],
        deliverables: [
          { path: 'src/contracts.mjs', verified: true, note: 'contracts module' },
        ],
        risks: ['None identified'],
        nextSteps: ['Integrate with host service'],
      };

      const norm = normalizeStructuredReport(reportInput);
      assert.equal(norm.completed.length, 2);
      assert.equal(norm.modifiedFiles.length, 2);

      const markdown = formatReportMarkdown(norm);
      assert.match(markdown, /任务执行分项汇报/);
      assert.match(markdown, /Added pure contracts module/);
      assert.match(markdown, /node --test test\/contracts\.test\.mjs/);
      assert.match(markdown, /✅ 通过/);

      // Convert report to evidence and evaluate
      const evidence = reportToEvidence(norm);
      assert.equal(evidence.files.length, 2);

      const task = {
        id: 'task-test',
        title: 'Task',
        instructions: 'Test',
        acceptance: 'Pass',
        taskType: 'code',
        writeScopes: ['src/contracts.mjs', 'test/contracts.test.mjs'],
      };
      const reviewResult = canPassReview(task, reportInput);
      assert.equal(reviewResult.passed, true);
      assert.equal(reviewResult.source, 'reported');
      assert.equal(reviewResult.canAutoAccept, false);
      assert.equal(reviewResult.verified, false);
    });

    it('rejects unknown fields in structured reports', () => {
      assert.throws(
        () => normalizeStructuredReport({ summary: 'ok', malicious: 'payload' }),
        (err) => err instanceof ContractError && err.code === 'UNKNOWN_FIELD'
      );
    });
  });

  describe('Pure Isolation & No Environment Side Effects', () => {
    it('executes entirely in memory with no APPDATA mutations', () => {
      const initialAppdata = process.env.APPDATA;
      const initialHome = process.env.USERPROFILE || process.env.HOME;

      // Perform various normalization and verification calls
      const task = normalizeContractTask({
        id: 'iso-1',
        title: 'Isolated',
        instructions: 'Do isolation',
        acceptance: 'Done',
      });
      assert.equal(task.taskType, 'general');
      assert.equal(task.phase, 'ready');

      // Verify environment variables remain untouched
      assert.equal(process.env.APPDATA, initialAppdata);
      assert.equal(process.env.USERPROFILE || process.env.HOME, initialHome);
    });
  });
});
