import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const calls = [];
const window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      const moduleExports = factory((name) => {
        if (name === 'react') return { Fragment: 'Fragment', createElement: (...args) => ({ args }), useState: () => [null, () => {}], useEffect: () => {}, useCallback: fn => fn };
        if (name === '@deepseek-ai/dsh-client-ui-slots') return {};
        throw new Error(`unexpected module: ${name}`);
      });
      calls.push({ id, exports: moduleExports });
    }
  }
};
const document = {
  getElementById: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild() {} },
};
vm.runInNewContext(source, { window, document, React: undefined, fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }), localStorage: { getItem: () => null, setItem() {} }, setInterval: () => 0, clearInterval() {}, setTimeout() {}, encodeURIComponent, URL });
assert.equal(calls.length, 1);
assert.equal(calls[0].id, 'dsh-lead-worker');
assert.deepEqual(Array.from(calls[0].exports.inject), ['slots']);
assert.equal(source.includes('askUserQuestion('), false, 'client must not call an undefined question API');
const registrations = [];
calls[0].exports.apply({ slots: { inject: (_name, register) => register(), register: (spec, component) => { registrations.push(spec); assert.equal(typeof component, 'function'); } } });
assert.equal(registrations.length, 4);
assert.ok(registrations.some(r => r.id === 'lead-worker-autopilot-input' && r.order === 11));
assert.ok(registrations.some(r => r.id === 'lead-worker-boss-direct-input' && r.order === 10));
assert.ok(registrations.some(r => r.name === 'conversation.input.right'));
assert.equal(typeof calls[0].exports.apply, 'function');
console.log('Client bundle simulation passed');
