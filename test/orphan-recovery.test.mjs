import test from 'node:test';
import assert from 'node:assert/strict';
import { TeamBoard } from '../src/core.mjs';
const member={id:'w',name:'w',provider:'mock',model:'mock',role:'coder',instructions:'',enabled:true,readOnly:false};
const config={enabled:true,mode:'mixed',members:[member],maxParallel:2,maxRetries:2,confirmPlan:true};
const task=(id,dependencies=[])=>({id,title:id,instructions:'mock',acceptance:'mock',memberId:'w',writeScopes:[id],dependencies});
test('missing member pending dependency graph remains readable, paused and unapproved',()=>{
 const b=new TeamBoard(config);b.plan([task('first'),task('second',['first'])]);b.approve();
 const restored=new TeamBoard({...config,members:[{...member,id:'other'}]},b.snapshot());
 assert.equal(restored.snapshot().status,'paused');assert.equal(restored.snapshot().approved,false);
 assert.deepEqual(restored.snapshot().tasks.map(t=>t.status),['pending','pending']);
 assert.deepEqual(restored.snapshot().tasks[1].dependencies,['first']);
 restored.reconfigure(config);restored.assign('first','w');
 assert.throws(()=>restored.start('second'));
});
test('missing member restoration never clears exhausted-retry authorization boundary',()=>{
 const b=new TeamBoard(config);b.plan([task('first')]);b.approve();
 for(let i=0;i<3;i++){b.start('first');b.finish('first',{output:'mock'});b.review('first',false,'mock reject');}
 const restored=new TeamBoard({...config,members:[{...member,id:'other'}]},b.snapshot());
 assert.equal(restored.snapshot().tasks[0].waitingReason,'RETRY_LIMIT_REACHED');
 restored.reconfigure(config);restored.assign('first','w');
 assert.equal(restored.snapshot().tasks[0].waitingReason,'RETRY_LIMIT_REACHED');
 assert.throws(()=>restored.recoverTask('first','mock verification','user'),err=>err.code==='INVALID_STATE');
});
