// Use official SlotCore and the installed Conversation's published declarations.
// Rendering still uses the existing VM simulation; this checks the real slot
// contracts rather than accepting every key like that simulation does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { loadHostModule } from '../src/host-runtime.mjs';

const { SlotCore } = await loadHostModule('@deepseek-ai/dsh-client-ui-slots');
const requireHost = createRequire(process.argv[2]);
const conversation = requireHost.resolve('@deepseek-ai/dsh-client-ui-conversation');
const contract = readFileSync(join(dirname(conversation), 'types/client/contract/slots.d.ts'), 'utf8');
const declared = {};
for (const key of ['conversation.session.header.actions', 'conversation.hero.modeActions', 'conversation.hero.options', 'conversation.input.right']) {
  const escaped = key.replaceAll('.', '\\.');
  const match = contract.match(new RegExp(`['"]${escaped}['"]:\\s*\\{\\s*kind:\\s*['"]([^'"]+)['"];\\s*scope:\\s*['"]([^'"]+)['"]`));
  if (match) declared[key] = { kind: match[1], scope: match[2] };
}
assert.ok(declared['conversation.session.header.actions']);
assert.ok(declared['conversation.input.right']);
const core = new SlotCore();
const disposeOwner = core.register({ name: 'root', children: declared }, () => null);
const disposers = [];
let client;
vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load({ factory }) {
    client = factory(name => name === 'react' ? { createElement() {} } : {});
  } } },
});
client.apply({ slots: {
  inject(key, callback) { if (declared[key]) disposers.push(callback()); },
  register: (options, component) => core.register(options, component),
} });
const header = core.entries('conversation.session.header.actions');
const input = core.entries('conversation.input.right');
assert.equal(header.length, 1);
assert.equal(input.length, 2);
assert.deepEqual(input.map(entry => entry.options.id), ['lead-worker-boss-direct-input', 'lead-worker-autopilot-input']);
if (declared['conversation.hero.options']) assert.equal(core.entries('conversation.hero.options').length, 1);
for (const entry of [...header, ...input]) assert.equal(entry.inject('parent').sessionId, 'parent');
for (const dispose of disposers.reverse()) dispose();
assert.equal(core.entries('conversation.input.right').length, 0);
disposeOwner();
console.log(`Client host compatibility smoke passed: ${Object.keys(declared).join(', ')}`);
