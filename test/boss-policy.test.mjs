import test from 'node:test';
import assert from 'node:assert/strict';
import { bossGuardReason, requireParent } from '../src/boss-policy.mjs';
const config = { enabled: true, bossDirect: true };
const parent = { session: { header: { id: 'root' } }, ctx: {} };
const exec = name => ({ name, agent: parent });
test('enabled root cannot implement or bypass board; planning and reads remain usable', () => {
  for (const name of ['write','edit','bash','pwsh','subagent','subagent_fork','workflow']) assert.ok(bossGuardReason(exec(name),config),name);
  for (const name of ['run_code','read','grep','glob','ask_user_question','lead_worker_plan','lead_worker_approve','lead_worker_dispatch','lead_worker_review']) assert.equal(bossGuardReason(exec(name),config),undefined,name);
});
test('disabled switch, other sessions and delegated workers are not globally denied', () => {
  assert.equal(bossGuardReason(exec('write'),{...config,bossDirect:false}),undefined);
  assert.equal(bossGuardReason(exec('subagent'),{...config,enabled:false}),undefined);
  assert.equal(bossGuardReason({name:'write',agent:{session:{header:{id:'worker',parentSession:'root',origin:'subagent'}}}},config),undefined);
});
test('real parent required; missing parent does not become fabricated null Agent', () => {
  assert.equal(requireParent('root',{}, {get:()=>parent}),parent);
  assert.throws(()=>requireParent('root',{}, {get:()=>undefined}),/主控 Agent/);
  assert.throws(()=>requireParent('other',{agent:parent}),/不匹配/);
});
