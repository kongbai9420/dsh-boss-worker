import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TeamBoard } from '../src/core.mjs';
import { teamAvailability } from '../src/availability.mjs';
const worker = { id: 'w', name: 'Worker', provider: 'p', model: 'm', role: 'coder', instructions: 'Do', enabled: true, readOnly: false };
const config = { enabled: true, mode: 'mixed', leadPrompt: '', members: [worker, {...worker,id:'c1'}, {...worker,id:'c2'}], maxParallel: 3, maxRetries: 2, confirmPlan: true };
const tasks = [1,2,3].map(n => ({id:`t${n}`, title:'Task', instructions:'Do', acceptance:'Pass', memberId:'w', writeScopes:[`f${n}.js`]}));
test('three identical roles balance and start concurrently while retaining approval', () => {
 const b=new TeamBoard(config); b.plan(tasks); b.approve('user'); b.balanceReadyAssignments();
 assert.equal(new Set(b.snapshot().tasks.map(t=>t.memberId)).size,3); assert.equal(b.snapshot().approved,true);
 for(const t of b.snapshot().tasks) b.start(t.id);
 const saved=b.snapshot(); b.balanceReadyAssignments(); assert.deepEqual(b.snapshot(),saved);
 assert.equal(teamAvailability(b.config,b.snapshot()).idleCount,0);
});
test('manual, user locks, dependencies and different instructions are respected', () => {
 for(const mode of ['manual','mixed']) {
 const b=new TeamBoard({...config,mode,members:[worker,{...worker,id:'different',instructions:'Specialist'}]});
 b.plan(tasks.map((t,i)=>({...t,dependencies:i===2?['t1']:[]})),'user');
 b.assign('t2','w','user'); b.approve('user'); const before=b.snapshot(); b.balanceReadyAssignments();
 assert.deepEqual(b.snapshot(),before); assert.deepEqual(teamAvailability(b.config,b.snapshot()).blockedTasks[2].waitingDependencies,['t1']);
 }
});
test('identical routing does not bypass overlapping scopes', () => {
 const b=new TeamBoard(config); b.plan(tasks.map(t=>({...t,writeScopes:['shared.js']}))); b.approve('user'); b.balanceReadyAssignments();
 b.start('t1'); assert.throws(()=>b.start('t2'),e=>e.code==='WRITE_SCOPE_CONFLICT');
 assert.deepEqual(teamAvailability(b.config,b.snapshot()).blockedTasks[0].writeScopeConflicts,['t1']);
});
test('adding a clone can unblock a queued duplicate without touching the running member',()=>{
 const b=new TeamBoard({...config,members:[worker]}); b.plan(tasks.slice(0,2)); b.approve('user'); b.start('t1');
 b.reconfigure(config); b.balanceReadyAssignments(); assert.equal(b.snapshot().tasks[0].memberId,'w');
 assert.equal(b.snapshot().tasks[1].memberId,'c1'); b.start('t2');
});
