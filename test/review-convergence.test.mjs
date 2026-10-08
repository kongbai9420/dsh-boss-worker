import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('completion has only the task review notice and phase guidance requires incremental review', () => {
  const source = readFileSync(new URL('../src/host.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes("type: 'task_completed'"));
  assert.match(source, /await notifyParentReview/);
  assert.match(source, /【新增核验理由】/);
  assert.match(source, /同一文件版本、相同范围、相同验证命令/);
  assert.match(source, /目标完成则总结结束/);
  assert.match(source, /存在阻断则报告缺口和所需授权/);
});
