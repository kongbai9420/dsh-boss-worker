import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeadWorkerHostService } from '../src/host.mjs';
function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'dsh-mode-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const hooks=[], notices=[], sections=[], guards=[];
 const parent={status:'idle', session:{header:{id:'A'}}, ctx:{}, followup:async msg=>{notices.push(msg);}};
 const tools={register(){},guard(fn){guards.push(fn);}};
 const ctx={logger:{warn(){},info(){},error(){}},on(event,fn){hooks.push(fn);},
 get(n){return n==='profileContext'?{dir}:n==='agents'?{get:()=>parent}:undefined;},
 inject(keys,fn){if(keys.includes('systemPrompt')) fn({systemPrompt:{section:s=>sections.push(s)}});else if(keys.includes('tools'))fn({tools,userQuestions:{}});}};
 const h=new LeadWorkerHostService(ctx,{});
 return {h,parent,notices,sections,guards,hooks};
}
test('off is based on current config, not toggle history; native tools remain unrestricted',async t=>{
 const f=fixture(t); assert.equal(f.h.coordinationActive('A'),false);
 const context={session:{header:{id:'A'}}}; assert.equal(f.sections[0].text(context),'');
 for(const name of ['write','pwsh','subagent','workflow']) assert.equal(f.guards[0]({name,agent:f.parent}),undefined);
 await f.h.handleAction('A','configureSession',{bossDirect:true});
 assert.match(f.sections[0].text(context),/BOSS直派核心规则/);
 await f.h.handleAction('A','configureSession',{bossDirect:false});
 assert.equal(f.sections[0].text(context),''); assert.deepEqual(await f.h.scheduleReadyTasks('A',{}),[]);
 f.h.getOrCreateBoard('A');
 assert.equal((await f.h.notifyPhaseReview('A',{type:'state_change'})).reason,'MODE_OFF');
});
test('phase notice has an in-flight lock and failure can retry',async t=>{
 const f=fixture(t); await f.h.handleAction('A','configureSession',{bossDirect:true});
 f.h.getOrCreateBoard('A'); let release,calls=0;
 f.parent.followup=()=>{calls++;return new Promise(r=>{release=r;});};
 const event={type:'state_change',payload:{reason:'once'}};
 const first=f.h.notifyPhaseReview('A',event);
 await f.h.notifyPhaseReview('A',event); assert.equal(calls,1); release(); await first;
 f.parent.followup=async()=>{throw Error('mock fail');};
 const retryEvent={type:'state_change',payload:{reason:'retry'}};
 assert.equal((await f.h.notifyPhaseReview('A',retryEvent)).reason,'FOLLOWUP_ERROR');
 f.parent.followup=async()=>{calls++;}; assert.equal((await f.h.notifyPhaseReview('A',retryEvent)).delivered,true);
});
test('disposed service cannot keep scanning later pending reviews',async t=>{
 const f=fixture(t); await f.h.handleAction('A','configureSession',{bossDirect:true});
 const b=f.h.getOrCreateBoard('A'),m=b.config.members[0].id;
 b.plan(['one','two'].map(id=>({id,title:id,instructions:'mock',acceptance:'mock',memberId:m,writeScopes:[id]}))); b.approve();
 for(const id of ['one','two']){b.start(id);b.finish(id,{output:'mock'});}
 let release,calls=0;f.parent.followup=()=>{calls++;return new Promise(r=>{release=r;});};
 const scan=f.h.remindPendingReviews(); assert.equal(calls,1);
 for(const hook of f.hooks)hook();release();await scan;assert.equal(calls,1);
});
