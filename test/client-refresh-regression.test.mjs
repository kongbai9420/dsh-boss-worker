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
  assert.equal(payload.config.bossDirect, false); assert.equal(payload.config.leadPrompt, 'keep latest'); assert.equal(payload.expectedConfigRevision, 'r-latest');
  h.respond(1, { ok: true }); await result; assert.equal(success, false);
});

test('autopilot click flips latest config and optimistic fallback preserves latest fields', async () => {
  const h = harness(), props = { sessionId: 'A' };
  h.render(h.api.AutopilotInputSwitch, props); h.fire(0); h.respond(0, view({ autopilot: false, leadPrompt: 'old' })); await h.flush();
  const button = h.render(h.api.AutopilotInputSwitch, props);
  const clicked = button.props.onClick({ preventDefault() {}, stopPropagation() {} });
  h.respond(1, view({ autopilot: true, leadPrompt: 'latest' })); await h.flush();
  const payload = JSON.parse(h.requests[2].options.body);
  assert.equal(payload.config.autopilot, false); assert.equal(payload.config.leadPrompt, 'latest');
  h.respond(2, { ok: true }); await clicked;
  h.respond(3, view(payload.config)); await h.flush();
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
  const latest = view({ leadPrompt: 'external update', autopilot: false, members: [] });
  h.render(h.api.LeadWorkerDialog, { ...props, monitor: { sessionId: 'A', data: latest } });
  assert.equal(h.states[2].leadPrompt, 'external update'); assert.equal(h.states[2].autopilot, false);
  assert.equal(h.states[8].current.leadPrompt, 'external update');
  assert.equal(h.api.viewStreams.get('A').queuedRefresh, true, 'reopen refresh queues behind old GET');
  h.respond(0, old); await h.flush(); assert.equal(h.requests.length, 2);
  h.respond(1, latest); await h.flush();
});
