import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Pure client VM: no backend, APPDATA, real timers, network or disk writes.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function harness() {
  let api, cursor = 0;
  const states = [], slots = [], effects = [], requests = [], timers = new Map();
  let timerId = 0;
  const React = {
    Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
    useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
    useCallback: fn => fn,
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, j) => value !== old.deps[j])) effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  const document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const window = { __ModuleLoader__: { load(spec) { api = spec.factory(name => name === 'react' ? React : {}).testing; } } };
  vm.runInNewContext(source.replace('exports.apply = apply;', 'exports.testing = { subscribeView, viewStreams, toggleBossDirectQuick, AutopilotInputSwitch, LeadWorkerDialog }; exports.apply = apply;'), {
    React, window, document, AbortController, localStorage: { getItem: () => null },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    setInterval() { throw Error('unexpected unmonitored polling'); }, clearInterval() {},
    fetch(url, options) { assert.match(url, /^\/api\/lead-worker\/(view\?sessionId=|action$)/); return new Promise(resolve => requests.push({ url, options, resolve })); },
  });
  return { api, states, requests, timers, document,
    render(component, props) { cursor = 0; const tree = component(props); effects.splice(0).forEach(fn => fn()); return tree; },
    fire(ms) { const item = [...timers].find(([, timer]) => timer.ms === ms); assert.ok(item); timers.delete(item[0]); item[1].fn(); },
    respond(i, data) { requests[i].resolve({ ok: true, json: async () => data }); },
    async flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); },
  };
}
const view = config => ({ ok: true, sessionId: 'A', configRevision: 'r-latest', config, board: { tasks: [] }, models: [] });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
const button = (tree, text) => {
  const found = nodes(tree).find(node => node.type === 'button' && node.children.some(child => typeof child === 'string' && child.includes(text)));
  assert.ok(found, `button: ${text}`);
  return found;
};
const memberInputs = tree => nodes(tree).filter(node => node.type === 'input' && node.props.placeholder === '成员名称，如 Sol (实现工程师)');
const formal = { id: 'worker-copy', name: 'formal copy', provider: 'p', model: 'm', enabled: true };
const route = { ...formal, id: 'task-route-A-t', name: 'internal route' };
const settings = () => ({ leadPrompt: 'original', bossDirect: false, autopilot: false, members: [{ ...formal }, { ...route }] });
function openSettings(h, config = settings()) {
  let props = { sessionId: 'A', isOpen: true, themeMode: 'light', monitor: { sessionId: 'A', data: view(config) }, onClose() {} };
  const render = () => h.render(h.api.LeadWorkerDialog, props);
  render();
  button(render(), '子模型团队与调度').props.onClick();
  assert.deepEqual(memberInputs(render()).map(node => node.props.value), ['formal copy']);
  return {
    render,
    edit(name) { memberInputs(render())[0].props.onChange({ target: { value: name } }); },
    save() { return button(render(), '保存配置').props.onClick(); },
    refresh(config) { props = { ...props, monitor: { sessionId: 'A', data: view(config) } }; render(); return render(); },
  };
}

test('settings save with routes edits a real -copy member and keeps routes out after response and refresh', async () => {
  const h = harness(), original = settings(), ui = openSettings(h, original);
  ui.edit('edited copy');
  const latest = { ...settings(), leadPrompt: 'external unrelated edit', members: [{ ...formal }, { ...route, model: 'new route model' }, { ...route, id: 'task-route-A-new' }] };
  const saving = ui.save();
  assert.equal(h.requests.length, 1);
  h.respond(0, view(latest)); await h.flush();
  assert.equal(h.requests.length, 2, 'route presence/change must not cause a false members conflict');
  const payload = JSON.parse(h.requests[1].options.body);
  assert.equal(payload.action, 'configure');
  assert.equal(payload.expectedConfigRevision, 'r-latest');
  assert.deepEqual(payload.config.members, [{ ...formal, name: 'edited copy' }]);
  assert.equal(payload.config.leadPrompt, 'external unrelated edit');
  // The host returns its session view, including preserved routing members.
  const returned = { ...payload.config, members: [...payload.config.members, ...latest.members.slice(1)] };
  h.respond(1, { ok: true, result: { config: returned } }); await saving;
  assert.ok(nodes(ui.render()).some(node => node.children.some(child => typeof child === 'string' && child.includes('设置已保存'))));
  assert.deepEqual(memberInputs(ui.render()).map(node => node.props.value), ['edited copy']);
  assert.deepEqual(memberInputs(ui.refresh(returned)).map(node => node.props.value), ['edited copy']);
  assert.deepEqual(Array.from(h.states[8].current.members, member => member.id), ['worker-copy']);
  assert.equal(original.members.length, 2, 'initial view is not mutated');
  assert.equal(latest.members.length, 3, 'latest task view retains routes');
  assert.equal(returned.members.length, 3, 'returned task view retains routes');
  // A second save uses the new projected baseline, including when no member changed.
  const again = ui.save(); h.respond(2, view(returned)); await h.flush();
  const second = JSON.parse(h.requests[3].options.body);
  assert.deepEqual(second.config.members, payload.config.members);
  h.respond(3, { ok: true, result: { config: returned } }); await again;
});

test('settings save still rejects concurrent changes to a formal member with routes present', async () => {
  const h = harness(), ui = openSettings(h);
  ui.edit('my edit');
  const saving = ui.save();
  h.respond(0, view({ ...settings(), members: [{ ...formal, name: 'external member edit' }, route] }));
  await saving;
  assert.equal(h.requests.length, 1, 'client conflict must prevent the configure POST');
  assert.ok(nodes(ui.render()).some(node => node.children.some(child => typeof child === 'string' && child.includes('配置项 members 已被其他入口更新'))));
  assert.deepEqual(memberInputs(ui.render()).map(node => node.props.value), ['my edit'], 'unsaved draft remains editable');
});

test('settings save retains revision CAS rejection for a mutation after its latest GET', async () => {
  const h = harness(), ui = openSettings(h);
  ui.edit('my edit');
  const saving = ui.save(); h.respond(0, view(settings())); await h.flush();
  assert.equal(h.requests.length, 2);
  assert.equal(JSON.parse(h.requests[1].options.body).expectedConfigRevision, 'r-latest');
  h.respond(1, { ok: false, error: '配置已被其他入口更新，请刷新后重试；未覆盖最新配置' }); await saving;
  assert.ok(nodes(ui.render()).some(node => node.children.some(child => typeof child === 'string' && child.includes('未覆盖最新配置'))));
  assert.deepEqual(memberInputs(ui.render()).map(node => node.props.value), ['my edit']);
  assert.equal(h.states[8].current.members[0].name, 'formal copy', 'failed save does not advance baseline');
});

test('pending refresh queues one post-mutation GET and never emits the pre-mutation result', async () => {
  const h = harness(), seen = [];
  const off = h.api.subscribeView('A', 3000, s => seen.push(s));
  h.fire(0); h.respond(0, view({ autopilot: false })); await h.flush();
  h.fire(3000);
  const stream = h.api.viewStreams.get('A');
  const refreshed = stream.refresh(); stream.refresh();
  h.respond(1, view({ autopilot: false })); await h.flush();
  assert.equal(h.requests.length, 3, 'pending refresh calls coalesce into one fresh GET');
  assert.equal(seen.filter(s => s.data && !s.syncing).length, 1, 'obsolete pending GET is not published');
  h.respond(2, view({ autopilot: true })); await refreshed;
  assert.equal(seen.at(-1).data.config.autopilot, true);
  off(); await h.flush(); assert.equal(h.timers.size, 0);
});

test('queued refresh does not issue another GET after last listener cleanup', async () => {
  const h = harness(), off = h.api.subscribeView('A', 3000, () => {});
  h.fire(0); const stream = h.api.viewStreams.get('A'); stream.refresh();
  off(); await h.flush(); h.respond(0, view({})); await h.flush();
  assert.equal(h.requests.length, 1); assert.equal(h.timers.size, 0); assert.equal(h.api.viewStreams.size, 0);
});

test('BOSS target flips latest config rather than the old rendered value', async () => {
  const h = harness(); let success;
  const result = h.api.toggleBossDirectQuick('A', { bossDirect: false }, value => { success = value; }, err => { throw err; });
  h.respond(0, view({ bossDirect: true, leadPrompt: '【👑 BOSS直派规则】: old\nkeep latest', members: [] })); await h.flush();
  const payload = JSON.parse(h.requests[1].options.body);
  assert.equal(payload.action, 'configureSession'); assert.equal(payload.bossDirect, false); assert.equal(payload.config, undefined); assert.equal(payload.expectedConfigRevision, 'r-latest');
  h.respond(1, { ok: true }); await result; assert.equal(success, false);
});

test('autopilot click flips latest config and optimistic fallback preserves latest fields', async () => {
  const h = harness(), props = { sessionId: 'A' };
  h.render(h.api.AutopilotInputSwitch, props); h.fire(0); h.respond(0, view({ autopilot: false, leadPrompt: 'old' })); await h.flush();
  const button = h.render(h.api.AutopilotInputSwitch, props);
  const clicked = button.props.onClick({ preventDefault() {}, stopPropagation() {} });
  h.respond(1, view({ autopilot: true, leadPrompt: 'latest' })); await h.flush();
  const payload = JSON.parse(h.requests[2].options.body);
  assert.equal(payload.action, 'configureSession'); assert.equal(payload.autopilot, false); assert.equal(payload.config, undefined);
  h.respond(2, { ok: true }); await clicked;
  h.respond(3, view({ autopilot: false, leadPrompt: 'latest' })); await h.flush();
  assert.equal(h.states[0].data.config.autopilot, false); assert.equal(h.states[0].data.config.leadPrompt, 'latest');
});

test('same-session Dialog close/reopen discards baseline and edited autopilot, refreshes on open', async () => {
  const h = harness(); h.api.subscribeView('A', 3000, () => {});
  const old = view({ leadPrompt: 'old', autopilot: false, members: [] });
  const props = { sessionId: 'A', isOpen: true, themeMode: 'light', monitor: { sessionId: 'A', data: old }, onClose() {} };
  h.render(h.api.LeadWorkerDialog, props);
  assert.equal(h.requests.length, 1, 'opening starts refresh');
  h.states[2] = { ...h.states[2], leadPrompt: 'unsaved', autopilot: true };
  h.states[7].current = true;
  h.render(h.api.LeadWorkerDialog, { ...props, isOpen: false });
  assert.equal(h.states[2], null); assert.equal(h.states[7].current, false); assert.equal(h.states[8].current, null);
  const latest = view({ leadPrompt: 'external update', autopilot: false, members: [{ id: 'worker-copy', name: 'formal' }, { id: 'task-route-A-old', name: 'internal' }] });
  h.render(h.api.LeadWorkerDialog, { ...props, monitor: { sessionId: 'A', data: latest } });
  assert.equal(h.states[2].leadPrompt, 'external update'); assert.equal(h.states[2].autopilot, false);
  assert.equal(h.states[8].current.leadPrompt, 'external update');
  assert.deepEqual(Array.from(h.states[2].members, m => m.id), ['worker-copy']);
  assert.deepEqual(Array.from(h.states[8].current.members, m => m.id), ['worker-copy']);
  assert.equal(latest.config.members.length, 2, 'task view retains internal route without mutation');
  assert.equal(h.api.viewStreams.get('A').queuedRefresh, true, 'reopen refresh queues behind old GET');
  h.respond(0, old); await h.flush(); assert.equal(h.requests.length, 2);
  h.respond(1, latest); await h.flush();
});
