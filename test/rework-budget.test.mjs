import test from 'node:test';
import assert from 'node:assert/strict';
import {TeamBoard} from '../src/core.mjs';
import {createLeadWorkerTools} from '../src/tools.mjs';
const config={enabled:true,mode:'mixed',bossDirect:true,autopilot:false,confirmPlan:true,askApprovalPrompt:false,maxParallel:1,maxRetries:10,members:[{id:'w',name:'W',provider:'mock',model:'mock',role:'Dev',instructions:'Work',enabled:true,readOnly:false}]};
test('review result uses configured ten-retry budget and requests approval only at real exhaustion',async()=>{
 const board=new TeamBoard(config);board.plan([{id:'a',title:'A',instructions:'Work',acceptance:'Test',memberId:'w',writeScopes:['a.js']}]);board.approve('user');
 let questions=0,scheduled=0;
 const tools=createLeadWorkerTools({getBoard:()=>board,dispatchTask:async()=>{},scheduleReadyTasks:async()=>{scheduled++;},batchAction:async()=>{},getMemberCatalog:()=>config.members,askUserQuestion:async()=>{questions++;return {answers:[]};}});
 const tool=tools.find(t=>t.name==='lead_worker_review');const exec={agent:{session:{header:{id:'isolated'}}}};
 for(let n=1;n<=10;n++){board.start('a');board.finish('a',{output:'done'});const result=await tool.execute({taskId:'a',passed:false,feedback:n===4?'历史：单次额外授权用尽':'fix'},exec);assert.equal(result.reworkBudget.maxRetries,10);assert.equal(result.reworkBudget.retries,n);assert.equal(result.reworkBudget.requiresRetryLimitApproval,false);assert.equal(result.tasks[0].status,'pending');assert.equal(questions,0);if(n===4){assert.match(tool.output.render({taskId:'a'},result)[0].text,/4\/10/);assert.match(result.reworkBudget.guidance,/未触发超限审批/);}}
 assert.equal(scheduled,10);board.start('a');board.finish('a',{output:'done'});const result=await tool.execute({taskId:'a',passed:false,feedback:'still defective'},exec);assert.equal(result.reworkBudget.requiresRetryLimitApproval,true);assert.equal(result.tasks[0].waitingReason,'RETRY_LIMIT_REACHED');assert.equal(questions,1);assert.equal(scheduled,10);
});
