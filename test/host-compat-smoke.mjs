// Run with ordinary node (not node --test) so missing host dependencies fail.
// Pass an absolute bin.js anchor inside an isolated official host installation:
// node test/host-compat-smoke.mjs C:/path/to/host/bin.js
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHostModule, isolatedTestRuntime } from '../src/host-runtime.mjs';
import { LeadWorkerHostService } from '../src/host.mjs';

assert.equal(isolatedTestRuntime, false, 'compatibility smoke must use real host modules');
const { Context } = await loadHostModule('@deepseek-ai/cordis');
const { ToolRuntime } = await loadHostModule('@deepseek-ai/dsh-tools');
const { SystemPrompt } = await loadHostModule('@deepseek-ai/dsh-system-prompt');
const { SubagentRuntime } = await loadHostModule('@deepseek-ai/dsh-subagent');
const { createUserMessage } = await loadHostModule('@deepseek-ai/dsh-llm');
const { WebServer } = await loadHostModule('@deepseek-ai/dsh-host-webserver');
const profile = mkdtempSync(join(tmpdir(), 'boss-host-compat-'));
const ctx = new Context();
const fibers = [];
const notices = [];
const requests = [];
const agents = new Map();
const sessionId = 'compat-parent';
const parent = {
  id: sessionId,
  ctx,
  session: { header: { id: sessionId } },
  status: 'idle',
  followup(message) { notices.push(message); },
};
agents.set(sessionId, parent);
let disposed = 0;
let complete;
let childCount = 0;
let mode = 'complete';
try {
  // The actual host services run unchanged. The offline backend below replaces
  // only model execution, avoiding credentials, API costs, or live user data.
  ctx.provide('profileContext', { dir: profile });
  ctx.provide('agents', { get: id => agents.get(id) });
  ctx.provide('workingDirectory', { ensure: async () => profile });
  ctx.provide('userQuestions', { ask() { throw new Error('unexpected approval question'); } });
  fibers.push(await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }));
  fibers.push(await ctx.plugin(SystemPrompt, {}));
  fibers.push(await ctx.plugin(ToolRuntime, {}));
  fibers.push(await ctx.plugin(SubagentRuntime, {}));
  const subagents = ctx.get('subagents');
  assert.ok(subagents, 'official subagent service loaded');
  const managed = typeof subagents.startActivation === 'function';
  subagents.registerProvider({
    name: 'spawn',
    capabilities: { agentOptions: true, agentPreset: false, persona: true, toolFilter: false, outputSchema: false, depthLimit: true },
    inheritsParentContext: false,
    async start(request) {
      requests.push(request);
      const id = `compat-child-${++childCount}`;
      const result = mode === 'complete'
        ? Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'offline execution complete' }] })
        : new Promise(resolve => {
          complete = resolve;
          request.signal.addEventListener('abort', () => resolve({ stopReason: 'aborted', output: [] }), { once: true });
        });
      return { id, result, async dispose() { disposed++; } };
    },
  });
  fibers.push(await ctx.plugin(LeadWorkerHostService, {}));
  // Let Cordis finish the injected tool/prompt registrations.
  await new Promise(resolve => setImmediate(resolve));
  const service = ctx.get('leadWorker');
  assert.ok(service, 'real Cordis loaded the plugin');
  const webServer = ctx.get('webServer');
  const origin = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : `http://127.0.0.1:${webServer.port}`;
  const viewResponse = await fetch(`${origin}/api/lead-worker/view?sessionId=${sessionId}`);
  assert.equal(viewResponse.status, 200);
  assert.equal((await viewResponse.json()).ok, true, 'real HTTP route dispatch reaches the board');
  const tools = ctx.get('tools');
  for (const name of ['status', 'plan', 'approve', 'dispatch', 'review', 'list_members', 'recovery']) {
    assert.ok(tools.get(`lead_worker_${name}`), `registered tool ${name}`);
  }
  const config = { ...service.getConfig(sessionId), bossDirect: true, members: [{
    id: 'worker', name: 'Compat worker', provider: 'offline', model: 'fixture',
    role: 'compatibility validation', instructions: 'COMPAT_MEMBER_INSTRUCTIONS', enabled: true, readOnly: true,
  }] };
  await service.handleAction(sessionId, 'configure', { config });
  const board = service.getOrCreateBoard(sessionId);
  board.plan([{ id: 'success', title: 'Offline validation', instructions: 'Inspect only', acceptance: 'return text', memberId: 'worker', readOnly: true }]);
  board.approve('user');
  const exec = { agent: parent, signal: new AbortController().signal };
  const result = await service.dispatchTask(sessionId, 'success', exec);
  assert.equal(result.status, 'review');
  assert.equal(board.snapshot().tasks[0].status, 'review', 'never auto-accept');
  const request = requests[0];
  assert.deepEqual(request.agentOptions, { provider: 'offline', model: 'fixture' });
  assert.equal(request.parent, parent);
  assert.ok(request.persona === 'COMPAT_MEMBER_INSTRUCTIONS'
    || request.prompt.some(part => part.text?.includes('COMPAT_MEMBER_INSTRUCTIONS')));
  const dispatch = board.snapshot().tasks[0].evidence.dispatch;
  assert.equal(dispatch.childId, 'compat-child-1');
  assert.equal(dispatch.childMode, managed ? 'unknown' : 'one-shot');
  assert.equal(notices.length, 1, 'only the board sends a review notice');
  assert.equal(notices[0].source.kind, 'subagent-settled');
  assert.ok(notices[0].id, 'real createUserMessage supplies the message identity');
  assert.equal(disposed, 1, 'execution resources released');
  const { assembleContextFor } = await loadHostModule('@deepseek-ai/dsh-agent');
  const assemblyContext = typeof assembleContextFor === 'function'
    ? assembleContextFor(parent) : { session: parent.session, agent: parent };
  const assembly = await ctx.get('systemPrompt').assemble(assemblyContext);
  assert.ok(assembly.sections.some(section => section.name === 'lead-worker-coordination'));
  const status = await tools.execute({ callId: 'compat-status', name: 'lead_worker_status', arguments: {}, agent: parent, signal: exec.signal });
  assert.equal(status.isError, false, JSON.stringify(status));
  assert.equal(status.value.tasks[0].status, 'review');

  // Exercise real signal propagation and teardown through the host runtime.
  mode = 'deferred';
  board.appendTasks([{ id: 'cancel', title: 'Cancel validation', instructions: 'Wait', acceptance: 'stop on cancellation', memberId: 'worker', readOnly: true }]);
  board.approve('user');
  const controller = new AbortController();
  const pending = service.dispatchTask(sessionId, 'cancel', { agent: parent, signal: controller.signal });
  for (let attempts = 0; requests.length < 2 && attempts < 100; attempts++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(requests.length, 2, 'second execution started');
  controller.abort(new Error('compatibility cancellation'));
  await pending;
  assert.equal(board.snapshot().tasks.find(task => task.id === 'cancel').status, 'needs_attention');
  assert.equal(disposed, 2);
  assert.equal(notices.length, 1, 'cancelled execution must not request review');
  assert.equal(createUserMessage({ content: [], source: { kind: 'user' } }).role, 'user');
  console.log(`Host compatibility smoke passed (${managed ? 'startActivation' : 'start'}): HTTP, tools, prompt, dispatch, review notice, cancellation, teardown`);
} finally {
  complete?.({ stopReason: 'aborted', output: [] });
  for (const fiber of fibers.reverse()) await fiber.dispose();
  rmSync(profile, { recursive: true, force: true });
}
