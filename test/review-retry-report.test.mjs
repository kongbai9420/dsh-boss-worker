import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateQualityGate } from '../src/quality-gates.mjs';
import { TeamBoard } from '../src/core.mjs';

test('review report distinguishes prior retries from rework granted by rejection', () => {
  const task = { id: 'mock', title: 'mock', retries: 0, maxRetries: 7 };
  const report = evaluateQualityGate(task, {}, { reviewPassed: false }).summary;
  assert.match(report, /本次审查前.*已返工 0 \/ 上限 7/);
  assert.match(report, /本次打回后.*进入第 1 次返工.*1 \/ 7/);
  const passed = evaluateQualityGate({ ...task, retries: 3 }, {}, { reviewPassed: true }).summary;
  assert.match(passed, /通过；返工计数保持 3 \/ 7/);
  const blocked = evaluateQualityGate({ ...task, retries: 7 }, {}, { reviewPassed: false }).summary;
  assert.match(blocked, /暂停并等待用户专门授权.*保持 7 \/ 7/);
  assert.doesNotMatch(blocked, /进入第 8 次/);
});
