import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorker } from '../src/subagent-compat.mjs';

function request(signal = new AbortController().signal) {
  return { label: 'worker task', signal, persona: 'member instructions',
    prompt: [{ type: 'text', text: 'task body' }], parent: { id: 'parent' },
    agentOptions: { provider: 'offline', model: 'test' } };
}

test('legacy start receives the original role, signal, and model route unchanged', async () => {
  const input = request();
  const handle = { id: 'old-child' };
  const run = await startWorker({ start(provider, task) {
    assert.equal(provider, 'spawn'); assert.equal(task, input); return handle;
  } }, input);
  assert.equal(run, handle);
});

test('managed activation preserves instructions and route, owns one review notice and discovers the real child', async () => {
  const input = request();
  const child = { options: input.agentOptions };
  let disposals = 0;
  const result = Promise.resolve({ stopReason: 'completed', output: [] });
  const run = await startWorker({ async startActivation(spec) {
    assert.deepEqual(Object.keys(spec).sort(), ['delivery', 'label', 'provider', 'request', 'signal']);
    assert.equal(spec.delivery, 'caller');
    assert.equal(spec.provider, 'spawn');
    assert.equal(spec.signal, input.signal);
    assert.equal(spec.request.parent, input.parent);
    assert.equal(spec.request.agentOptions, input.agentOptions);
    assert.equal(spec.request.persona, undefined);
    assert.equal(spec.request.signal, undefined);
    assert.match(spec.request.prompt[0].text, /member instructions/);
    assert.equal(spec.request.prompt[1], input.prompt[0]);
    return { childId: 'managed-child', result, dispose() { disposals++; } };
  } }, input, { get(id) { assert.equal(id, 'managed-child'); return child; } });
  assert.equal(run.id, 'managed-child');
  assert.equal(run.childMode, 'unknown');
  assert.equal(run.localAgent, child);
  assert.equal(run.result, result);
  assert.equal(input.prompt.length, 1, 'caller data remains unchanged');
  await run.dispose(); await run.dispose();
  assert.equal(disposals, 1);
});

test('abort after publication disposes the exact activation and retains teardown failures', async () => {
  const controller = new AbortController();
  const failure = new Error('teardown failed');
  let disposals = 0;
  const run = await startWorker({ async startActivation() {
    return { childId: 'child', result: Promise.resolve({}), dispose() { disposals++; throw failure; } };
  } }, request(controller.signal));
  controller.abort();
  await assert.rejects(run.dispose(), error => error === failure);
  assert.equal(disposals, 1);
});

test('cancellation during publication is forwarded and normal disposal removes the listener', async () => {
  const controller = new AbortController();
  let disposals = 0;
  const run = await startWorker({ async startActivation() {
    controller.abort();
    return { childId: 'child', result: Promise.resolve({}), dispose() { disposals++; } };
  } }, request(controller.signal));
  await run.dispose();
  assert.equal(disposals, 1);
  const secondController = new AbortController();
  const second = await startWorker({ async startActivation() {
    return { childId: 'other', result: Promise.resolve({}), dispose() { disposals++; } };
  } }, request(secondController.signal));
  await second.dispose();
  secondController.abort();
  assert.equal(disposals, 2);
});

test('activation rejection never falls back to a second start, unsupported hosts fail explicitly', async () => {
  let starts = 0;
  await assert.rejects(startWorker({
    async startActivation() { throw new Error('activation rejected'); },
    start() { starts++; },
  }, request()), /activation rejected/);
  assert.equal(starts, 0);
  await assert.rejects(startWorker({}, request()), /startActivation \/ start/);
});
